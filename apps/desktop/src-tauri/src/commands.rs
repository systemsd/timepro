//! Tauri commands invoked from the React UI via `invoke('cmd_name', ...)`.
//!
//! Each command returns either a JSON-serializable value or a string error.
//! We deliberately return strings instead of typed enums so the JS side
//! gets readable messages without needing a generated TS error module.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;
use tracing::info;
use uuid::Uuid;

use crate::api::{ApiClient, Project, TimerSnapshot};
use crate::capture::{idle, screenshot};
use crate::state::{AppState, RunningTimer, Session};

type Result<T> = std::result::Result<T, String>;

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn client(state: &Arc<AppState>) -> Result<ApiClient> {
    let base = state.api_base().ok_or_else(|| "api base not configured".to_string())?;
    Ok(ApiClient::new(base, state.session()))
}

// ---- auth / session ----

#[tauri::command]
pub async fn dev_login(state: State<'_, Arc<AppState>>, email: String) -> Result<Session> {
    let api = client(&state)?;
    let resp = api.dev_login(&email).await.map_err(map_err)?;
    let session = Session {
        user_id: resp.user_id,
        organization_id: resp.organization_id,
        organization_name: resp.organization_name,
        display_name: resp.display_name,
        role: resp.role,
    };
    state.set_session(session.clone());
    info!(user = %session.user_id, org = %session.organization_id, "logged in");
    Ok(session)
}

#[tauri::command]
pub fn logout(state: State<'_, Arc<AppState>>) -> Result<()> {
    state.clear_session();
    Ok(())
}

#[tauri::command]
pub fn current_session(state: State<'_, Arc<AppState>>) -> Result<Option<Session>> {
    Ok(state.session())
}

// ---- projects ----

#[tauri::command]
pub async fn list_projects(state: State<'_, Arc<AppState>>) -> Result<Vec<Project>> {
    let api = client(&state)?;
    let resp = api.list_projects().await.map_err(map_err)?;
    Ok(resp.projects)
}

// ---- timer ----

#[derive(Debug, Deserialize)]
pub struct TimerStartArgs {
    pub project_id: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TimerView {
    pub time_entry_id: String,
    pub project_id: Option<String>,
    pub started_at: String,
}

impl From<TimerSnapshot> for TimerView {
    fn from(s: TimerSnapshot) -> Self {
        Self {
            time_entry_id: s.id,
            project_id: s.project_id,
            started_at: s.started_at,
        }
    }
}

#[tauri::command]
pub async fn timer_start(
    state: State<'_, Arc<AppState>>,
    args: TimerStartArgs,
) -> Result<TimerView> {
    let api = client(&state)?;
    let snap = api
        .timer_start(
            args.project_id.as_deref(),
            args.description.as_deref(),
            &Uuid::new_v4().to_string(),
        )
        .await
        .map_err(map_err)?;

    state.set_timer(RunningTimer {
        time_entry_id: snap.id.clone(),
        project_id: snap.project_id.clone(),
        started_at: snap.started_at.parse().unwrap_or_else(|_| chrono::Utc::now()),
    });
    Ok(snap.into())
}

#[tauri::command]
pub async fn timer_stop(state: State<'_, Arc<AppState>>) -> Result<TimerView> {
    let api = client(&state)?;
    let resp = api
        .timer_stop(&Uuid::new_v4().to_string())
        .await
        .map_err(map_err)?;
    state.clear_timer();
    Ok(TimerView {
        time_entry_id: resp.id,
        project_id: resp.project_id,
        started_at: resp.started_at,
    })
}

#[tauri::command]
pub async fn timer_current(state: State<'_, Arc<AppState>>) -> Result<Option<TimerView>> {
    let api = client(&state)?;
    let snap = api.timer_current().await.map_err(map_err)?;
    Ok(snap.map(TimerView::from))
}

// ---- screenshots / idle ----

#[tauri::command]
pub async fn take_screenshot_now(state: State<'_, Arc<AppState>>) -> Result<String> {
    let api = client(&state)?;
    let timer = state.timer();

    let shot = tokio::task::spawn_blocking(screenshot::capture_primary_monitor)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let meta = crate::api::ScreenshotMeta {
        client_event_id: Uuid::new_v4().to_string(),
        captured_at: chrono::Utc::now().to_rfc3339(),
        time_entry_id: timer.as_ref().map(|t| t.time_entry_id.clone()),
        monitor_index: 0,
        width: shot.width,
        height: shot.height,
    };
    let resp = api.upload_screenshot(shot.png, meta).await.map_err(map_err)?;
    state.record_screenshot(chrono::Utc::now());
    Ok(resp.id)
}

#[tauri::command]
pub fn idle_seconds() -> Result<u64> {
    Ok(idle::seconds_idle())
}

/// Mint a one-time handoff code on the server and open the web dashboard in
/// the user's default browser, already logged in. The long-lived session is
/// never placed in the URL — only the single-use exchange code.
#[tauri::command]
pub async fn view_online(state: State<'_, Arc<AppState>>) -> Result<String> {
    let api = client(&state)?;
    let handoff = api.create_handoff().await.map_err(map_err)?;
    open::that(&handoff.url).map_err(|e| format!("failed to open browser: {e}"))?;
    info!(url = %handoff.url, "opened view-online handoff");
    Ok(handoff.url)
}

// ---- config ----

#[tauri::command]
pub fn set_api_base(state: State<'_, Arc<AppState>>, url: String) -> Result<()> {
    state.set_api_base(url);
    Ok(())
}

#[tauri::command]
pub fn get_api_base(state: State<'_, Arc<AppState>>) -> Result<Option<String>> {
    Ok(state.api_base())
}
