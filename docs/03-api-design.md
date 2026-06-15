# TimePro — REST API Design

> **Implementation status** — ✅ built · 🟡 partial · ⛔ planned.
>
> - ✅ Implemented route groups: `auth` (dev-login + handoff/exchange), `health`, `me/today`, `projects`, `screenshots` (multipart ingest + list + raw), `team`, `timer`. RFC 9457 errors. Zod validation.
> - 🟡 Auth uses a dev shim — `x-dev-org` + `x-dev-user` headers (non-production), not the JWT/cookie scheme described below. RBAC is enforced on `team` routes only.
> - ⛔ JWT/refresh tokens, device registration, rate limiting, idempotency keys, cursor pagination, webhooks, exports, notifications, activity/URL read endpoints, realtime WS, and generated OpenAPI (`gen:openapi` is a stub).
>
> The endpoint catalog below is the target surface; only the groups marked ✅ exist today.

Fastify + TypeScript. Zod schemas at every boundary. OpenAPI generated from route schemas.

## 1. Conventions

- Base URL: `https://api.timepro.app/v1`
- All requests: `Content-Type: application/json` except multipart (screenshots fallback path).
- Auth: `Authorization: Bearer <jwt>` for agents and API tokens; `HttpOnly` cookie for web.
- Tenant: derived from JWT `org` claim. Org switching uses `POST /v1/auth/switch-org`.
- Idempotency: `Idempotency-Key: <client-uuid>` on every write that comes from the agent.
- Pagination: cursor-based (`?cursor=...&limit=50`, max 200). Response: `{ data, next_cursor }`.
- Sorting: `?sort=-started_at` (`-` = desc).
- Filtering: documented per-endpoint; never accept arbitrary SQL-like filters.
- Errors: RFC 9457 `application/problem+json`.

### 1.1 Error envelope

```json
{
  "type": "https://api.timepro.app/errors/validation",
  "title": "Validation failed",
  "status": 422,
  "code": "validation_failed",
  "detail": "started_at must be before ended_at",
  "errors": [
    { "path": "started_at", "code": "after_ended_at" }
  ],
  "request_id": "req_01HX..."
}
```

### 1.2 Rate limits

| Bucket                       | Limit          | Identifier                       |
| ---------------------------- | -------------- | -------------------------------- |
| Anonymous (login, register)  | 10 req / min   | IP                               |
| Authenticated (user, web)    | 600 req / min  | `user_id`                        |
| Agent ingest (events)        | 6,000 req / min| `device_id`                      |
| Agent screenshots            | 120 req / min  | `device_id`                      |
| Reports / exports            | 30 req / min   | `org_id`                         |

Implemented with Redis token bucket. Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

---

## 2. Authentication

```
POST   /v1/auth/register             # creates org + first user (owner)
POST   /v1/auth/login                # email/password → cookies
POST   /v1/auth/logout
POST   /v1/auth/refresh              # rotates refresh token
POST   /v1/auth/switch-org           # re-issues JWT for another org
POST   /v1/auth/password/forgot
POST   /v1/auth/password/reset
POST   /v1/auth/mfa/enroll
POST   /v1/auth/mfa/verify

POST   /v1/agents/register           # device registration → device_token
POST   /v1/agents/token/refresh
DELETE /v1/agents/:device_id         # revoke a device
```

### 2.1 Device registration flow

```
1. User opens desktop app, enters email + 6-digit pairing code shown in web console.
2. Agent POST /v1/agents/register   { email, code, hostname, platform, os_version, fingerprint, public_key }
3. API validates code (Redis TTL 15min), creates device row, returns:
     { device_id, access_token (1h), refresh_token (90d), pairing: "ok" }
4. Agent stores tokens encrypted with OS keyring (macOS Keychain / Win Credential Vault / libsecret).
```

---

## 3. Organizations & Membership

```
GET    /v1/orgs/current
PATCH  /v1/orgs/current               # name, slug (rate-limited), data_region
DELETE /v1/orgs/current               # owner only, soft-delete + 30d grace

GET    /v1/orgs/current/members
POST   /v1/orgs/current/members/invite     { email, role, team_ids? }
PATCH  /v1/orgs/current/members/:id        { role, employment_type, hourly_rate, ... }
DELETE /v1/orgs/current/members/:id        # soft suspend
POST   /v1/orgs/current/members/:id/resend-invite
```

---

## 4. Teams

