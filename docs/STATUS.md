# TimePro — Project Brief & Status

_Snapshot: 2026-06-15. Living docs: [HANDOFF](HANDOFF.md) (run/resume), [docs/13](13-opscore-feature-roadmap.md) (roadmap)._

## Brief

**TimePro** is a multi-tenant employee time-tracking + screenshot-monitoring platform
(Hubstaff / Time Doctor class). Three surfaces over one REST API:

- **Web console** (Next.js 14) — dashboard, roster, Timeline, Team, Projects/Clients, Reports, Settings.
- **Desktop agent** (Tauri 2 + Rust) — time tracking, screenshot + activity + app capture.
- **API** (Fastify + Drizzle/Postgres) — all endpoints; org-scoped via `withTenant`.

Identity comes from **OpsCore** (a separate per-company system) via a **handoff-JWT login** (not OIDC) +
a Bearer service-API directory sync. Monorepo: Turborepo + pnpm, Node 20. Ports: web **3000**, API **4001**,
OpsCore **3001**.

## Status at a glance

**Phases 0–5 complete.** Core product works end-to-end: tracking, screenshots (native OS toast gated by
`screenshots.notify`), role-aware home + roster, Timeline, Settings engine, presence (realtime), activity/app/URL
tracking, OpsCore login (web + desktop), the Reports console (saved reports, CSV/PDF, weekly-limit enforcement),
and a per-user **My Account** page (`/account`) reached from the avatar dropdown (Dashboard · My Account · Log out).
The UI uses line icons, no emojis. **All earlier spec conflicts (C1–C9) are resolved** — C7 settled by the two
distinct surfaces: `/account` (per-user) vs `/settings` (org-scoped, admin).

| Phase | Scope | Status |
| ----- | ----- | ------ |
| **0** | Quick wins — roster, Timeline, Projects/Clients, RBAC, ☰ menu | ✅ Done |
| **1** | Settings engine (B6) — registry + resolver + per-user overrides | ✅ Done |
| **2** | Presence (B3) — heartbeat → 3-state dots | ✅ Done |
| **3** | OpsCore (B1/B2) — web handoff login + sync + **desktop loopback login** | ✅ Done |
| **4** | Activity + App + **URL** tracking (B4/B5) — ingest + reporting + browser extension | ✅ Done |
| **5** | Reports + realtime (B7/B10) — console, saved reports, CSV/PDF, **weekly-limit enforcement**, presence WS | ✅ Done |
| **6** | **Multi-tenancy & real auth** *(next)* | 🔴 Not started |
| **7** | Ship pipeline (B9) — build/sign/host installers | 🔴 Not started |
| **8** | Scale & storage — rollups, S3, worker/realtime | 🔴 Not started |
| **9** | Billing & plans | 🔴 Not started |
| **P** | Polish & UX | 🟡 2 of 4 |

## Pending work (detail)

- **Phase 6 — Multi-tenancy & real auth** *(recommended next; agreed direction)*: one shared DB, many orgs.
  - 6.1 Real auth — Argon2 passwords + signed **JWT** (cookie + bearer); retire the `x-dev-*` dev shim.
  - 6.2 Org onboarding — `signup` creates org + first owner; real invites. _(Open: multi-org membership? public signup vs invite-only?)_
  - 6.3 Per-org OpsCore SSO — move OpsCore config off global env to per-org; route by org.
  - 6.4 RLS hardening — fail-closed Postgres RLS + app/BYPASSRLS DB role split.
  - 6.5 Tenant audit & UX — sweep raw `getDb()` usage; org context/switcher; isolation tests.
- **Phase 7 — Ship pipeline (B9)**: cross-platform CI builds, code-sign/notarize, host artifacts, wire Download URLs. _Credential-gated (Apple/Windows certs + hosting)._
- **Phase 8 — Scale & storage**: 8.1 reporting rollups + scheduler (B8) · 8.2 S3 storage + thumbnails · 8.3 worker/realtime services + Redis-backed presence.
- **Phase 9 — Billing & plans**: seat/plan enforcement, metering, invoicing.
- **Phase P — Polish**: ✅ native screenshot toast · ✅ desktop "weekly limit reached" message · 🔴 keyboard/mouse activity counts · 🔴 Reports shareable links.

_Deferred/cut: B8 rollups → Phase 8.1; absence model cut (only needed for the optional Weekly "Include absences" toggle)._

## Database

All `public` tables **truncated** (0 rows) for a clean multi-tenant start; schema and Drizzle migration
journal intact (latest migration `0004_saved_reports`). New companies populate at runtime: first OpsCore
login JIT-creates the org (`OPSCORE_ORG_SLUG`/`OPSCORE_ORG_NAME`), then Team → Sync from OpsCore pulls the
directory. No seed script.

## ⚠️ Verification gaps

Built and typecheck/`cargo check`-clean, but **not exercised in a live runtime this session** (no connected
browser / Tauri GUI / Chrome):

- Reports console, realtime presence dots, weekly-limit UI (API paths verified by curl).
- My Account page + avatar dropdown + line icons (typecheck-clean, `/account` 200, `/v1/me/profile` verified live; layout/hover not eyeballed).
- Desktop OpsCore loopback login + the two Phase P items (compile + API proven; round-trip not run).
- Browser extension (manifest/JS valid; not loaded in Chrome).
- JIT org creation (typecheck-verified; not live-run — didn't disturb existing data).

## Run (dev)

```bash
ulimit -n 10240
pnpm --filter @timepro/api dev    # :4001
pnpm --filter @timepro/web dev    # :3000
# desktop (needs Rust): TIMEPRO_API_URL + TIMEPRO_WEB_URL for OpsCore login
source "$HOME/.cargo/env"
TIMEPRO_API_URL=http://localhost:4001 TIMEPRO_WEB_URL=http://localhost:3000 \
  pnpm --filter @timepro/desktop tauri:dev
```
