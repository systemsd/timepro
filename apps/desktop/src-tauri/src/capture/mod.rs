//! Capture services: screenshots and idle detection.
//!
//! Cross-platform thanks to `xcap` (capture) and `user-idle` (idle). The
//! real per-OS optimizations from doc 04 (ScreenCaptureKit on mac, DXGI
//! on win, xdg-portal on Wayland) come later — for the MVP we use the
//! portable crates that work everywhere with one code path.

pub mod idle;
pub mod screenshot;

use std::{sync::Arc, time::Duration};

use chrono::Utc;
use tauri::{AppHandle, Emitter};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::api::{ApiClient, ScreenshotMeta};
use crate::state::AppState;

/// Background loop: when a timer is running, capture a screenshot every
/// `state.screenshot_interval()` seconds and upload it to the API.
///
/// MVP keeps this single-task and deterministic. Phase 2 swaps in the
/// Poisson scheduler from doc 04 (§3.5).
pub async fn run_capture_loop(state: Arc<AppState>, app: AppHandle) {
    let tick = Duration::from_secs(5); // wake every 5s and check the schedule

    loop {
        tokio::time::sleep(tick).await;

        // Cheap reads to decide whether to do anything this tick.
        let Some(timer) = state.timer() else { continue };
        let Some(session) = state.session() else { continue };
        let Some(api_base) = state.api_base() else { continue };

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
            }
            Err(err) => {
                warn!(error = ?err, "screenshot upload failed; will retry next tick");
            }
        }

        debug!("capture tick complete");
    }
}