```
GET    /v1/teams                       ?cursor&limit
POST   /v1/teams
GET    /v1/teams/:id
PATCH  /v1/teams/:id
DELETE /v1/teams/:id

GET    /v1/teams/:id/members
PUT    /v1/teams/:id/members           { user_ids: [...] }    # idempotent set
```

---

## 5. Projects

```
GET    /v1/projects                    ?status=active&q=&cursor&limit
POST   /v1/projects                    { name, color, is_billable, default_rate_cents, ... }
GET    /v1/projects/:id
PATCH  /v1/projects/:id
DELETE /v1/projects/:id

GET    /v1/projects/:id/members
PUT    /v1/projects/:id/members        { members: [{ user_id, rate_cents? }] }

GET    /v1/projects/:id/tasks
POST   /v1/projects/:id/tasks
PATCH  /v1/projects/:id/tasks/:task_id
```

---

## 6. Time Entries

```
GET    /v1/time-entries                ?user_id=&project_id=&from=&to=&approval_status=&cursor
POST   /v1/time-entries                # manual
GET    /v1/time-entries/:id
PATCH  /v1/time-entries/:id            # description, project, billable, manual edits
DELETE /v1/time-entries/:id

POST   /v1/time-entries/:id/approve
POST   /v1/time-entries/:id/reject     { reason }

# Timer (used by desktop agent and web)
POST   /v1/timer/start                 { project_id, task_id?, description?, client_event_id }
POST   /v1/timer/stop                  { client_event_id }
GET    /v1/timer/current
```

### 6.1 Manual time entry validation

- Cannot overlap an existing entry for the same user.
- `ended_at - started_at` must be ≤ 24h.
- `started_at` must be within last 30 days (configurable per org).
- Edits are logged in `audit_logs` with diff.

---

## 7. Ingest (Desktop Agent)

These endpoints accept high-volume, idempotent writes.

```
POST   /v1/ingest/events
  body: {
    device_id, batch_id,
    events: [
      { client_event_id, type: "activity", bucket_minute, keyboard, mouse, active_seconds, idle_seconds, score },
      { client_event_id, type: "app",      started_at, ended_at, app_name, bundle_id, window_title? },
      { client_event_id, type: "url",      started_at, ended_at, browser, domain, url?, page_title? },
      { client_event_id, type: "time_entry.heartbeat", time_entry_id, at }
    ]
  }
  → 200 { accepted: [...client_event_ids], rejected: [{ id, reason }] }

POST   /v1/ingest/screenshots/presign
  body: { client_event_id, captured_at, time_entry_id?, monitor_index, width, height, content_type }
  → 200 { upload_url, s3_key, expires_at }      # client uploads to S3 directly
POST   /v1/ingest/screenshots/confirm
  body: { client_event_id, s3_key, bytes, sha256, is_blurred }
  → 200 { screenshot_id }

POST   /v1/ingest/screenshots                  # fallback when direct-to-S3 blocked
  multipart: image + metadata
```

### 7.1 Ingest backpressure

If server is overloaded, returns `429 Too Many Requests` with `Retry-After`. Agent doubles its local buffer flush interval and re-tries with exponential backoff (max 5 min).

If the server returns `409 Conflict` on a specific event (duplicate `client_event_id`), the agent marks it synced.

---

## 8. Screenshots

```
GET    /v1/screenshots                 ?user_id=&from=&to=&status=&cursor
GET    /v1/screenshots/:id             → { ..., view_url, thumb_url }     # short-lived signed URLs
POST   /v1/screenshots/:id/approve
POST   /v1/screenshots/:id/reject      { reason }
DELETE /v1/screenshots/:id             # employees may self-delete pre-review (settings-gated)

GET    /v1/screenshots/:id/url         # re-issue signed URL on demand
```

Signed URLs: CloudFront with signed cookies for admin gallery sessions; SigV4 pre-signed URLs (60s TTL) for individual fetches.

---

## 9. Activity, Apps, URLs (read paths)

```
GET    /v1/activity                    ?user_id&from&to&granularity=minute|hour|day
GET    /v1/app-usage                   ?user_id&from&to&group_by=app|category
GET    /v1/url-usage                   ?user_id&from&to&group_by=domain|category
```

All accept the same filter envelope and return aggregated buckets.

---

## 10. Reports

