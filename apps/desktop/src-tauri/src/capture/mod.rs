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

use std::{sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::api::{ApiClient, ScreenshotMeta};
use crate::capture::activity::ActivityAggregator;
use crate::state::AppState;

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

    loop {
        tokio::time::sleep(tick).await;

        let Some(session) = state.session() else { continue };
        let Some(api_base) = state.api_base() else { continue };

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
            // timer stopped — flush any open app interval
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

        // Auto-pause: stop tracking once the user has been idle past the
        // configured threshold (`tracking.auto_pause_minutes`; 0 = disabled).
        let auto_pause = state.auto_pause_sec();
        if auto_pause > 0 && idle_secs >= auto_pause {
            let client = ApiClient::new(api_base.clone(), Some(session.clone()));
            if client.timer_stop(&Uuid::new_v4().to_string()).await.is_ok() {
                state.clear_timer();
                // flush any open app interval before stopping
                if let Some((name, title, started)) = current_app.take() {
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
                let _ = app.emit("timer:auto-paused", idle_secs);
                info!(idle_secs, "auto-paused tracking (idle threshold reached)");
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

        // Capture off the async runtime — `xcap` is blocking + uses OS APIs.
        let capture_result = tokio::task::spawn_blocking(screenshot::capture_primary_monitor)
            .await
            .unwrap_or_else(|join_err| Err(anyhow::anyhow!("capture task panicked: {join_err}")));

        let (bytes, width, height) = match capture_result {
            Ok(s) => (s.png, s.width, s.height),
            Err(err) => {
                warn!(error = ?err, "screenshot capture failed");
                continue;
            }
        };

        // Apply the `screenshots.blur = always` policy before upload (CPU work
        // off the async runtime). Falls back to the original on blur failure.
        let bytes = if state.blur_always() {
            match tokio::task::spawn_blocking(move || screenshot::blur_png_or_original(bytes)).await {
                Ok(b) => b,
                Err(err) => {
                    warn!(error = ?err, "blur task panicked; skipping this capture");
                    continue;
                }
            }
        } else {
            bytes
        };

        let meta = ScreenshotMeta {
            client_event_id: Uuid::new_v4().to_string(),
            captured_at: now.to_rfc3339(),
            time_entry_id: Some(timer.time_entry_id.clone()),
            monitor_index: 0,
            width,
            height,
        };

        let client = ApiClient::new(api_base, Some(session));
        match client.upload_screenshot(bytes, meta).await {
            Ok(resp) => {
                info!(id = %resp.id, bytes = resp.bytes, "screenshot uploaded");
                state.record_screenshot(now);
                // Notify the UI so it can refresh the "last screenshot" widget.
                let _ = app.emit("screenshot:uploaded", &resp);
                // Native OS toast, gated by the `screenshots.notify` setting (C-policy).
                if state.notify_on_screenshot() {
                    let _ = app
                        .notification()
                        .builder()
                        .title("TimePro")
                        .body("Screenshot captured")
                        .show();
                }
            }
            Err(err) => {
                warn!(error = ?err, "screenshot upload failed; will retry next tick");
            }
        }

        debug!("capture tick complete");
    }
}
