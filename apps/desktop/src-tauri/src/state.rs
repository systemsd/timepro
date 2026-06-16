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
const PRODUCTION_API_BASE: &str = "https://api.timepro.systemsd.co";

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

/// Production web base — where the OpsCore login bridge (`/desktop-auth`) lives.
/// Change before release. Same resolution order as the API base.
const PRODUCTION_WEB_BASE: &str = "https://timepro.systemsd.co";

fn default_web_base() -> String {
    if let Ok(v) = std::env::var("TIMEPRO_WEB_URL") {
        if !v.is_empty() {
            return v;
        }
    }
    if let Some(v) = option_env!("TIMEPRO_WEB_URL") {
        if !v.is_empty() {
            return v.to_string();
        }
    }
    PRODUCTION_WEB_BASE.to_string()
}

#[derive(Debug, Default)]
pub struct AppState {
    inner: RwLock<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    api_base: Option<String>,
    web_base: Option<String>,
    session: Option<Session>,
    timer: Option<RunningTimer>,
    /// Capture cadence — resolved from `/v1/settings/effective`
    /// (`screenshots.per_hour`), with a sensible fallback before first fetch.
    screenshot_interval_sec: u64,
    screenshots_enabled: bool,
    notify_on_screenshot: bool,
    activity_tracking: bool,
    app_url_tracking: bool,
    last_screenshot_at: Option<DateTime<Utc>>,
    last_settings_fetch: Option<DateTime<Utc>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Inner {
                api_base: Some(default_api_base()),
                web_base: Some(default_web_base()),
                session: None,
                timer: None,
                screenshot_interval_sec: 300, // fallback until settings load
                screenshots_enabled: true,
                notify_on_screenshot: false,
                activity_tracking: true,
                app_url_tracking: true,
                last_screenshot_at: None,
                last_settings_fetch: None,
            }),
        }
    }

    /// Apply effective settings fetched from the API (`{key: value}` map).
    pub fn apply_effective(&self, m: &serde_json::Map<String, serde_json::Value>) {
        let mut g = self.inner.write();
        if let Some(ph) = m.get("screenshots.per_hour").and_then(|v| v.as_f64()) {
            if ph > 0.0 {
                g.screenshot_interval_sec = (3600.0 / ph).round().max(1.0) as u64;
            }
        }
        if let Some(en) = m.get("screenshots.enabled").and_then(|v| v.as_bool()) {
            g.screenshots_enabled = en;
        }
        if let Some(n) = m.get("screenshots.notify").and_then(|v| v.as_bool()) {
            g.notify_on_screenshot = n;
        }
        if let Some(a) = m.get("activity.tracking").and_then(|v| v.as_bool()) {
            g.activity_tracking = a;
        }
        if let Some(a) = m.get("app_url.tracking").and_then(|v| v.as_bool()) {
            g.app_url_tracking = a;
        }
    }

    pub fn screenshots_enabled(&self) -> bool {
        self.inner.read().screenshots_enabled
    }

    pub fn activity_tracking_enabled(&self) -> bool {
        self.inner.read().activity_tracking
    }

    pub fn app_url_tracking_enabled(&self) -> bool {
        self.inner.read().app_url_tracking
    }

    /// Whether to show a native OS toast on each screenshot capture
    /// (resolved from the `screenshots.notify` setting).
    pub fn notify_on_screenshot(&self) -> bool {
        self.inner.read().notify_on_screenshot
    }

    pub fn last_settings_fetch(&self) -> Option<DateTime<Utc>> {
        self.inner.read().last_settings_fetch
    }

    pub fn record_settings_fetch(&self, at: DateTime<Utc>) {
        self.inner.write().last_settings_fetch = Some(at);
    }

    pub fn api_base(&self) -> Option<String> {
        self.inner.read().api_base.clone()
    }

    pub fn set_api_base(&self, url: String) {
        self.inner.write().api_base = Some(url);
    }

    /// Web base used for the OpsCore login bridge (`/desktop-auth`).
    pub fn web_base(&self) -> String {
        self.inner
            .read()
            .web_base
            .clone()
            .unwrap_or_else(default_web_base)
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
