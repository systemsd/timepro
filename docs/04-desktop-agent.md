# TimePro — Desktop Agent Architecture

> **Implementation status** — ✅ built · 🟡 partial · ⛔ planned.
>
> - ✅ Tauri 2 shell; email login (dev); timer start/stop + project picker; **automatic screenshot capture** (`xcap`, cross-platform); idle detection (`user-idle`); HTTP sync (`reqwest`); Settings screen; "view online" handoff; API base baked at build time.
> - 🟡 Sync is direct HTTP with no local queue; state is in-memory only.
> - ⛔ Keyboard/mouse activity hooks, app tracking, URL tracking, offline SQLite outbox, encrypted local storage / OS keyring tokens, WebSocket settings push, auto-update, tray/menu-bar icon, single-instance + supervisor, code-signing/notarization.
>
> Live code: `apps/desktop/src-tauri/src/` (`commands.rs`, `api.rs`, `state.rs`, `capture/`).

Tauri 2.x. Rust backend, React + TypeScript UI. Cross-platform: macOS 12+, Windows 10+, Ubuntu 20.04+.

## 1. Process Model

```
┌──────────────────────────────────────────────────────────┐
│  Tauri Main Process (Rust)                               │
│  ├─ tray_service        (menu bar / system tray)         │
│  ├─ window_service      (timer window, login)            │
│  ├─ ipc_router          (UI ↔ Rust commands)             │
│  └─ supervisor          (lifecycle, restart, autostart)  │
└─────────────────────────┬────────────────────────────────┘
                          │  tokio mpsc channels
       ┌──────────────────┼─────────────────────────────────┐
       ▼                  ▼                                 ▼
┌─────────────┐  ┌──────────────────┐         ┌──────────────────────┐
│ Capture Hub │  │  Sync Engine     │         │  Settings Daemon     │
│             │  │                  │         │                      │
│ activity    │  │ batches events   │         │  long-poll WS        │
│ apps        │  │ retries          │         │  + 5-min refresh     │
│ urls        │  │ S3 uploads       │         │  pushes to capture   │
│ screenshots │  │ local sqlite     │         │                      │
└─────────────┘  └──────────────────┘         └──────────────────────┘
```

The Tauri WebView (React UI) is just a thin client over Rust commands. Capture runs even if the window is closed.

---

## 2. Rust Crate Layout (`apps/desktop/src-tauri/`)

```
src-tauri/
├── Cargo.toml
├── tauri.conf.json
└── src/
    ├── main.rs                        # bootstraps Tauri, supervisor
    ├── commands/                      # #[tauri::command] entrypoints from UI
    │   ├── auth.rs                    # login, pair_device, logout
    │   ├── timer.rs                   # start, stop, status
    │   ├── projects.rs                # list, search (cached)
    │   ├── settings.rs                # read effective config
    │   └── sync.rs                    # force_sync, sync_status
    ├── capture/
    │   ├── mod.rs
    │   ├── activity.rs                # keyboard/mouse hooks
    │   ├── apps.rs                    # active app + window title
    │   ├── urls.rs                    # per-browser strategies
    │   ├── screenshots.rs             # capture + encode + blur
    │   └── idle.rs                    # idle detector
    ├── platform/
    │   ├── mod.rs
    │   ├── macos.rs                   # NSWorkspace, CGWindowList, Accessibility
    │   ├── windows.rs                 # SetWinEventHook, GetForegroundWindow
    │   └── linux.rs                   # X11/Wayland, /proc, AT-SPI
    ├── sync/
    │   ├── mod.rs
    │   ├── client.rs                  # API HTTP client
    │   ├── ws.rs                      # agent stream
    │   ├── queue.rs                   # local SQLite queue
    │   └── retry.rs                   # exponential backoff
    ├── storage/
    │   ├── mod.rs
    │   ├── db.rs                      # local SQLite (sqlx)
    │   ├── keychain.rs                # OS keyring wrapper
    │   └── crypto.rs                  # AES-GCM for at-rest payloads
    ├── supervisor.rs                  # watchdog, autostart, single-instance
    ├── tray.rs
    ├── updater.rs                     # Tauri auto-updater hookup
    └── telemetry.rs                   # OTel + Sentry
```

---

## 3. Capture Services

### 3.1 Activity (keyboard + mouse)

Per-platform low-level hooks; **count events, do not log content**.

| Platform | API                                                    |
| -------- | ------------------------------------------------------ |
| macOS    | `CGEventTap` at the session level (requires Accessibility permission) |
| Windows  | `SetWindowsHookExW` (WH_KEYBOARD_LL + WH_MOUSE_LL)     |
| Linux    | `evdev` via `libinput` (X11) or compositor protocols (Wayland fallbacks) |

A `ActivityAggregator` collects counts into a current-minute bucket. At minute rollover:

