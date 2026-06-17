# TimePro — Project Brief & Status

_Snapshot: 2026-06-16. Living docs: [HANDOFF](HANDOFF.md) (run/resume), [docs/13](13-opscore-feature-roadmap.md) (roadmap), [feature-matrix](feature-matrix.md) (per-role)._

## Brief

**TimePro** is a multi-tenant employee time-tracking + screenshot-monitoring platform
(Hubstaff / Time Doctor class). Three surfaces over one REST API:

- **Web console** (Next.js 14) — dashboard, roster, Timeline, Team, Projects/Clients, Reports, Settings.
- **Desktop agent** (Tauri 2 + Rust) — time tracking, screenshot + activity + app capture.
- **API** (Fastify + Drizzle/Postgres) — all endpoints; org-scoped via `withTenant`.

Identity comes from **OpsCore** (a separate per-company system) via a **handoff-JWT login** (not OIDC) +
a Bearer service-API directory sync. Monorepo: Turborepo + pnpm, Node 20. Ports: web **3005** (off 3000 to avoid
the prod-OpsCore nginx rewriting the handoff redirect), API **4001**. Sign-in is wired to **production OpsCore**
(`https://opscore.systemsd.co`) and verified working.

## Status at a glance

**Phases 0–5 complete.** Core product works end-to-end: tracking, screenshots (native OS toast gated by
`screenshots.notify`), Settings engine, realtime presence, activity/app/URL tracking, the Reports console
(saved reports, CSV/PDF, weekly-limit enforcement), and **OpsCore sign-in wired to production and verified**.

Recent UI / behavior:
- **Manager dashboard** = 4-column team roster overview (today/yesterday/week/month).
- **Employee dashboard** = company-row table (org name + role badge + last-active + period totals), powered by the now self-scoped `/v1/roster`.
- **Timeline** carries the **calendar day-strip** date nav (per-user activity dots + `00h 00m` hover tooltip); clicking a screenshot opens a **lightbox** with prev/next.
- **Desktop**: project picker is **member-scoped** (only your active assignments); timer colon "beats" while tracking.
- **OpsCore sync** auto-disables members no longer in the directory (→ suspended; re-activates returners).
- **Reports**: Clients/Projects filter dropdowns hidden for employees.
- **My Account** (`/account`) via the avatar dropdown (Dashboard · My Account · Log out).
- UI uses line icons, no emojis. Login is OpsCore-only.

**All earlier spec conflicts (C1–C9) are resolved** — C7 settled by the two distinct surfaces:
`/account` (per-user) vs `/settings` (org-scoped, admin).

| Phase | Scope | Status |
| ----- | ----- | ------ |
| **0** | Quick wins — roster, Timeline, Projects/Clients, RBAC, ☰ menu | ✅ Done |
| **1** | Settings engine (B6) — registry + resolver + per-user overrides | ✅ Done |
| **2** | Presence (B3) — heartbeat → 3-state dots | ✅ Done |
| **3** | OpsCore (B1/B2) — web handoff login + sync + **desktop loopback login** | ✅ Done |
| **4** | Activity + App + **URL** tracking (B4/B5) — ingest + reporting + browser extension | ✅ Done |
| **5** | Reports + realtime (B7/B10) — console, saved reports, CSV/PDF, **weekly-limit enforcement**, presence WS | ✅ Done |
| **6** | **Multi-tenancy & real auth** | ⏸️ Paused (single-tenant focus) |
| **7** | Ship pipeline (B9) — build/sign/host installers | 🔴 Not started |
| **8** | Scale & storage — rollups, S3, worker/realtime | 🔴 Not started |
| **9** | Billing & plans | 🔴 Not started |
| **P** | Polish & UX | 🟡 2 of 4 |

## Pending work (detail)

- **Phase 6 — Multi-tenancy & real auth** *(PAUSED — single-tenant Systemsd is the current focus)*: one shared DB, many orgs.
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

No seed script — data populates at runtime from OpsCore. The first production OpsCore sign-in already
**JIT-created the `Systemsd` org + the `Hamid` admin**; run Team → **Sync from OpsCore** to pull the rest of
the directory (employees/projects/clients). Latest migration `0004_saved_reports`. (Earlier in the session
all `public` tables were truncated for a clean multi-tenant start; the prod login has since seeded the one org.)

## ⚠️ Verification gaps

**Verified live:**
- **Web OpsCore sign-in** against production (browser flow → `/dashboard`); handoff exchange + **JIT org** (`Systemsd`/`Hamid`); `/v1/me/profile`; CORS for `:3005`.
- **Desktop agent end-to-end against prod** — OpsCore **loopback login**, directory synced (15 real employees), timer tracking, **real screen capture (3456×2234) → upload → disk**, settings/heartbeat/activity/app ingest. All agent endpoints curl-verified 200.

Built and typecheck/`cargo check`-clean but **layout not eyeballed in a browser this session** (API paths verified by curl):

- Manager 4-column roster, **employee company-row dashboard**, Timeline **calendar strip** (+ dots), Reports employee gating.
- Reports console, realtime presence dots, weekly-limit UI, My Account page + avatar dropdown + line icons.
- Browser extension (manifest/JS valid; not loaded in Chrome).

## Run (dev)

```bash
ulimit -n 10240
pnpm --filter @timepro/api dev    # :4001
pnpm --filter @timepro/web dev    # :3005
# desktop (needs Rust): TIMEPRO_API_URL + TIMEPRO_WEB_URL for OpsCore login
source "$HOME/.cargo/env"
TIMEPRO_API_URL=http://localhost:4001 TIMEPRO_WEB_URL=http://localhost:3005 \
  pnpm --filter @timepro/desktop tauri:dev
```
