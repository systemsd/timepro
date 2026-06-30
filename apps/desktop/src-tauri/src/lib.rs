//! TimePro desktop agent — entry point.
//!
//! Wires the Tauri runtime, the plugins, the app state, and the periodic
//! capture loop. Keep this file small; real logic lives in submodules.

mod api;
mod capture;
mod commands;
mod logship;
mod state;

use std::sync::Arc;

use tauri::{async_runtime, Manager};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Shared buffer between the tracing layer (producer) and the shipper (consumer).
    let log_buf = logship::new_buffer();
    init_tracing(log_buf.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Arc::new(AppState::new()))
        .invoke_handler(tauri::generate_handler![
            commands::dev_login,
            commands::opscore_login,
            commands::logout,
            commands::current_session,
            commands::list_projects,
            commands::timer_start,
            commands::timer_stop,
            commands::timer_current,
            commands::take_screenshot_now,
            commands::idle_seconds,
            commands::view_online,
            commands::set_api_base,
            commands::get_api_base,
        ])
        .setup(move |app| {
            // Restore a persisted session so the user isn't asked to sign in on
            // every launch (the session file lives in the app data dir; it's
            // cleared on logout). Also remember the path so later logins persist.
            let boot_state = app.state::<Arc<AppState>>().inner().clone();
            if let Ok(dir) = app.path().app_local_data_dir() {
                let path = dir.join("session.json");
                if let Some(sess) = crate::state::load_session_file(&path) {
                    boot_state.restore_session(sess);
                }
                boot_state.set_session_path(path);
            }

            // Spawn the background capture loop. It is a no-op until a timer
            // starts; we drive it from a single tokio task so we never have
            // racy schedule races between the UI and the loop.
            let state = app.state::<Arc<AppState>>().inner().clone();
            let handle = app.handle().clone();
            async_runtime::spawn(async move {
                capture::run_capture_loop(state, handle).await;
            });

            // Ship buffered diagnostic logs to the server once a session exists.
            // Report the real release version (from tauri.conf), not the Cargo
            // crate version, so logs show which build a user is on.
            let log_state = app.state::<Arc<AppState>>().inner().clone();
            let log_buf = log_buf.clone();
            let app_version = app.package_info().version.to_string();
            async_runtime::spawn(async move {
                logship::run_log_shipper(log_state, log_buf, app_version).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TimePro");
}

fn init_tracing(log_buf: logship::LogBuf) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,timepro_agent_lib=debug"));
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .with(logship::LogShipLayer::new(log_buf))
        .init();
}
