//! In-memory app state.
//!
//! Holds the logged-in session, the running timer, and the configured
//! API base URL. Persistence (so the agent survives a restart) is wired
//! through the `tauri-plugin-store` from the React side — Rust treats
//! the store as opaque key-value config it can read on demand.

use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub user_id: String,
    pub organization_id: String,
    pub organization_name: String,
    pub display_name: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunningTimer {
    pub time_entry_id: String,
    pub project_id: Option<String>,
    pub started_at: DateTime<Utc>,
}

/// Production API base baked into shipped builds (.dmg / .exe / .AppImage).
/// Change this to your real API host before release.
const PRODUCTION_API_BASE: &str = "https://api.timepro.app";

/// Resolve the API base URL. The user never enters this — it ships with the
/// binary. Resolution order:
///   1. Runtime env `TIMEPRO_API_URL` — used in local dev (set by the
///      launch command); ignored in normal shipped runs since installers
///      don't carry env vars.
///   2. Compile-time `TIMEPRO_API_URL` — let CI bake a staging/prod URL
///      into the binary (`TIMEPRO_API_URL=… cargo build`).
///   3. `PRODUCTION_API_BASE` — what ships by default.
fn default_api_base() -> String {
    if let Ok(v) = std::env::var("TIMEPRO_API_URL") {
        if !v.is_empty() {
            return v;
        }
    }
    if let Some(v) = option_env!("TIMEPRO_API_URL") {
        if !v.is_empty() {
            return v.to_string();
        }
    }
    PRODUCTION_API_BASE.to_string()
}

#[derive(Debug, Default)]
pub struct AppState {
    inner: RwLock<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    api_base: Option<String>,
    session: Option<Session>,
    timer: Option<RunningTimer>,
    /// How often (seconds) the capture loop snapshots when a timer is running.
    /// MVP: hard-coded; later sourced from `/v1/settings/effective`.
    screenshot_interval_sec: u64,
    last_screenshot_at: Option<DateTime<Utc>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Inner {
                api_base: Some(default_api_base()),
                session: None,
                timer: None,
                // 12 screenshots/hour = one every 300s, matching the team
                // policy shown in Settings. Capture is automatic while a
                // timer runs (see capture::run_capture_loop).
                screenshot_interval_sec: 300,
                last_screenshot_at: None,
            }),
        }
    }

    pub fn api_base(&self) -> Option<String> {
        self.inner.read().api_base.clone()
    }

    pub fn set_api_base(&self, url: String) {
        self.inner.write().api_base = Some(url);
    }

    pub fn session(&self) -> Option<Session> {
        self.inner.read().session.clone()
    }

    pub fn set_session(&self, session: Session) {
        self.inner.write().session = Some(session);
    }

    pub fn clear_session(&self) {
        let mut g = self.inner.write();
        g.session = None;
        g.timer = None;
    }

    pub fn timer(&self) -> Option<RunningTimer> {
        self.inner.read().timer.clone()
    }

    pub fn set_timer(&self, timer: RunningTimer) {
        self.inner.write().timer = Some(timer);
    }

    pub fn clear_timer(&self) {
        self.inner.write().timer = None;
    }

    pub fn screenshot_interval(&self) -> u64 {
        self.inner.read().screenshot_interval_sec
    }

    pub fn last_screenshot_at(&self) -> Option<DateTime<Utc>> {
        self.inner.read().last_screenshot_at
    }

    pub fn record_screenshot(&self, at: DateTime<Utc>) {
        self.inner.write().last_screenshot_at = Some(at);
    }
}
