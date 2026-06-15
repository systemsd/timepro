# TimePro — Development Roadmap

> **Current position:** mid-MVP. A working slice spans all three surfaces — desktop time tracking +
> automatic screenshot capture, the web dashboard, login + desktop→web auto-login, and team
> management. Still open within Phase 1: real auth (passwords/JWT/MFA), S3 storage + thumbnails,
> activity/app/URL tracking, reporting rollups, and notifications. Phases 2–3 below are unstarted.

Three phases sized for a focused team of ~6–10 engineers (1 staff, 3 backend, 2 frontend, 1–2 Rust/desktop, 1 ops/SRE).

## Phase 1 — MVP (≈ 14 weeks)

> Goal: a single org can sign up, install the agent on Mac/Windows, track time against projects, capture screenshots, and the admin can review timesheets and screenshots. Closes the loop end-to-end.

### Workstreams (parallel)

**Foundations (weeks 1–4)**
- Monorepo scaffold (Turborepo + pnpm).
- `packages/db` with Drizzle schema for org/user/membership/team/project/time_entries/devices/screenshots/activity_samples.
- `apps/api` Fastify skeleton: health, /v1/openapi.json, auth handlers, RLS-bound DB context.
- `apps/web` Next.js shell, auth pages, dashboard scaffold.
- CI: lint, type-check, build, basic test.
- Local Compose with Postgres, Redis, Minio.

**Identity & Tenancy (weeks 3–6)**
- Email/password register/login, sessions, refresh, password reset.
- Organization creation; first user becomes owner.
- Member invites + role assignment (owner/admin/manager/employee).
- RLS policies on every tenant table.

**Core Tracking (weeks 5–9)**
- Projects CRUD + project membership.
- Teams CRUD.
- `/v1/timer/*` endpoints.
- Time entries CRUD + manual edits + simple validation.
- Web: timer widget on dashboard, time entries list.

**Desktop Agent — Capture v1 (weeks 5–12)**
- Tauri shell, login + device pair flow.
- Tray UI + start/stop timer.
- Activity hooks for macOS + Windows (Linux best-effort).
- App tracking on macOS + Windows.
- Screenshot capture on macOS + Windows.
- Local SQLite outbox + sync engine v1 with retries.
- Idle detection + auto-pause.
- Auto-start + tray persistence.

**Capture Backend (weeks 7–11)**
- `POST /v1/ingest/events` batched ingest.
- Pre-signed S3 PUT for screenshots + `/confirm`.
- `screenshot.process` worker for thumbnail fallback + AV.
- `activity_samples`, `app_usage` partitioning + monthly partitions.
- Settings hierarchy + agent `GET /v1/settings/effective`.

**Reports v1 (weeks 9–12)**
- Daily rollup job + `reports_daily` table.
- Web: daily/weekly view per user.
- CSV export of timesheets.
- Screenshot gallery with approve/reject.

**Polish & Launch (weeks 12–14)**
- Notifications: email for "new device", "weekly digest".
- Audit log for sensitive actions.
- Onboarding flow (org setup, first project, install agent).
- Marketing site + docs.
- Pilot deployment (Compose on EC2, managed Postgres + Redis, Minio → S3).
- Synthetic uptime monitors.

### MVP Cut List (explicitly *not* in MVP)

- URL tracking (browser extensions deferred to Phase 2).
- Linux agent first-class (best-effort only).
- Mobile.
- SSO/SAML.
- Webhooks.
- Billing & subscriptions (manual invoicing during pilot).
- ClickHouse / analytics warehouse.
- WebAuthn.
- Materialized views.
- Watermarked screenshot viewer.
- Productivity categorization (manual only).
- Approval workflows beyond basic approve/reject.
- Internationalization (English-only).
- Multi-region.

### MVP Success Criteria

- One org × 10 users runs for 2 weeks with no data loss and <1% sync failures.
- Owner can produce a weekly payroll-ready CSV in <30 seconds.
- Agent autostarts on login and survives sleep/wake on Mac + Windows.
- p99 ingest < 700ms under pilot load.

---

## Phase 2 — Production (≈ 16 weeks after MVP)

> Goal: convert pilots to paying customers. Make TimePro operationally robust, expand capture to URLs and Linux, ship billing, harden security to SOC 2 readiness.

### Themes

