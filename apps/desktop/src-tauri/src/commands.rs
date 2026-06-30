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

use crate::api::{ApiClient, ApiError, Project, TimerSnapshot};
use crate::capture::{idle, screenshot};
use crate::state::{AppState, RunningTimer, Session};

type Result<T> = std::result::Result<T, String>;

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Turn a timer-start failure into a user-facing message. The API returns
/// 409 `weekly_limit_reached` when the user is at/over their weekly cap.
fn map_start_err(e: ApiError) -> String {
    if let ApiError::Server { status: 409, body } = &e {
        if body.contains("weekly_limit_reached") {
            return "You've reached your weekly time limit — tracking is blocked until next week.".to_string();
        }
    }
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

/// Sign in via OpsCore from the desktop agent (Phase 3 — desktop).
///
/// Loopback flow — the agent never relies on a fixed redirect it can't see:
///   1. bind a localhost server on a random port,
///   2. open the system browser at the web `/desktop-auth` bridge (carrying the
///      port + a one-time `state` nonce),
///   3. the browser runs the OpsCore handoff and lands the token on our
///      loopback `/callback`,
///   4. exchange the token for a TimePro device session.
#[tauri::command]
pub async fn opscore_login(state: State<'_, Arc<AppState>>) -> Result<Session> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("failed to start loopback server: {e}"))?;
    let port = listener.local_addr().map_err(map_err)?.port();
    let nonce = Uuid::new_v4().to_string();

    let url = format!(
        "{}/desktop-auth?port={}&state={}",
        state.web_base().trim_end_matches('/'),
        port,
        nonce
    );
    open::that(&url).map_err(|e| format!("failed to open browser: {e}"))?;
    info!(%port, "waiting for OpsCore loopback callback");

    let token = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        await_loopback_token(listener, &nonce),
    )
    .await
    .map_err(|_| "timed out waiting for OpsCore sign-in".to_string())??;

    let api = client(&state)?;
    let exchange_started = std::time::Instant::now();
    let resp = api.opscore_exchange(&token).await.map_err(map_err)?;
    let exchange_ms = exchange_started.elapsed().as_millis() as u64;
    let session = Session {
        user_id: resp.user_id,
        organization_id: resp.organization_id,
        organization_name: resp.organization_name,
        display_name: resp.display_name,
        role: resp.role,
    };
    state.set_session(session.clone());
    info!(user = %session.user_id, org = %session.organization_id, exchange_ms, "opscore login");
    Ok(session)
}

/// Accept connections until one hits `/callback` with the expected `state`,
/// returning the captured token. Other paths (favicon, etc.) get a 404.
async fn await_loopback_token(
    listener: tokio::net::TcpListener,
    expected_state: &str,
) -> Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    loop {
        let (mut socket, _) = listener.accept().await.map_err(map_err)?;
        let mut buf = [0u8; 8192];
        let n = socket.read(&mut buf).await.map_err(map_err)?;
        let req = String::from_utf8_lossy(&buf[..n]);
        let path = req
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("");

        if !path.starts_with("/callback") {
            let _ = socket
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
            continue;
        }

        let query = path.split('?').nth(1).unwrap_or("");
        let mut token: Option<String> = None;
        let mut got_state: Option<String> = None;
        for pair in query.split('&') {
            let mut it = pair.splitn(2, '=');
            match (it.next(), it.next()) {
                (Some("token"), Some(v)) => token = Some(percent_decode(v)),
                (Some("state"), Some(v)) => got_state = Some(percent_decode(v)),
                _ => {}
            }
        }

        let ok = matches!((&token, &got_state), (Some(_), Some(s)) if s == expected_state);
        let body = if ok {
            "<h2>Signed in to TimePro</h2><p>You can close this tab and return to the app.</p>"
        } else {
            "<h2>Sign-in failed</h2><p>Invalid or expired request. Try again from the app.</p>"
        };
        let html = format!(
            "<!doctype html><html><body style=\"font-family:system-ui;text-align:center;padding-top:64px;color:#2f2f2f\">{body}</body></html>"
        );
        let resp = format!(
            "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            if ok { "200 OK" } else { "400 Bad Request" },
            html.len(),
            html
        );
        let _ = socket.write_all(resp.as_bytes()).await;
        let _ = socket.flush().await;

        if ok {
            return Ok(token.unwrap());
        }
        return Err("invalid or expired OpsCore callback".to_string());
    }
}

/// Minimal percent-decoder for query values (`%XX` + `+`→space).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
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
        .map_err(map_start_err)?;

    state.set_timer(RunningTimer {
        time_entry_id: snap.id.clone(),
        project_id: snap.project_id.clone(),
        description: args.description.clone(),
        started_at: snap.started_at.parse().unwrap_or_else(|_| chrono::Utc::now()),
    });
    info!(time_entry_id = %snap.id, project = ?snap.project_id, "timer started");
    Ok(snap.into())
}

#[tauri::command]
pub async fn timer_stop(state: State<'_, Arc<AppState>>) -> Result<TimerView> {
    let api = client(&state)?;
    let resp = api
        // Manual stop → no back-date; the server stamps "now".
        .timer_stop(&Uuid::new_v4().to_string(), None)
        .await
        .map_err(map_err)?;
    state.clear_timer();
    state.clear_paused(); // manual stop → don't auto-resume
    info!(time_entry_id = %resp.id, "timer stopped");
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
