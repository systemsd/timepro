//! In-memory app state.
//!
//! Holds the logged-in session, the running timer, and the configured API base
//! URL. The session is persisted to a JSON file in the app data dir (path set at
//! startup) so the user isn't asked to sign in on every launch; it's cleared on
//! logout. The running timer is intentionally runtime-only.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tracing::warn;

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
    pub description: Option<String>,
    pub started_at: DateTime<Utc>,
}

/// Context captured when tracking auto-pauses on idle, so the same
/// project/description can be resumed automatically once the user is active
/// again (no manual "play" click). Runtime-only — never persisted.
#[derive(Debug, Clone)]
pub struct PausedTimer {
    pub project_id: Option<String>,
    pub description: Option<String>,
}

/// Persist a session to disk so login survives a restart (best-effort).
fn save_session_file(path: &Path, session: &Session) {
    let bytes = match serde_json::to_vec_pretty(session) {
        Ok(b) => b,
        Err(e) => return warn!(error = %e, "failed to serialize session"),
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Err(e) = fs::write(path, bytes) {
        warn!(error = %e, "failed to persist session");
    }
}

/// Load a persisted session at boot, if one exists and parses.
pub fn load_session_file(path: &Path) -> Option<Session> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
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
    /// Where the session is persisted (set at startup from the app data dir).
    session_path: Option<PathBuf>,
    timer: Option<RunningTimer>,
    /// Set when tracking auto-paused on idle; drives auto-resume on next activity.
    paused: Option<PausedTimer>,
    /// Capture cadence — resolved from `/v1/settings/effective`
    /// (`screenshots.per_hour`), with a sensible fallback before first fetch.
    screenshot_interval_sec: u64,
    screenshots_enabled: bool,
    notify_on_screenshot: bool,
    activity_tracking: bool,
    app_url_tracking: bool,
    /// Stop tracking after this many seconds of input idle
    /// (`tracking.auto_pause_minutes`). 0 = disabled until settings load.
    auto_pause_sec: u64,
    /// `screenshots.blur` policy: "allow" | "always" | "never".
    blur_policy: String,
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
                session_path: None,
                timer: None,
                paused: None,
                screenshot_interval_sec: 300, // fallback until settings load
                screenshots_enabled: true,
                notify_on_screenshot: false,
                activity_tracking: true,
                app_url_tracking: true,
                auto_pause_sec: 0, // disabled until the first settings fetch
                blur_policy: "allow".to_string(),
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
        if let Some(ap) = m.get("tracking.auto_pause_minutes").and_then(|v| v.as_f64()) {
            g.auto_pause_sec = if ap > 0.0 { (ap * 60.0).round() as u64 } else { 0 };
        }
        if let Some(b) = m.get("screenshots.blur").and_then(|v| v.as_str()) {
            g.blur_policy = b.to_string();
        }
    }

    pub fn screenshots_enabled(&self) -> bool {
        self.inner.read().screenshots_enabled
    }

    /// Idle seconds after which tracking auto-pauses (0 = disabled).
    pub fn auto_pause_sec(&self) -> u64 {
        self.inner.read().auto_pause_sec
    }

    /// Whether captured screenshots must be blurred before upload.
    pub fn blur_always(&self) -> bool {
        self.inner.read().blur_policy == "always"
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

    /// Where to persist the session (resolved at startup from the app data dir).
    pub fn set_session_path(&self, path: PathBuf) {
        self.inner.write().session_path = Some(path);
    }

    /// Set the active session and persist it to disk (survives a restart).
    pub fn set_session(&self, session: Session) {
        let path = {
            let mut g = self.inner.write();
            g.session = Some(session.clone());
            g.session_path.clone()
        };
        if let Some(p) = path {
            save_session_file(&p, &session);
        }
    }

    /// Load a persisted session into memory at boot (no re-write to disk).
    pub fn restore_session(&self, session: Session) {
        self.inner.write().session = Some(session);
    }

    pub fn clear_session(&self) {
        let path = {
            let mut g = self.inner.write();
            g.session = None;
            g.timer = None;
            g.paused = None;
            g.session_path.clone()
        };
        if let Some(p) = path {
            let _ = fs::remove_file(&p); // best-effort; fine if already gone
        }
    }

    pub fn timer(&self) -> Option<RunningTimer> {
        self.inner.read().timer.clone()
    }

    pub fn set_timer(&self, timer: RunningTimer) {
        let mut g = self.inner.write();
        g.timer = Some(timer);
        g.paused = None; // starting/resuming a timer cancels any pending auto-resume
    }

    pub fn clear_timer(&self) {
        self.inner.write().timer = None;
    }

    /// The auto-pause context, if tracking is currently idle-paused.
    pub fn paused(&self) -> Option<PausedTimer> {
        self.inner.read().paused.clone()
    }

    pub fn set_paused(&self, p: PausedTimer) {
        self.inner.write().paused = Some(p);
    }

    pub fn clear_paused(&self) {
        self.inner.write().paused = None;
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
