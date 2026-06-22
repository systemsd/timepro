//! Ships the agent's own `tracing` events (INFO/WARN/ERROR) to the server for
//! remote debugging — a manager/dev reads them via the admin API since there's
//! no SSH to the user's machine.
//!
//! A `tracing` Layer pushes notable events into a shared, capped buffer; a
//! background task batches them to `POST /v1/ingest/agent-logs` every ~30s once
//! a session exists. Fail-open: shipping never blocks tracking, and on error the
//! batch is re-buffered (capped) for the next tick. The ship path never logs at
//! INFO+ itself, to avoid a feedback loop.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

use crate::api::ApiClient;
use crate::state::AppState;

const MAX_BUFFERED: usize = 2000;
const MAX_MESSAGE_CHARS: usize = 4000;

/// One log line, ready to ship (serialized into the ingest payload).
#[derive(Clone, Serialize)]
pub struct AgentLogEvent {
    pub ts: String,
    pub level: String,
    pub event: String,
    pub message: String,
    pub fields: Map<String, Value>,
}

/// Shared, capped buffer between the tracing layer and the shipper task.
pub type LogBuf = Arc<Mutex<Vec<AgentLogEvent>>>;

pub fn new_buffer() -> LogBuf {
    Arc::new(Mutex::new(Vec::new()))
}

/// Collects an event's `message` + structured fields into JSON.
#[derive(Default)]
struct FieldVisitor {
    message: String,
    fields: Map<String, Value>,
}

impl FieldVisitor {
    fn put(&mut self, field: &Field, value: Value) {
        if field.name() == "message" {
            if let Value::String(s) = value {
                self.message = s;
            }
            return;
        }
        self.fields.insert(field.name().to_string(), value);
    }
}

impl Visit for FieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.put(field, Value::String(format!("{value:?}")));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, Value::String(value.to_string()));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, Value::from(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, Value::from(value));
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.put(field, Value::from(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, Value::Bool(value));
    }
}

/// `tracing` Layer: capture our INFO + any WARN/ERROR (skip DEBUG/TRACE and
/// other crates' INFO noise) into the shared buffer.
pub struct LogShipLayer {
    buf: LogBuf,
}

impl LogShipLayer {
    pub fn new(buf: LogBuf) -> Self {
        Self { buf }
    }
}

impl<S: tracing::Subscriber> Layer<S> for LogShipLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let level = match *meta.level() {
            tracing::Level::ERROR => "error",
            tracing::Level::WARN => "warn",
            tracing::Level::INFO => "info",
            _ => return,
        };
        // Keep it relevant: all WARN/ERROR, but only our crate's INFO.
        let is_ours = meta.target().starts_with("timepro_agent");
        if level == "info" && !is_ours {
            return;
        }

        let mut v = FieldVisitor::default();
        event.record(&mut v);
        if v.message.chars().count() > MAX_MESSAGE_CHARS {
            v.message = v.message.chars().take(MAX_MESSAGE_CHARS).collect();
        }
        let ev = AgentLogEvent {
            ts: chrono::Utc::now().to_rfc3339(),
            level: level.to_string(),
            event: meta.target().to_string(),
            message: v.message,
            fields: v.fields,
        };
        if let Ok(mut b) = self.buf.lock() {
            if b.len() < MAX_BUFFERED {
                b.push(ev);
            }
        }
    }
}

/// Background task: every ~30s, drain the buffer and ship a batch once a session
/// exists. On failure, re-buffer (capped to the most recent events) and retry.
pub async fn run_log_shipper(state: Arc<AppState>, buf: LogBuf) {
    let device_id = uuid::Uuid::new_v4().to_string();
    let mut ticker = tokio::time::interval(Duration::from_secs(30));
    loop {
        ticker.tick().await;
        let (session, api_base) = match (state.session(), state.api_base()) {
            (Some(s), Some(a)) => (s, a),
            _ => continue, // not logged in yet; events keep buffering (capped)
        };
        let batch: Vec<AgentLogEvent> = match buf.lock() {
            Ok(mut b) if !b.is_empty() => std::mem::take(&mut *b),
            _ => continue,
        };
        let client = ApiClient::new(api_base, Some(session));
        if client.post_agent_logs(&device_id, &batch).await.is_err() {
            // Re-buffer for next tick, keeping the most recent events on overflow.
            if let Ok(mut b) = buf.lock() {
                let mut combined = batch;
                combined.append(&mut b);
                let len = combined.len();
                if len > MAX_BUFFERED {
                    combined.drain(0..len - MAX_BUFFERED);
                }
                *b = combined;
            }
        }
    }
}
