# TrackFlow — System & Service Architecture

## 1. Service Inventory

| Service           | Runtime         | Purpose                                                          | Scaling unit          |
| ----------------- | --------------- | ---------------------------------------------------------------- | --------------------- |
| `web`             | Node 22 / Next  | Marketing + SaaS dashboard (SSR + RSC)                           | Horizontal, stateless |
| `api`             | Node 22 / Fastify | All REST endpoints, auth, ingest, query                        | Horizontal, stateless |
| `worker`          | Node 22 / BullMQ | Async jobs: thumbnails, rollups, exports, notifications        | Horizontal per-queue  |
| `scheduler`       | Node 22         | Cron emitter — enqueues recurring jobs to BullMQ                | Singleton (leader-elected) |
| `realtime`        | Node 22 / ws    | WebSocket hub for live dashboards & agent commands              | Horizontal w/ Redis pubsub |
| `desktop-agent`   | Rust / Tauri    | OS-level capture, local buffer, sync                            | Per device            |
| `postgres`        | PG 16           | Primary OLTP store                                              | Vertical + read replicas |
| `redis`           | Redis 7         | BullMQ broker, session cache, rate limit, pubsub                | Cluster (Phase 2)     |
| `s3`              | AWS / R2 / Minio| Screenshots, exports, agent updates                             | N/A                   |
| `nginx`           | Nginx           | TLS termination, routing, static, rate limit                    | Horizontal            |

All Node services share `packages/*`. All services emit OpenTelemetry to a collector (OTLP → Tempo/Loki/Prometheus).

---

## 2. Request Topology

### 2.1 Web dashboard request

```
Browser → CloudFront → Nginx → web (Next.js SSR)
                                 └─→ api (server actions / RSC fetch)
                                          └─→ Postgres / Redis
```

`web` never holds business logic. Server actions call `api` over an internal Unix socket / private mesh with a service token. This keeps one source of truth for authz.

### 2.2 Desktop agent → API

```
Tauri agent (Rust)
   ├─ POST /v1/ingest/events       (batched, idempotent)
   ├─ POST /v1/ingest/screenshots  (direct multipart, or pre-signed S3 PUT)
   ├─ POST /v1/timer/start|stop
   ├─ GET  /v1/agent/config        (settings + heartbeat)
   └─ WSS  /v1/agent/stream        (commands: stop-timer, refresh-settings)
```

Screenshots use **pre-signed S3 PUTs** for the binary; only metadata hits the API. Reduces API egress by 95%+.

### 2.3 Background pipeline

```
api  ── enqueue ──▶ Redis (BullMQ) ──▶ worker
                                          ├─ S3 (thumbnails, exports)
                                          ├─ Postgres (rollups)
                                          └─ SES (email)
scheduler ── enqueue ──▶ Redis ──▶ worker (cron: nightly rollups, weekly reports, retention sweep)
```

---

## 3. Tenancy Model

**Single shared database, schema-per-data, row-level isolation.**

- Every business table carries `organization_id uuid NOT NULL`.
- A `tenant_context` GUC is set per connection: `SET LOCAL app.organization_id = '...'`.
- PostgreSQL **Row-Level Security** is enabled on every tenant table:
  ```sql
  CREATE POLICY tenant_isolation ON time_entries
    USING (organization_id = current_setting('app.organization_id')::uuid);
  ```
- A small set of "platform" tables (`organizations`, `users`, `audit_logs.platform_*`) are exempt.
- Application code uses a `withTenant(orgId, fn)` helper that wraps every transaction and sets the GUC. Forgetting the helper means RLS rejects the query — **fail-closed**.

This gives us: cheap operations of shared infra + true defense-in-depth isolation. The exit ramp to schema-per-tenant is `pg_dump --schema=` per org.

---

## 4. Authentication & Session Architecture

### 4.1 Identity sources

- **Email + password** (Argon2id, OWASP params).
- **Magic link** (Phase 2).
- **SSO (SAML/OIDC)** for Enterprise (Phase 3).
- **Device tokens** for desktop agents (separate trust class).

### 4.2 Session tokens