```rust
ActivitySample {
  bucket_minute: DateTime<Utc>,
  keyboard_events: u16,
  mouse_events: u16,
  active_seconds: u8,   // seconds in this minute with any event
  idle_seconds: u8,
  score: u8,            // weighted: capped log(kb+mouse) × active_ratio × 100
}
```

Pushed to the local queue. Memory footprint < 1 KB/min.

### 3.2 Idle detection

| Platform | API                                                |
| -------- | -------------------------------------------------- |
| macOS    | `CGEventSourceSecondsSinceLastEventType`           |
| Windows  | `GetLastInputInfo`                                 |
| Linux    | `XScreenSaverQueryInfo` (X11) / DBus idle (Wayland)|

If idle exceeds `tracking.idle_threshold_seconds` and `auto_pause_on_idle` is true, agent stops the timer and emits a `timer.stopped` event with `reason="idle"`.

### 3.3 App tracking

Polled every **2 seconds** (cheap, accurate enough). Records intervals of `(app, window_title)` runs.

| Platform | API                                                  |
| -------- | ---------------------------------------------------- |
| macOS    | `NSWorkspace.frontmostApplication` + `AXUIElement` window title |
| Windows  | `GetForegroundWindow` → `GetWindowThreadProcessId` → `QueryFullProcessImageName` + `GetWindowTextW` |
| Linux    | `xdotool`-style via `xprop` / `wmctrl`; Wayland uses `wlr-foreign-toplevel-management` if available, else AT-SPI |

Window titles can leak content; **truncated to 256 chars** and the agent honors `tracking.track_apps` and a per-org regex blocklist (e.g., banks, password managers — never captured).

### 3.4 URL tracking

Browser-aware. Strategies:

| Browser  | Strategy                                                    |
| -------- | ----------------------------------------------------------- |
| Chrome / Edge / Brave | Companion WebExtension that posts URL + title via native messaging to the agent. Required because polling window title hides real URL behind tab text. |
| Firefox  | Same — WebExtension over native messaging.                  |
| Safari   | Safari Web Extension (Phase 2 — requires Apple Developer ID and notarization) |

On Linux/Wayland where extensions aren't reachable, fall back to AT-SPI for the address bar. Always honor `tracking.track_urls` and per-domain blocklists. Query strings stripped by default.

### 3.5 Screenshots

```rust
struct ScreenshotJob {
  monitor_index: u8,
  blur: bool,
  notify: bool,
}

fn capture(job: ScreenshotJob) -> Result<CapturedShot> {
  // 1. Acquire frame
  let raw = match os {
    Mac => screencapturekit_rs::capture(job.monitor_index)?, // requires Screen Recording perm
    Win => dxgi::capture(job.monitor_index)?,                // DXGI desktop duplication
    Linux => match session {
      X11 => xlib::capture(job.monitor_index)?,
      Wayland => xdg_portal::Screenshot::capture()?,         // org.freedesktop.portal.Screenshot
    },
  };

  // 2. Optionally blur
  let img = if job.blur { gaussian_blur(raw, sigma = 6.0) } else { raw };

  // 3. Encode WebP quality 70 + 320x180 thumbnail
  let full = webp::encode(&img, 70);
  let thumb = webp::encode(&resize(&img, 320, 180), 75);

  // 4. Encrypt with per-org DEK (envelope: KEK from server, DEK rotated)
  let enc_full = aes_gcm::seal(&full, &dek);
  let enc_thumb = aes_gcm::seal(&thumb, &dek);

  Ok(CapturedShot { enc_full, enc_thumb, captured_at: Utc::now(), ... })
}
```

Scheduling: a Poisson process targeting `screenshots.per_hour`. Random intervals so users can't game timing. Server-side enforcement: rate-limit screenshot ingest.

If `notify=true`, a brief tray badge + optional native toast — non-blocking.

---

## 4. Local Storage (SQLite)

`~/.timepro/agent.db` (encrypted with SQLCipher).

```sql
CREATE TABLE outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_event_id TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,        -- activity | app | url | screenshot.confirm | timer
  payload         BLOB NOT NULL,        -- msgpack
  occurred_at     INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending'  -- pending | inflight | failed | done
);

CREATE TABLE screenshot_blobs (
  client_event_id TEXT PRIMARY KEY,
  s3_key          TEXT,                  -- filled after presign
  full_blob       BLOB,                  -- encrypted webp
  thumb_blob      BLOB,
  bytes           INTEGER,
  state           TEXT NOT NULL          -- captured | uploading | uploaded | confirmed
);

CREATE TABLE projects_cache (id TEXT PRIMARY KEY, name TEXT, color TEXT, updated_at INTEGER);
CREATE TABLE settings_cache (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);

CREATE INDEX outbox_next ON outbox(state, next_attempt_at);
```

Outbox size cap: 7 days. Screenshot cap: 500 MB; oldest evicted if over.

---

## 5. Sync Engine

State machine per envelope:

