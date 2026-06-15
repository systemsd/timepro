# TimePro — System Overview

> **Implementation status** — this document describes the full target system; much of it is still
> forward-looking. Legend: ✅ built · 🟡 partial · ⛔ planned.
>
> - ✅ Web console, REST API, and desktop agent (MVP); time tracking; automatic screenshot capture; team management; desktop→web auto-login.
> - 🟡 Auth (email-only dev login, no JWT/MFA); tenancy (app-level filtering, RLS not yet enforced); storage (local filesystem, not S3).
> - ⛔ Workers/queues, scheduler, realtime hub, reporting rollups, activity/app/URL tracking, billing, multi-region, observability stack.
>
> Per-area detail is in each document's own status banner. Ground truth: [`CLAUDE.md`](../CLAUDE.md).

> A production-grade, multi-tenant employee time-tracking and productivity-monitoring platform.
> Comparable in scope to Hubstaff, Time Doctor, and ScreenshotMonitor.

---

## 1. Product Statement

TimePro lets organizations track employee work time, capture and review screenshots, measure activity, monitor application and URL usage, and produce payroll-ready reports — across Windows, macOS, and Linux.

Three primary surfaces:

| Surface          | Audience                          | Stack                                |
| ---------------- | --------------------------------- | ------------------------------------ |
| **Web Console**  | Owners, Admins, Managers          | Next.js · TypeScript · Tailwind · shadcn/ui |
| **Desktop Agent**| Employees                         | Tauri · Rust · React                 |
| **REST API**     | Web + Desktop + Integrations      | Fastify · TypeScript · Drizzle ORM   |

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              CLIENTS                                     │
│                                                                          │
│   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────────┐  │
│   │  Web Console    │   │  Desktop Agent  │   │  Mobile (future)    │  │
│   │  Next.js (SSR)  │   │  Tauri + Rust   │   │  React Native       │  │
│   └────────┬────────┘   └────────┬────────┘   └──────────┬──────────┘  │
└────────────┼─────────────────────┼────────────────────────┼─────────────┘
             │ HTTPS               │ HTTPS + WebSocket      │
             ▼                     ▼                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         EDGE / CDN  (CloudFront)                         │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       NGINX  (TLS, rate-limit, WAF)                      │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          APPLICATION LAYER                               │
│                                                                          │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│   │  api         │  │  worker      │  │  scheduler   │  │  realtime  │ │
│   │  (Fastify)   │  │  (BullMQ)    │  │  (cron)      │  │  (WS hub)  │ │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
└──────────┼─────────────────┼─────────────────┼────────────────┼────────┘
           │                 │                 │                │
           ▼                 ▼                 ▼                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                            DATA LAYER                                    │
│                                                                          │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│   │ PostgreSQL   │  │   Redis      │  │   S3         │  │ ClickHouse │ │
│   │  (OLTP)      │  │ (cache+BullMQ│  │ (screenshots │  │ (analytics │ │
│   │  partitioned │  │  +sessions)  │  │ +exports)    │  │  phase 2)  │ │
│   └──────────────┘  └──────────────┘  └──────────────┘  └────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Subsystems

| Subsystem          | Responsibility                                                                       |
| ------------------ | ------------------------------------------------------------------------------------ |
| **Identity**       | Auth, sessions, refresh tokens, org membership, RBAC, device registration            |
| **Tenancy**        | Organization isolation, settings hierarchy, per-tenant rate limits                   |
| **Time Tracking**  | Time entries, idle detection, manual edits, approvals                                |
| **Capture**        | Screenshots, activity samples, app/URL tracking ingest                               |
| **Storage**        | S3 lifecycle, thumbnail pipeline, encryption, signed URLs                            |
| **Reporting**      | Daily/weekly/monthly rollups, materialized views, exports                            |
| **Notifications**  | Email (SES), in-app, webhooks                                                        |
| **Billing**        | Per-seat metering, Stripe integration (Phase 2)                                      |
| **Admin**          | Audit log, retention, GDPR/DSAR tooling                                              |

---

## 4. Key Architectural Principles

1. **Tenant isolation by default.** Every row has `organization_id`. Every query enforces it through a tenant-scoped DB context. Row-Level Security (RLS) policies as a defense-in-depth backstop.
2. **Write-optimized ingest, read-optimized reporting.** Hot writes hit normalized tables; reads come from rollups and materialized views.
3. **The desktop agent is an unreliable narrator.** Treat every event as untrusted, idempotent, and replay-safe. Use client-generated event IDs.
4. **Offline-first agent.** Local SQLite buffer; server is eventually consistent for capture data.
5. **Screenshots are write-once, immutable, encrypted at rest, accessed via short-lived signed URLs.**
6. **Background work is the default.** Anything that can take >50ms or fan out goes to BullMQ.
7. **Observability is a feature.** OpenTelemetry traces from agent → API → DB; structured logs; SLO dashboards.
8. **Boring tech.** Postgres, Redis, S3, Nginx. Add ClickHouse only when reporting load demands it (Phase 2+).

---

## 5. Document Map

| File                                          | Contents                                                  |
| --------------------------------------------- | --------------------------------------------------------- |
| [01-system-architecture.md](01-system-architecture.md) | Services, deployment topology, runtime contracts |
| [02-database-schema.md](02-database-schema.md)         | ERD, tables, indexes, partitioning, Drizzle schema |
| [03-api-design.md](03-api-design.md)                   | REST routes, auth, pagination, errors            |
| [04-desktop-agent.md](04-desktop-agent.md)             | Tauri/Rust architecture, sync engine, offline   |
| [05-queue-architecture.md](05-queue-architecture.md)   | BullMQ queues, jobs, retries, DLQ                |
| [06-reporting.md](06-reporting.md)                     | Rollups, materialized views, exports             |
| [07-storage.md](07-storage.md)                         | S3 layout, thumbnails, retention, CDN            |
| [08-security.md](08-security.md)                       | RBAC, encryption, audit, device trust            |
| [09-deployment.md](09-deployment.md)                   | Docker, Nginx, Ubuntu, CI/CD                     |
| [10-scaling.md](10-scaling.md)                         | Capacity model, cost estimates                   |
| [11-roadmap.md](11-roadmap.md)                         | MVP, Phase 2, Phase 3                            |
| [12-monorepo.md](12-monorepo.md)                       | Turborepo + pnpm layout, all apps/packages       |
