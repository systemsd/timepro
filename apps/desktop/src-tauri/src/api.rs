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

    pub async fn timer_stop(&self, client_event_id: &str) -> ApiResult<TimerStopResponse> {
        let s = self.require_session()?;
        let resp = self
            .http
            .post(self.url("/v1/timer/stop"))
            .header("x-dev-org", &s.organization_id)
            .header("x-dev-user", &s.user_id)
            .json(&serde_json::json!({ "client_event_id": client_event_id }))
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