```
pending ──(send)──▶ inflight ──(2xx)──▶ done
                       │
                       └──(5xx/network)──▶ failed → backoff → pending
                       └──(4xx)─────────▶ dead-letter (log + drop, alert)
```

- Batches up to 200 events per `POST /ingest/events`.
- Flush every 30s, or sooner when buffer hits 50 events.
- Screenshot upload: `POST /ingest/screenshots/presign` → `PUT` to S3 directly → `POST /confirm`.
- Backoff: `min(2^n, 300)` seconds with jitter ±20%.
- Reconnect WS with the same backoff curve.

### 5.1 Clock skew handling

Agent stamps every event with `occurred_at` from its monotonic clock + UTC anchor. On `register`, server returns `server_time`; agent computes and stores a skew offset. All `occurred_at` values are adjusted before send. Drift > 5 min triggers a warning toast.

### 5.2 Conflict resolution

The server is authoritative. If it rejects an event as duplicate (same `client_event_id`), agent marks it `done`. If it rejects for validation, the event goes to dead-letter and surfaces in the UI as "5 events failed to sync — view details".

---

## 6. Settings Daemon

- On launch: `GET /v1/settings/effective` → cache.
- Subscribes to `WSS /v1/agent/stream`; on `settings.updated`, refetches.
- Fallback: re-fetch every 5 min if WS down.
- Pushes new values to the `Capture Hub` over an mpsc channel — capture services re-read on every cycle.

---

## 7. UI (React inside Tauri)

Three screens:

1. **Login / pair** — email + 6-digit code.
2. **Timer** — project picker, start/stop, today's tally, recent screenshots (last 3), activity indicator.
3. **Settings** — open log folder, sync status, "Force sync", version, sign out.

All UI calls Rust via `invoke('command_name', args)`. No direct network from JS.

---

## 8. Security

- **Tokens** stored in OS keyring (`security-framework` on macOS, `windows-credentials` on Windows, `libsecret` on Linux).
- **SQLite encrypted** with SQLCipher; key derived from a device-bound secret (TPM/Secure Enclave when available; fallback to keyring-stored 32-byte key).
- **Screenshots encrypted** with per-org DEK before storage; KEK lives server-side.
- **Code signed & notarized** (Apple Developer ID + notarytool; Microsoft Authenticode + EV; Linux: signed APT/RPM repos + AppImage with embedded signature).
- **Auto-updater** uses Tauri's signed-update mechanism; binary signature verified against an embedded public key before swap.
- **No telemetry without consent**; crash reports require explicit opt-in.
- **Tamper detection**: supervisor periodically checks code-signing of own binary; mismatches reported as a tamper event.

---

## 9. Lifecycle & Reliability

| Concern             | Mechanism                                                            |
| ------------------- | -------------------------------------------------------------------- |
| Auto-start with OS  | macOS LaunchAgent plist · Windows Task Scheduler · Linux systemd user unit |
| Single instance     | Tauri single-instance plugin + named-pipe / unix-socket lock        |
| Sleep / wake        | OS sleep notifications close the current minute bucket; resume creates a new entry |
| Network change      | Detect via `system-configuration` (mac), `IP Helper API` (win), `NetworkManager` D-Bus (linux) → trigger sync flush + WS reconnect |
| Crash               | Supervisor restarts up to 3× in 5min, then backs off + Sentry report |
| Logs                | `~/.timepro/logs/agent.log` with daily rotation, 7-day retention |
| Permissions         | First-run checks for required OS permissions; UI walks user through granting them |

---

## 10. Permission Matrix

| Permission          | macOS                                | Windows               | Linux                          |
| ------------------- | ------------------------------------ | --------------------- | ------------------------------ |
| Activity hooks      | Accessibility (TCC prompt)           | None (admin install for global hooks) | input group / udev rules |
| Screenshots         | Screen Recording (TCC prompt)        | None                  | XDG Portal prompt (Wayland)    |
| App tracking        | Accessibility                        | None                  | AT-SPI enabled                 |
| URL tracking        | Browser extension install            | Browser extension     | Browser extension              |
| Autostart           | None                                 | None                  | None                           |

UI flows users through this in onboarding. Missing permissions are surfaced as banners.

---

## 11. Updater

`tauri-plugin-updater` with a self-hosted manifest at `https://updates.timepro.app/{platform}/{arch}.json`. Manifest entries are signed with Ed25519; agent verifies before applying. Channels: `stable`, `beta`, `internal`. Org-level pinning supported (enterprise customers can pin to a version).

---

## 12. Telemetry

- OpenTelemetry traces: agent generates a root span per sync batch, exports OTLP to the API which forwards to the collector.
- Sentry for unhandled panics (opt-in per org policy).
- Heartbeat: lightweight `POST /v1/agent/heartbeat` every 60s with battery, online state, version, last-sync. Drives the "Employees online now" widget.
