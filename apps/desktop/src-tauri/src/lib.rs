//! TimePro desktop agent — entry point.
//!
//! Wires the Tauri runtime, the plugins, the app state, and the periodic
//! capture loop. Keep this file small; real logic lives in submodules.

mod api;
mod capture;
mod commands;
mod state;

use std::sync::Arc;

use tauri::{async_runtime, Manager};
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
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
        .setup(|app| {
            // Spawn the background capture loop. It is a no-op until a timer
            // starts; we drive it from a single tokio task so we never have
            // racy schedule races between the UI and the loop.
            let state = app.state::<Arc<AppState>>().inner().clone();
            let handle = app.handle().clone();
            async_runtime::spawn(async move {
                capture::run_capture_loop(state, handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TimePro");
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,timepro_agent_lib=debug"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}
