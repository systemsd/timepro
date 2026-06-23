//! Thin HTTP client for the TimePro REST API.
//!
//! MVP auth: the server's `requireAuth` middleware accepts `x-dev-org`
//! and `x-dev-user` headers. We send those on every authenticated call.
//! When real JWT auth lands, this client gets `Authorization: Bearer`
//! and a refresh dance, and the headers go away.

use std::time::Duration;

use reqwest::multipart;
use serde::{Deserialize, Serialize};

use crate::state::Session;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("not authenticated — call dev_login first")]
    NotAuthenticated,
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("server error {status}: {body}")]
    Server { status: u16, body: String },
    #[error("decode error: {0}")]
    Decode(#[from] serde_json::Error),
}

pub type ApiResult<T> = std::result::Result<T, ApiError>;

pub struct ApiClient {
    base: String,
    session: Option<Session>,
    http: reqwest::Client,
}

impl ApiClient {
    pub fn new(base: String, session: Option<Session>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("TimePro-Agent/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client builder");
        Self { base, session, http }
    }

    fn require_session(&self) -> ApiResult<&Session> {
        self.session.as_ref().ok_or(ApiError::NotAuthenticated)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base.trim_end_matches('/'), path)
    }

    async fn parse<T: for<'de> Deserialize<'de>>(
        resp: reqwest::Response,
    ) -> ApiResult<T> {
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ApiError::Server { status: status.as_u16(), body });
        }
        Ok(resp.json::<T>().await?)
    }

    // ---- auth ----

    pub async fn dev_login(&self, email: &str) -> ApiResult<DevLoginResponse> {
        let resp = self
            .http
            .post(self.url("/v1/auth/dev-login"))
            .json(&serde_json::json!({ "email": email }))
            .send()
            .await?;
        Self::parse(resp).await
    }

    /// Exchange an OpsCore handoff JWT (captured via the loopback flow) for a
    /// TimePro device session. Same response shape as `dev_login`.
    pub async fn opscore_exchange(&self, token: &str) -> ApiResult<DevLoginResponse> {
        let resp = self
            .http
            .post(self.url("/v1/auth/opscore/exchange"))
            .json(&serde_json::json!({ "token": token }))
            .send()
            .await?;
        Self::parse(resp).await
    }

    // ---- projects ----

    pub async fn list_projects(&self) -> ApiResult<ProjectsResponse> {
        let s = self.require_session()?;
        let resp = self
            .http
            .get(self.url("/v1/projects"))
            .header("x-dev-org", &s.organization_id)
            .header("x-dev-user", &s.user_id)
            .send()
            .await?;
        Self::parse(resp).await
    }

    // ---- timer ----

    pub async fn timer_start(
        &self,
        project_id: Option<&str>,
        description: Option<&str>,
        client_event_id: &str,
    ) -> ApiResult<TimerSnapshot> {
        let s = self.require_session()?;
        let mut body = serde_json::json!({
            "client_event_id": client_event_id,
            "source": "desktop",
        });
        if let Some(p) = project_id {
            body["project_id"] = serde_json::Value::String(p.to_string());
        }
        if let Some(d) = description {
            if !d.is_empty() {
                body["description"] = serde_json::Value::String(d.to_string());
            }
        }
        let resp = self
            .http
            .post(self.url("/v1/timer/start"))
            .header("x-dev-org", &s.organization_id)
            .header("x-dev-user", &s.user_id)
            .json(&body)
            .send()
            .await?;
        Self::parse(resp).await
    }

    /// Stop the running timer. `ended_at` (RFC 3339) back-dates the stop to the
    /// last active moment — used when the agent detects the machine slept or the
    /// user went idle, so the away window isn't billed. `None` lets the server
    /// stamp "now" (a normal manual stop). The server clamps to [started_at, now].
    pub async fn timer_stop(
        &self,
        client_event_id: &str,
        ended_at: Option<&str>,
    ) -> ApiResult<TimerStopResponse> {
        let s = self.require_session()?;
        let mut body = serde_json::json!({ "client_event_id": client_event_id });
        if let Some(ts) = ended_at {
            body["ended_at"] = serde_json::Value::String(ts.to_string());
        }
        let resp = self
            .http
            .post(self.url("/v1/timer/stop"))
            .header("x-dev-org", &s.organization_id)
            .header("x-dev-user", &s.user_id)
            .json(&body)
            .send()
            .await?;
        Self::parse(resp).await
    }

    pub async fn timer_current(&self) -> ApiResult<Option<TimerSnapshot>> {
        let s = self.require_session()?;
        let resp = self
            .http
            .get(self.url("/v1/timer/current"))
            .header("x-dev-org", &s.organization_id)
            .header("x-dev-user", &s.user_id)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ApiError::Server { status: status.as_u16(), body });
        }
        // /timer/current returns either a TimerSnapshot or null.
        let v: serde_json::Value = resp.json().await?;
        if v.is_null() {
            Ok(None)
        } else {
            Ok(Some(serde_json::from_value(v)?))
        }
    }

    // ---- capture ingest (B4/B5) ----

    pub async fn ingest_activity(
        &self,
        samples: &[crate::capture::activity::ActivitySample],
        time_entry_id: Option<String>,
    ) -> ApiResult<()> {
        let s = self.require_session()?;
        let payload: Vec<serde_json::Value> = samples
            .iter()
            .map(|sa| {
                serde_json::json!({
                    "bucket_minute": sa.bucket_minute.to_rfc3339(),
                    "time_entry_id": time_entry_id,
                    "keyboard_events": 0,
                    "mouse_events": 0,
                    "active_seconds": sa.active_seconds,
                    "idle_seconds": sa.idle_seconds,
                    "activity_score": sa.activity_score,
                })
            })
            .collect();
        let resp = self
            .http
            .post(self.url("/v1/ingest/activity"))
            .header("x-dev-org", &s.organization_id)
            .header("x-dev-user", &s.user_id)
            .json(&serde_json::json!({ "samples": payload }))
            .send()
            .await?;
        Self::ok_or_err(resp).await
    }

    pub async fn ingest_app_usage(
        &self,
        app_name: &str,
        window_title: Option<&str>,
        started_at: &str,
        ended_at: &str,
        time_entry_id: Option<String>,
    ) -> ApiResult<()> {
        let s = self.require_session()?;
        let resp = self
            .http
            .post(self.url("/v1/ingest/app-usage"))
            .header("x-dev-org", &s.organization_id)
            .header("x-dev-user", &s.user_id)
            .json(&serde_json::json!({
                "events": [{
                    "app_name": app_name,
                    "window_title": window_title,
                    "started_at": started_at,
                    "ended_at": ended_at,
                    "time_entry_id": time_entry_id,
                }]
            }))
            .send()
            .await?;
        Self::ok_or_err(resp).await
    }

    async fn ok_or_err(resp: reqwest::Response) -> ApiResult<()> {
        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            Err(ApiError::Server { status, body })
        }
    }

    // ---- presence ----

    /// Heartbeat so the web shows this user as online (B3). `is_tracking`
    /// reflects whether a timer is currently running.
    pub async fn heartbeat(&self, is_tracking: bool) -> ApiResult<()> {
        let s = self.require_session()?;
        let resp = self
            .http
            .post(self.url("/v1/agent/heartbeat"))
            .header("x-dev-org", &s.organization_id)
            .header("x-dev-user", &s.user_id)
            .json(&serde_json::json!({ "is_tracking": is_tracking }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(ApiError::Server { status, body });
        }
        Ok(())
    }

    // ---- settings ----

    /// Effective settings for the logged-in user (`{key: value}` map).
    pub async fn get_effective_settings(
        &self,
    ) -> ApiResult<serde_json::Map<String, serde_json::Value>> {
        let s = self.require_session()?;
        let resp = self
            .http
            .get(self.url("/v1/settings/effective"))
            .header("x-dev-org", &s.organization_id)
            .header("x-dev-user", &s.user_id)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ApiError::Server { status: status.as_u16(), body });
        }
        let v: serde_json::Value = resp.json().await?;
        Ok(v.get("effective")
            .and_then(|e| e.as_object())
            .cloned()
            .unwrap_or_default())
    }

    // ---- view-online handoff ----

    /// Ship a batch of diagnostic log events. Best-effort (fail-open by caller).
    pub async fn post_agent_logs(
        &self,
        device_id: &str,
        app_version: &str,
        events: &[crate::logship::AgentLogEvent],
    ) -> ApiResult<()> {
        let s = self.require_session()?;
        let body = serde_json::json!({
            "device_id": device_id,
            "agent_version": app_version,
            "os": std::env::consts::OS,
            "events": events,
        });
        let resp = self
            .http
            .post(self.url("/v1/ingest/agent-logs"))
            .header("x-dev-org", &s.organization_id)
            .header("x-dev-user", &s.user_id)
            .json(&body)
            .send()
            .await?;
        Self::parse::<serde_json::Value>(resp).await.map(|_| ())
    }

    pub async fn create_handoff(&self) -> ApiResult<HandoffResponse> {
        let s = self.require_session()?;
        let resp = self
            .http
            .post(self.url("/v1/auth/handoff"))
            .header("x-dev-org", &s.organization_id)
            .header("x-dev-user", &s.user_id)
            .json(&serde_json::json!({}))
            .send()
            .await?;
        Self::parse(resp).await
    }

    // ---- screenshots ----

    pub async fn upload_screenshot(
        &self,
        png_bytes: Vec<u8>,
        meta: ScreenshotMeta,
    ) -> ApiResult<ScreenshotUploadResponse> {
        let s = self.require_session()?;
        let meta_json = serde_json::to_string(&meta)?;

        let form = multipart::Form::new()
            .text("meta", meta_json)
            .part(
                "image",
                multipart::Part::bytes(png_bytes)
                    .file_name("screenshot.png")
                    .mime_str("image/png")
                    .expect("png mime is valid"),
            );

        let resp = self
            .http
            .post(self.url("/v1/screenshots"))
            .header("x-dev-org", &s.organization_id)
            .header("x-dev-user", &s.user_id)
            // Screenshot uploads are larger than other calls — give them more than
            // the client's default 15s so they don't time out on slower links.
            .timeout(Duration::from_secs(60))
            .multipart(form)
            .send()
            .await?;
        Self::parse(resp).await
    }
}

// ---- wire types (match the API's response shapes) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevLoginResponse {
    pub user_id: String,
    pub organization_id: String,
    pub organization_name: String,
    pub display_name: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectsResponse {
    pub projects: Vec<Project>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub color: String,
    pub status: String,
    pub is_billable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimerSnapshot {
    pub id: String,
    pub project_id: Option<String>,
    pub started_at: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimerStopResponse {
    pub id: String,
    pub project_id: Option<String>,
    pub started_at: String,
    pub ended_at: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotMeta {
    pub client_event_id: String,
    pub captured_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_entry_id: Option<String>,
    pub monitor_index: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotUploadResponse {
    pub id: String,
    pub captured_at: String,
    pub bytes: u64,
    pub local_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffResponse {
    pub url: String,
    pub expires_at: String,
}
