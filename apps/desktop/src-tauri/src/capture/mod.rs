//! Capture services: screenshots and idle detection.
//!
//! Cross-platform thanks to `xcap` (capture) and `user-idle` (idle). The
//! real per-OS optimizations from doc 04 (ScreenCaptureKit on mac, DXGI
//! on win, xdg-portal on Wayland) come later — for the MVP we use the
//! portable crates that work everywhere with one code path.

pub mod activity;
pub mod apps;
pub mod idle;
pub mod screenshot;

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use chrono::{DateTime, Utc};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::api::{ApiClient, ApiError, ScreenshotMeta};
use crate::capture::activity::ActivityAggregator;
use crate::state::{AppState, PausedTimer, RunningTimer};

/// Background loop: when a timer is running, capture a screenshot every
/// `state.screenshot_interval()` seconds and upload it to the API.
///
/// MVP keeps this single-task and deterministic. Phase 2 swaps in the
/// Poisson scheduler from doc 04 (§3.5).
pub async fn run_capture_loop(state: Arc<AppState>, app: AppHandle) {
    let tick = Duration::from_secs(5); // wake every 5s and check the schedule
    let mut last_heartbeat: Option<DateTime<Utc>> = None;
    let mut activity = ActivityAggregator::new();
    // (app_name, window_title, started_at) for the current app interval.
    let mut current_app: Option<(String, Option<String>, DateTime<Utc>)> = None;
    let mut last_logged_interval: u64 = 0; // for the "cadence changed" diagnostic
    // Diagnostics: detect a stalled/slow loop and periodically report capture
    // health, so a manager can see *why* screenshots aren't landing (capture
    // hang, slow upload, throttling, disabled) — not just successes.
    let mut last_loop_start = Utc::now();
    let mut last_status_at: Option<DateTime<Utc>> = None;
    // Shared so the off-loop upload tasks can bump it without blocking the loop.
    let uploads_session = Arc::new(AtomicU64::new(0));

    // A wall-clock gap this much larger than `tick` across the sleep means the
    // machine was suspended (lid closed / slept) — no input was possible in
    // that window, so a running timer must be stopped back-dated rather than
    // billing the whole sleep.
    const SUSPEND_GAP_SECS: i64 = 60;

    // Once tracking idle-pauses, resume automatically as soon as input returns
    // (idle this low = the user is active again). The 5s tick bounds the latency.
    const RESUME_IDLE_SECS: u64 = 10;

    loop {
        // If the previous iteration took far longer than `tick`, the loop was
        // blocked (a slow/hung await — capture or upload) or the OS throttled us
        // (App Nap / background). Either way it delays screenshots; surface it.
        let loop_start = Utc::now();
        let since_last = (loop_start - last_loop_start).num_seconds();
        if since_last >= 15 && since_last < SUSPEND_GAP_SECS {
            warn!(
                since_last_sec = since_last,
                "capture loop slow — previous iteration ran long (blocked await or system throttling)"
            );
        }
        last_loop_start = loop_start;

        let before_sleep = Utc::now();
        tokio::time::sleep(tick).await;
        let suspend_gap = (Utc::now() - before_sleep).num_seconds();

        let Some(session) = state.session() else { continue };
        let Some(api_base) = state.api_base() else { continue };

        // Suspend recovery: we just woke from sleep with a timer running → stop
        // it back-dated to just before the machine slept, so the away window is
        // never billed. The user resumes manually (no auto-restart); the UI is
        // notified via `timer:auto-paused` (same as the idle path below).
        if suspend_gap >= SUSPEND_GAP_SECS {
            if let Some(timer) = state.timer() {
                let client = ApiClient::new(api_base.clone(), Some(session.clone()));
                let ended_at = before_sleep.to_rfc3339();
                if client
                    .timer_stop(&Uuid::new_v4().to_string(), Some(&ended_at))
                    .await
                    .is_ok()
                {
                    state.clear_timer();
                    if let Some((name, title, started)) = current_app.take() {
                        let _ = client
                            .ingest_app_usage(
                                &name,
                                title.as_deref(),
                                &started.to_rfc3339(),
                                &ended_at,
                                Some(timer.time_entry_id.clone()),
                            )
                            .await;
                    }
                    let _ = app.emit(
                        "timer:auto-paused",
                        serde_json::json!({ "reason": "suspended", "seconds": suspend_gap }),
                    );
                    info!(suspend_gap, "stopped tracking — resumed from sleep (back-dated)");
                }
            }
            continue;
        }

        // Heartbeat ~every 45s so the web shows this user online (B3).
        // `is_tracking` = a timer is running → solid-green; else → connected.
        let hb_due = match last_heartbeat {
            None => true,
            Some(t) => (Utc::now() - t).num_seconds() >= 45,
        };
        if hb_due {
            let client = ApiClient::new(api_base.clone(), Some(session.clone()));
            let _ = client.heartbeat(state.timer().is_some()).await;
            last_heartbeat = Some(Utc::now());
        }

        // Refresh effective settings ~every 60s (independent of the timer) so
        // admin changes to screenshots.per_hour / enabled propagate.
        let refresh_due = match state.last_settings_fetch() {
            None => true,
            Some(last) => (Utc::now() - last).num_seconds() >= 60,
        };
        if refresh_due {
            let client = ApiClient::new(api_base.clone(), Some(session.clone()));
            if let Ok(map) = client.get_effective_settings().await {
                state.apply_effective(&map);
                debug!("effective settings refreshed");
                // Surface the resolved screenshot cadence at INFO when it changes,
                // so a manager can see the expected interval (vs what actually
                // landed) without server access.
                let iv = state.screenshot_interval();
                if iv != last_logged_interval {
                    info!(
                        interval_sec = iv,
                        per_hour = if iv > 0 { 3600 / iv } else { 0 },
                        enabled = state.screenshots_enabled(),
                        "screenshot cadence updated"
                    );
                    last_logged_interval = iv;
                }
            }
            state.record_settings_fetch(Utc::now());
        }

        // Cheap reads to decide whether to capture this tick.
        let Some(timer) = state.timer() else {
            // Auto-resume: if we idle-paused and the user is active again, start a
            // fresh entry with the same project/description automatically — no need
            // to click play. The idle gap stays unbilled (the pause back-dated the
            // stop to when input ceased).
            if let Some(p) = state.paused() {
                if idle::seconds_idle() < RESUME_IDLE_SECS {
                    let client = ApiClient::new(api_base.clone(), Some(session.clone()));
                    match client
                        .timer_start(
                            p.project_id.as_deref(),
                            p.task_id.as_deref(),
                            p.description.as_deref(),
                            &Uuid::new_v4().to_string(),
                        )
                        .await
                    {
                        Ok(snap) => {
                            state.set_timer(RunningTimer {
                                time_entry_id: snap.id.clone(),
                                project_id: snap.project_id.clone(),
                                task_id: p.task_id.clone(),
                                description: p.description.clone(),
                                started_at: snap.started_at.parse().unwrap_or_else(|_| Utc::now()),
                            });
                            let _ = app.emit(
                                "timer:auto-resumed",
                                serde_json::json!({
                                    "time_entry_id": snap.id,
                                    "project_id": snap.project_id,
                                    "started_at": snap.started_at,
                                }),
                            );
                            info!(time_entry_id = %snap.id, "auto-resumed tracking (activity detected)");
                        }
                        // Weekly cap (or any hard 409) → stop retrying; otherwise keep
                        // the paused context and try again on the next tick.
                        Err(err) => {
                            if matches!(&err, ApiError::Server { status: 409, .. }) {
                                state.clear_paused();
                            }
                            warn!(error = %err, "auto-resume failed");
                        }
                    }
                }
                continue;
            }
            // No paused context → genuinely stopped: flush any open app interval.
            if let Some((name, title, started)) = current_app.take() {
                let now = Utc::now();
                let client = ApiClient::new(api_base.clone(), Some(session.clone()));
                let _ = client
                    .ingest_app_usage(&name, title.as_deref(), &started.to_rfc3339(), &now.to_rfc3339(), None)
                    .await;
            }
            continue;
        };

        let entry_id = timer.time_entry_id.clone();
        let now_ev = Utc::now();
        let idle_secs = idle::seconds_idle();

        // Periodic capture-health heartbeat while tracking (~every 2.5 min). Shows
        // the loop is alive and *why* shots may not be landing: whether captures
        // are enabled, the expected interval, and how long since the last upload.
        let status_due = match last_status_at {
            None => true,
            Some(t) => (now_ev - t).num_seconds() >= 150,
        };
        if status_due {
            let secs_since_shot = state
                .last_screenshot_at()
                .map(|t| (now_ev - t).num_seconds())
                .unwrap_or(-1);
            info!(
                screenshots_enabled = state.screenshots_enabled(),
                interval_sec = state.screenshot_interval(),
                secs_since_last_screenshot = secs_since_shot,
                idle_secs,
                uploads_session = uploads_session.load(Ordering::Relaxed),
                "capture status"
            );
            last_status_at = Some(now_ev);
        }

        // Auto-pause: stop tracking once the user has been idle past the
        // configured threshold (`tracking.auto_pause_minutes`; 0 = disabled).
        let auto_pause = state.auto_pause_sec();
        if auto_pause > 0 && idle_secs >= auto_pause {
            let client = ApiClient::new(api_base.clone(), Some(session.clone()));
            // Back-date the stop to when input actually ceased (now − idle), so
            // the idle window before the threshold tripped isn't billed.
            let ended_at = (now_ev - chrono::Duration::seconds(idle_secs as i64)).to_rfc3339();
            if client
                .timer_stop(&Uuid::new_v4().to_string(), Some(&ended_at))
                .await
                .is_ok()
            {
                // Remember the project/description so we can auto-resume the moment
                // input returns (no manual "play" click).
                state.set_paused(PausedTimer {
                    project_id: timer.project_id.clone(),
                    task_id: timer.task_id.clone(),
                    description: timer.description.clone(),
                });
                state.clear_timer();
                // flush any open app interval, capped at the back-dated end
                if let Some((name, title, started)) = current_app.take() {
                    let _ = client
                        .ingest_app_usage(
                            &name,
                            title.as_deref(),
                            &started.to_rfc3339(),
                            &ended_at,
                            Some(entry_id.clone()),
                        )
                        .await;
                }
                let _ = app.emit(
                    "timer:auto-paused",
                    serde_json::json!({ "reason": "idle", "seconds": idle_secs }),
                );
                info!(idle_secs, "auto-paused tracking (idle threshold reached, back-dated)");
            }
            continue;
        }

        // B4 — activity (idle-derived, per-minute samples).
        if state.activity_tracking_enabled() {
            if let Some(sample) = activity.tick(now_ev, idle_secs, 5) {
                let client = ApiClient::new(api_base.clone(), Some(session.clone()));
                let _ = client.ingest_activity(std::slice::from_ref(&sample), Some(entry_id.clone())).await;
            }
        }

        // B5 — active app intervals (flush on change or every ~60s for per-slot granularity).
        if state.app_url_tracking_enabled() {
            if let Some(app) = apps::active_app() {
                let should_flush = match &current_app {
                    None => false,
                    Some((name, _, started)) => {
                        *name != app.app_name || (now_ev - *started).num_seconds() >= 60
                    }
                };
                if should_flush {
                    if let Some((name, title, started)) = current_app.take() {
                        let client = ApiClient::new(api_base.clone(), Some(session.clone()));
                        let _ = client
                            .ingest_app_usage(
                                &name,
                                title.as_deref(),
                                &started.to_rfc3339(),
                                &now_ev.to_rfc3339(),
                                Some(entry_id.clone()),
                            )
                            .await;
                    }
                }
                if current_app.is_none() {
                    current_app = Some((app.app_name, app.window_title, now_ev));
                }
            }
        }

        if !state.screenshots_enabled() {
            continue; // screenshots disabled by policy
        }

        let interval_sec = state.screenshot_interval();
        let now = Utc::now();
        let due = match state.last_screenshot_at() {
            None => true,
            Some(last) => (now - last).num_seconds() as u64 >= interval_sec,
        };
        if !due {
            continue;
        }

        // Reserve this slot now, then run capture + upload OFF the loop. Uploads
        // can take many seconds on a slow link (we measured ~11s), and awaiting
        // them inline froze the whole loop — heartbeat, idle detection, and the
        // next capture all stalled (the "capture loop slow" warning). Spawning a
        // task keeps the loop responsive; reserving the timestamp up front keeps a
        // steady cadence and prevents a second capture firing while one is mid-upload.
        let secs_since_shot = state
            .last_screenshot_at()
            .map(|t| (now - t).num_seconds())
            .unwrap_or(-1);
        state.record_screenshot(now);

        let task_app = app.clone();
        let task_api = api_base.clone();
        let task_session = session.clone();
        let task_entry = entry_id.clone();
        let task_uploads = uploads_session.clone();
        let blur_always = state.blur_always();
        let notify = state.notify_on_screenshot();
        tokio::spawn(async move {
            // "capturing screenshot" with no following "uploaded"/"failed" pinpoints
            // a hang in capture or upload.
            info!(interval_sec, secs_since_last_screenshot = secs_since_shot, "capturing screenshot");

            // Capture off the async runtime — `xcap` is blocking + uses OS APIs.
            let cap_start = Utc::now();
            let capture_result = tokio::task::spawn_blocking(screenshot::capture_primary_monitor)
                .await
                .unwrap_or_else(|join_err| Err(anyhow::anyhow!("capture task panicked: {join_err}")));
            let capture_ms = (Utc::now() - cap_start).num_milliseconds();

            let (bytes, width, height) = match capture_result {
                Ok(s) => (s.png, s.width, s.height),
                Err(err) => {
                    warn!(error = ?err, capture_ms, "screenshot capture failed");
                    return;
                }
            };

            // Apply the `screenshots.blur = always` policy before upload (CPU work
            // off the async runtime). Falls back to the original on blur failure.
            let bytes = if blur_always {
                match tokio::task::spawn_blocking(move || screenshot::blur_png_or_original(bytes)).await {
                    Ok(b) => b,
                    Err(err) => {
                        warn!(error = ?err, "blur task panicked; skipping this capture");
                        return;
                    }
                }
            } else {
                bytes
            };

            let meta = ScreenshotMeta {
                client_event_id: Uuid::new_v4().to_string(),
                captured_at: now.to_rfc3339(),
                time_entry_id: Some(task_entry),
                monitor_index: 0,
                width,
                height,
            };

            let client = ApiClient::new(task_api, Some(task_session));
            let up_start = Utc::now();
            match client.upload_screenshot(bytes, meta).await {
                Ok(resp) => {
                    let upload_ms = (Utc::now() - up_start).num_milliseconds();
                    let n = task_uploads.fetch_add(1, Ordering::Relaxed) + 1;
                    info!(id = %resp.id, bytes = resp.bytes, capture_ms, upload_ms, uploads_session = n, "screenshot uploaded");
                    // Notify the UI so it can refresh the "last screenshot" widget.
                    let _ = task_app.emit("screenshot:uploaded", &resp);
                    // Native OS toast, gated by the `screenshots.notify` setting (C-policy).
                    if notify {
                        let _ = task_app
                            .notification()
                            .builder()
                            .title("TimePro")
                            .body("Screenshot captured")
                            .show();
                    }
                }
                Err(err) => {
                    let upload_ms = (Utc::now() - up_start).num_milliseconds();
                    warn!(error = ?err, capture_ms, upload_ms, "screenshot upload failed");
                }
            }
        });

        debug!("capture spawned (uploading off-loop)");
    }
}