**Capture parity**
- URL tracking via browser extensions (Chrome, Edge, Brave, Firefox) with native messaging.
- Linux agent (X11 + Wayland) brought to parity with Mac/Win.
- Multi-monitor screenshots.
- Per-app/URL productivity categorization with org-overridable defaults.

**Operational hardening**
- Materialized views for org-level analytics.
- Webhooks (subscriptions, deliveries, retries, signing).
- ClickHouse ingestion pipeline for app/URL analytics (orgs > 200 users).
- Realtime dashboard updates.
- Per-tenant compute budgets.
- Backup verification automation; quarterly DR drills.

**Identity**
- WebAuthn (passkeys).
- Magic links.
- Org-level "Require MFA" enforcement.
- "Active sessions" UI + revoke.

**Billing**
- Stripe integration (per-seat metered).
- Plans: Free (3 seats), Starter, Business, Enterprise.
- In-app upgrade/downgrade with proration.
- Trials + grace periods.
- Stripe webhooks → `billing.meter` queue.

**Admin & Compliance**
- DSAR endpoints (export-my-data, delete-my-data).
- Retention policy UI per org.
- Audit log search + export.
- Watermarked screenshot viewer.
- SOC 2 Type II readiness: policies, evidence collection, control reviews.

**Reports**
- Custom dashboards (drag-and-drop widgets).
- Team summaries, leaderboards.
- Payroll integration (Gusto, Rippling — phase 2 stretch).

**Mobile (Phase 2 stretch)**
- React Native viewer (no capture — read-only timesheets + approvals).

### Phase 2 Success Criteria

- 200 paying orgs.
- SOC 2 Type II audit started.
- API availability ≥ 99.9% for 90 consecutive days.
- Agent compatibility matrix covers macOS 12+, Windows 10+, Ubuntu 20.04+, Fedora 36+, with documented support.

---

## Phase 3 — Scale & Enterprise (12+ months out)

> Goal: enable 1k+ org accounts, multi-region presence, enterprise sales motion.

### Themes

**Enterprise**
- SSO: SAML + OIDC (Okta, Azure AD, Google Workspace).
- SCIM provisioning.
- Audit log delivery to customer SIEM (S3 + ELK + Splunk integrations).
- IP allowlisting per org.
- HIPAA-compatible plan with BAA.
- Customer-managed KMS keys (BYOK).
- Org-level data residency (US, EU, AU).

**Scale infrastructure**
- Multi-region API + DB.
- Citus or built-in PG sharding for `time_entries`.
- ClickHouse for all analytics surfaces.
- Per-region S3 buckets + KMS multi-region keys.
- Per-region CDN POPs.

**Advanced product**
- Auto-categorization with ML (productive vs not, deterministic + heuristic, no LLM hallucination for billable hours).
- Anomaly detection (unusual idle, off-hours, geographically improbable).
- Goals & OKRs.
- Real-time team coordination view ("who's working on what right now").
- Native mobile capture (with appropriate restrictions).
- Public API + Zapier/Make integrations.

**Internationalization**
- Full i18n (UI + email).
- Localized payroll exports.
- Multi-currency rate handling on memberships.

### Phase 3 Success Criteria

- 1,000+ orgs.
- Multi-region deploy with regional failover tested.
- $X ARR (commercial target).
- ISO 27001 certified.

---

## Cross-Cutting Tracks (always-on)

- Performance budget review every release.
- Quarterly chaos engineering (kill a node, partition Redis, induce latency).
- Monthly security review (dep audits, perms, secret rotation).
- Quarterly DR drill.
- Continuous accessibility audit (WCAG 2.2 AA target on the web app).

---

## Team Allocation Snapshot (Phase 1)

| Role          | Headcount | Focus                                                    |
| ------------- | --------- | -------------------------------------------------------- |
| Staff eng     | 1         | Architecture, code review, unblock                       |
| Backend       | 3         | API, DB, workers, ingest                                 |
| Frontend      | 2         | Web (Next.js), shadcn/ui components                      |
| Desktop (Rust)| 1–2       | Tauri agent, platform code, sync engine                  |
| Ops/SRE       | 1         | Compose/Terraform, CI/CD, observability                  |
| Product/UX    | 0.5–1     | Flows, copy, marketing site                              |

Phase 2 adds: 1 security engineer, 1 mobile engineer (stretch), 1 data engineer (for ClickHouse pipeline).