| Token              | Carrier            | TTL    | Storage                  | Rotation              |
| ------------------ | ------------------ | ------ | ------------------------ | --------------------- |
| Web access token   | `HttpOnly` cookie  | 15 min | JWT (signed, not stored) | On refresh            |
| Web refresh token  | `HttpOnly` cookie  | 30 d   | Opaque, hashed in DB     | Rotating, single-use  |
| Agent access token | Authorization hdr  | 1 h    | JWT                      | On refresh            |
| Agent refresh      | Encrypted store    | 90 d   | Opaque, hashed in DB     | Rotating, single-use  |
| Service token      | mTLS / shared sec  | n/a    | KMS                      | Manual                |

JWTs carry: `sub` (user_id), `org` (org_id), `roles[]`, `device_id?`, `jti`. They are **stateless** for routing but every privileged action re-reads the row to honor revocation.

### 4.3 Roles (RBAC)

| Role      | Capabilities                                                                 |
| --------- | ---------------------------------------------------------------------------- |
| Owner     | Everything in org. Billing. Transfer ownership. Delete org.                  |
| Admin     | Manage users, teams, projects, settings. View all data.                      |
| Manager   | Manage their teams + projects. View team data. Approve timesheets.           |
| Employee  | Track time. View own data. Submit timesheets.                                |

Permissions are derived from role + team membership + project membership. Checked centrally in `packages/auth/abilities.ts` (CASL-style).

---

## 5. Runtime Contracts Between Services

### 5.1 Internal API authentication

Internal calls (`web → api`, `worker → api`) use **JWT signed with an internal HS256 key** plus `x-internal-service: <name>` header, and only over the private network. No browser-reachable internal routes.

### 5.2 Idempotency

All write endpoints accept an `Idempotency-Key` header. The API stores `(org_id, key, request_hash, response)` in Redis (24h). Mismatched hash → 409.

### 5.3 Versioning

URL-versioned (`/v1`). Breaking changes require a new major. Additive fields are not breaking. Agent declares `x-agent-version`; server returns `x-min-agent-version` header — if older, agent forces self-update.

---

## 6. Observability

| Pillar       | Tool                | Notes                                            |
| ------------ | ------------------- | ------------------------------------------------ |
| Logs         | Pino → Loki         | JSON, with `org_id`, `user_id`, `request_id`     |
| Metrics      | Prometheus          | RED metrics per route, queue depth, lag          |
| Traces       | OTel → Tempo        | Agent generates root span, propagates to API     |
| Errors       | Sentry              | Front + back + agent                             |
| Uptime       | Better Stack        | Synthetic checks per region                      |

### SLOs (MVP)

| SLO                                      | Target  |
| ---------------------------------------- | ------- |
| API availability                         | 99.9%   |
| API p99 latency (read)                   | < 300ms |
| API p99 latency (ingest)                 | < 500ms |
| Screenshot ingest success (24h window)   | 99.95%  |
| Agent reconnect after network blip       | < 30s   |

---

## 7. Configuration Hierarchy

Effective setting = **org default ← team override ← user override ← admin lock**.

Settings live in `settings_scoped` rows keyed by `(scope_type, scope_id, key)`. Resolution is cached in Redis per `(scope, key)` for 60s; invalidation is push-based on write.

Locked settings cannot be overridden at narrower scopes — used for compliance (e.g., "screenshots always blurred").

---

## 8. Deployment Topology (MVP)

Single region, two AZs:

```
                       ┌─────────────────────────┐
                       │   CloudFront (CDN)      │
                       └────────────┬────────────┘
                                    ▼
                       ┌─────────────────────────┐
                       │   ALB / Nginx           │
                       └────┬──────────────┬─────┘
                            │              │
              ┌─────────────▼───┐    ┌─────▼──────────┐
              │ web (2×)        │    │ api (3×)       │
              └─────────────────┘    └─────────┬──────┘
                                               │
                  ┌────────────────────────────┼──────────────┐
                  ▼                            ▼              ▼
            ┌──────────┐                ┌───────────┐  ┌──────────┐
            │  worker  │                │ Postgres  │  │  Redis   │
            │  (3×)    │                │ primary + │  │ primary +│
            │          │                │ 1 replica │  │ 1 replica│
            └────┬─────┘                └───────────┘  └──────────┘
                 │
                 ▼
            ┌──────────┐
            │   S3     │
            └──────────┘
```

Phase 3: multi-region with regional Postgres + global S3 + Aurora-style replication. See [10-scaling.md](10-scaling.md).