```
GET    /v1/reports/daily               ?user_id|team_id&from&to&project_id
GET    /v1/reports/weekly              ?user_id|team_id&week_start
GET    /v1/reports/monthly             ?user_id|team_id&month
GET    /v1/reports/team-summary        ?team_id&from&to
GET    /v1/reports/payroll             ?from&to            # billable totals per user

POST   /v1/exports                     { type: "timesheet_csv" | "payroll_csv" | "screenshots_zip",
                                         filters: {...} }
GET    /v1/exports/:id                 → { status, download_url? }
```

Exports are async — POST returns `202 Accepted` with an `export_id`. Worker fulfills, uploads to S3, emails the user, and the GET endpoint resolves to a signed URL.

---

## 11. Settings

```
GET    /v1/settings                    ?scope=org|team|project|user&scope_id=
PUT    /v1/settings                    { scope, scope_id, values: {...}, lock?: [keys] }

GET    /v1/settings/effective          ?user_id          # resolved hierarchy for an agent
```

The agent calls `GET /v1/agent/config` (alias) on launch and every 5 minutes; server pushes `settings.updated` events over the WS stream for sub-minute propagation.

### 11.1 Setting keys (canonical)

```
screenshots.per_hour                 0..60
screenshots.random_interval          bool
screenshots.blur                     bool
screenshots.notify                   bool
screenshots.allow_self_delete        bool

tracking.idle_threshold_seconds      30..1800
tracking.auto_pause_on_idle          bool
tracking.track_activity              bool
tracking.track_apps                  bool
tracking.track_urls                  bool
tracking.allow_offline               bool

limits.weekly_hours                  0..168
limits.daily_hours                   0..24

approval.require_timesheet_approval  bool
approval.require_manual_entry_approval bool
```

---

## 12. Notifications

```
GET    /v1/notifications               ?unread=true&cursor&limit
POST   /v1/notifications/:id/read
POST   /v1/notifications/read-all
GET    /v1/notifications/preferences
PATCH  /v1/notifications/preferences
```

---

## 13. Realtime (WebSocket)

`WSS /v1/realtime` — used by the web dashboard.
`WSS /v1/agent/stream` — used by the desktop agent.

Frames are JSON:

```json
{ "type": "settings.updated", "data": { "scope": "org", "keys": ["screenshots.per_hour"] } }
{ "type": "timer.stopped",    "data": { "by": "manager", "reason": "..." } }
{ "type": "presence.update",  "data": { "user_id": "...", "status": "online" } }
{ "type": "screenshot.new",   "data": { "id": "..." } }
```

Authentication: same JWT, passed as `Sec-WebSocket-Protocol: bearer, <jwt>`. Server validates, then attaches to Redis pubsub channels `org:<id>:*`.

---

## 14. Webhooks (Phase 2)

```
GET    /v1/webhooks
POST   /v1/webhooks                    { url, events: [...], secret? }
DELETE /v1/webhooks/:id
GET    /v1/webhooks/:id/deliveries
POST   /v1/webhooks/:id/test
```

Signed with `X-TimePro-Signature: t=...,v1=hmac_sha256(secret, t + "." + body)`.

---

## 15. Admin / Audit

```
GET    /v1/audit-logs                  ?actor=&action=&from=&to=&cursor
GET    /v1/devices                     ?user_id=&status=
POST   /v1/devices/:id/revoke
```

---

## 16. Authorization Model in Code

```ts
// packages/auth/abilities.ts
defineAbility((user, org) => {
  can('read', 'TimeEntry', { user_id: user.id });

  if (user.role === 'manager') {
    can('read', 'TimeEntry', { user_id: { in: teamMemberIds(user.id) } });
    can('approve', 'TimeEntry', { user_id: { in: teamMemberIds(user.id) } });
  }
  if (user.role === 'admin' || user.role === 'owner') {
    can('manage', 'all');
  }
  if (user.role === 'owner') {
    can('delete', 'Organization');
  }
});
```

Every route handler:

```ts
fastify.get('/v1/time-entries/:id', {
  schema: { params: TimeEntryParamsSchema, response: { 200: TimeEntryResponse } },
  preHandler: [auth, requireOrg],
}, async (req, reply) => {
  const entry = await db.timeEntries.findById(req.params.id);
  req.ability.throwUnlessCan('read', entry);
  return entry;
});
```

---

## 17. OpenAPI

Generated automatically from Fastify route schemas (`@fastify/swagger`). Published at `/v1/openapi.json` (org-scoped doc) and `/docs` (Stoplight Elements). The `desktop-sdk` package is generated from this OpenAPI doc on every release.
