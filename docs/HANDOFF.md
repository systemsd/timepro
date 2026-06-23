# TimePro — Session Handoff

Snapshot for picking up in a fresh session. **Read [`CLAUDE.md`](../CLAUDE.md) first** (ground truth),
then this for current state + how to run. Full feature roadmap: [`docs/13-opscore-feature-roadmap.md`](13-opscore-feature-roadmap.md).

---

## 🚧 CURRENT STATE (2026-06-23) — Live product: auto-update + agent diagnostics

> Backend + downloads have been LIVE since 2026-06-18 (prod `timepro.systemsd.co` / `api.timepro.systemsd.co`,
> push-to-`main` auto-deploy). The recent arc has been **shipping/operating the desktop app**: auto-update,
> remote diagnostics, and chasing field issues. Historical deploy/download detail: [`docs/14-deploy-and-download-progress.md`](14-deploy-and-download-progress.md).

### How the user (Anas) works
- **Role:** the developer. On **prod he is an `employee`**, NOT org-admin (admin is Hamid).
- **Commits:** Conventional Commits, **no AI/Claude attribution** in messages.
- **Flow:** always work on a **branch**, push it; **the user merges the PR himself** — never commit to `main`.
- **Desktop releases are version-driven:** every desktop change MUST bump `version` in
  `apps/desktop/src-tauri/tauri.conf.json`. Merging to `main` builds + publishes a release **only when the
  version bumped** (`desktop-release.yml` `version-check` job skips otherwise).
- **Verify before pushing:** `pnpm --filter @timepro/<pkg> typecheck`, web `build`, and `cargo check`
  (`apps/desktop/src-tauri`) for agent changes. **After the user merges + publishes, verify the result — don't assume.**

### Shipped this arc (current desktop version on `main` = **v0.1.7**)
- **In-app auto-updater** (Tauri `tauri-plugin-updater`): app polls
  `systemsd/timepro-downloads/releases/latest/download/latest.json` on launch → prompts → installs → relaunches.
  Updater signing key at `~/.tauri/timepro_updater.key`; GitHub secret **`TAURI_SIGNING_PRIVATE_KEY`**.
  The CI signs updater archives + generates `latest.json` (macOS archives get an
  arch suffix to avoid collision). Flow: bump version → merge → publish the **draft** Release → users auto-update.
- **Server-side per-user agent logs + Diagnostics console.** Agents ship `tracing` INFO/WARN/ERROR to
  `POST /v1/ingest/agent-logs` (table `agent_logs`, 14-day retention). Read at **`/diagnostics`** (web) or
  `GET /v1/admin/agent-logs`. Logs include **name/email** (join), the **real release version**, and `timer
  started/stopped` · `screenshot cadence updated` · `opscore login exchange_ms` events.
- **Developer diagnostics access:** Anas (an `employee`) is on an allowlist baked in
  `apps/api/src/routes/admin.ts` (`DIAGNOSTICS_DEVELOPERS`, extendable via `DIAGNOSTICS_ALLOWED_USERS` env), so
  he can read all agent logs without org-admin.
- Earlier same arc: screenshot upload reliability (downscale ≤1440px), idle auto-pause UI sync, Timeline **Tasks**
  tab (default), Week/Month → Reports deep-links, favicon.

### Debug an agent (copy-paste)
```
curl "https://api.timepro.systemsd.co/v1/admin/agent-logs?limit=500" \
  -H "x-dev-org: 019eda21-7563-7aa7-b27c-b8c4fa3851f9" \
  -H "x-dev-user: 019eda21-9c83-7aa7-b27d-805cdf5aa684"     # Anas (allowlisted)
```

### Known hot gotcha — macOS Screen Recording + unsigned builds
Installers are **UNSIGNED**. macOS ties Screen Recording permission to the exact binary, so **every update revokes
it** → screenshots silently go **wallpaper-only** until the user **removes the stale TimePro entry** in System
Settings → Screen Recording, re-adds it, and quits/reopens. Fresh installs are fine (grant on first launch).
**Permanent fix = code-signing + notarization (Apple Developer ID).** Also: agent log `screenshot capture failed
{"error":"no monitor available"}` = display asleep/locked, not a bug.

### Backlog (ask the user which to start)
1. **In-app permission prompt/banner** (Screen Recording + Accessibility) — no deps, high value.
2. **Code-signing + notarization** (needs the user's Apple Developer account) — permanent fix for the gotcha above.
3. `no monitor available` → log as "display asleep/locked" (not an error).
4. **Changelog / "What's new" on the web app** (Hamid's ask #3).
5. Keyboard/mouse activity counts; system-tray indicator; re-enable the Linux build leg (`libgbm-dev` staged).
- Loose ends: uncommitted "downloads-live" doc edits in the working tree; confirm prod `WEB_PUBLIC_URL` (the
  view-online → localhost fix) actually landed.

**Untouched pre-existing changes (leave them):** `apps/web/src/app/login/page.tsx` (modified) + `List`, `SETUP-FOR-HAMID.md` (stray, untracked).

---

## 1. What this is

TimePro — employee time-tracking + screenshot monitoring (Hubstaff/Time-Doctor/ScreenshotMonitor class).
Three surfaces: **web console** (Next.js), **desktop agent** (Tauri/Rust), **REST API** (Fastify).
Integrated with **OpsCore** (a separate Next.js app) as the upstream identity + directory system.

Monorepo: Turborepo + pnpm, Node 20. Apps: `api`, `web`, `desktop`. Packages: `db`, `tsconfig`, `eslint-config`.

---

## 2. Build status — phase scoreboard

| Phase | Status | What's working |
| ----- | ------ | -------------- |
| **Phase 0** — quick wins | ✅ | role-aware My Home roster, employee Timeline, Projects/Clients pages, Download page, ☰ menu, RBAC scoping (C1) |
| **Phase 1** — Settings engine (B6) | ✅ | catalog registry + resolver (org default ← user override), Settings page, Team per-user overrides, agent consumes `/settings/effective`. **Enforced:** screenshots (enabled/per-hour/blur=always/notify), activity + app/URL tracking, idle auto-pause, weekly limit (server). Only `time.allow_offline` unbuilt. |
| **Phase 2** — Presence (B3) | ✅ | agent heartbeat → in-memory store → 3-state dots (offline/connected/tracking) + "N online" |
| **Phase 4** — Activity + App + URL tracking (B4/B5) | ✅ | agent activity aggregator (idle-derived) + app polling → ingest; Timeline activity %/per-slot app; roster last-app; **URL** ingest + Reports "Apps & URLs" + browser extension (`apps/extension`) |
| **Phase 3** — OpsCore (B1/B2) | ✅ web + desktop | handoff-JWT login + Bearer service-API sync. **Desktop OpsCore login done** (loopback flow via the web `/desktop-auth` bridge). |
| **Phase 5** — Reports + realtime (B7/B10) | ✅ | Reports console (query API, UI, saved reports, CSV/PDF), **weekly-limit enforcement**, realtime presence WS. (B8 rollups deferred; absences cut.) |

**Original MVP (pre-OpsCore) also done:** time tracking, automatic screenshot capture → API → disk,
web/desktop login, desktop→web "view online" handoff, Team management.

**Recent UI / behavior:** **Manager dashboard** = 4-column team roster overview · **Employee dashboard** =
company-row table (org + role badge + last-active + period totals; `/v1/roster` is now self-scoped for employees) ·
**Timeline** redesigned Hubstaff-style: month strip with per-day **activity bars** + weekday labels (weekends red) +
yellow selected day · **summary card** (date · big day total · Week/Month/Activity) with an **Apps/URLs** usage panel +
prev/next day stepper + **average-activity donut** (+ dot/tooltip) · **24h ruler** with green **run/stop bars** from real
tracked intervals (`timeline/:id` returns `intervals[]`) · screenshot slots (red time-range + app badge + thumbnails,
**trash to delete** [C9]); clicking a thumbnail opens a **lightbox** with prev/next (← →) · **screenshot retention**
auto-prunes old screenshots (default 3 months) · desktop timer colon "beats" while tracking · desktop **project picker
is member-scoped** (only your active assignments) · **OpsCore sync disables members absent from the directory** (→
suspended) · **My Account** page (`/account`) + avatar dropdown (Dashboard · My Account · Log out) · **Reports** has a
Hubstaff-style filter bar (preset grid, type links, group-by chips) + hides Clients/Projects dropdowns for employees ·
login is **OpsCore-only** · line icons, no emojis.
**Desktop agent verified end-to-end against prod** (loopback login → directory → track → real capture → upload).

### 🔴 Pending — phased (full detail in [docs/13 §3](13-opscore-feature-roadmap.md))
- **Phase 6 — Multi-tenancy & real auth** *(⏸️ PAUSED — single-tenant Systemsd is the current focus)*: one shared DB, many orgs. 6.1 real auth (Argon2 + JWT, retire the `x-dev-*` shim) · 6.2 org onboarding/signup + invites · 6.3 per-org OpsCore SSO (config moves off global env) · 6.4 RLS fail-closed + DB role split · 6.5 tenant audit + org-context UX. *Folds in the old "real auth / MFA" and "RLS / partitioning" items.*
- **Phase 7 — Ship pipeline (B9)**: cross-platform CI builds, code-sign/notarize, host artifacts, wire Download URLs. *Credential-gated.*
- **Phase 8 — Scale & storage**: 8.1 reporting rollups + scheduler (B8) · 8.2 S3 storage + thumbnails · 8.3 worker/realtime services + Redis-backed presence.
- **Phase 9 — Billing & plans**.
- **Phase P — Polish & UX** *(small, anytime)*: ✅ native screenshot-notification toast (`tauri-plugin-notification`, gated by `screenshots.notify`) · ✅ desktop "weekly limit reached" message on the `timer/start` 409 · ✅ idle auto-pause (`tracking.auto_pause_minutes`) + `screenshots.blur=always` enforcement · 🔴 keyboard/mouse activity counts · 🔴 Reports shareable links. *(Agent bits ✅ compile via `cargo check`; not yet run in the GUI.)*

---

## 3. Ports & running services

| App | Port | Notes |
| --- | ---- | ----- |
| TimePro **web** | **3005** | Next.js — **moved off 3000** so the prod-OpsCore nginx doesn't rewrite the handoff redirect |
| TimePro **API** | **4001** | Fastify — **moved off 3001** because OpsCore owns it |
| **OpsCore** | **3001** | separate app, `/Users/macos/Code/systemsd/OpsCore` (it's a `next dev` — don't `pkill -f "next dev"` blindly) |
| Postgres (TimePro) | 5432 / db `timepro` | user `postgres`/`123456` (per `.env`) |
| Postgres (OpsCore) | 5432 / db `opscore` | OpsCore's own Prisma DB |

> ⚠️ **Don't `pkill -f "next dev"`** — that kills OpsCore too (it's a Next dev server). Kill by port instead:
> `lsof -ti tcp:3005 | xargs kill -9` (web) / `lsof -ti tcp:4001 | xargs kill -9` (API).

### Run everything
```bash
# raise the macOS open-files limit first (Next watchers hit EMFILE otherwise)
ulimit -n 10240

# OpsCore (separate repo) — usually already running on :3001
cd /Users/macos/Code/systemsd/OpsCore && PORT=3001 npm run dev   # uses package-lock.json (npm)

# TimePro (this repo)
cd /Users/macos/Code/systemsd/TimePro
pnpm --filter @timepro/api dev        # → http://localhost:4001
pnpm --filter @timepro/web dev        # → http://localhost:3005
# desktop agent (needs Rust toolchain: source "$HOME/.cargo/env")
TIMEPRO_API_URL=http://localhost:4001 TIMEPRO_WEB_URL=http://localhost:3005 pnpm --filter @timepro/desktop tauri:dev
```

### Test logins
- **Sign in with OpsCore (only real path; login is OpsCore-only — email/password fields removed):** the button on `/login` → OpsCore handoff → back to TimePro. **✅ Wired to PRODUCTION OpsCore (`https://opscore.systemsd.co`) and verified working** (signs in as `Hamid`, admin, org `Systemsd`). The **first** OpsCore login JIT-creates the org (`OPSCORE_ORG_SLUG=demo`/`OPSCORE_ORG_NAME=Systemsd`). **No `db:seed`, no local break-glass owner** (C8 superseded).
  - Web's OpsCore target: `apps/web/.env.local` → `NEXT_PUBLIC_OPSCORE_URL=https://opscore.systemsd.co`. Shared `OPSCORE_HANDOFF_SECRET`/`OPSCORE_API_KEY` (root `.env`) match prod OpsCore's `TIMEPRO_HANDOFF_SECRET`/`TIMEPRO_API_KEY`.
  - **OpsCore side must set `TIMEPRO_URL=http://localhost:3005`** (the TimePro web port) + restart — else nginx rewrites the redirect (see §7 gotcha).
- **Email dev-login (`/v1/auth/dev-login`):** non-prod shim, **UI removed** but route kept — works for any **already-synced** user's email.
- **Sync OpsCore directory:** Team page → "⟳ Sync from OpsCore" (admin only) pulls employees/projects/clients.

---

## 4. OpsCore integration (Phase 3) — the important one

**Key fact:** OpsCore is **NOT an OIDC provider** — it's Auth.js v5 (NextAuth) credentials + JWT. So we use
its **handoff-JWT** pattern (same one it ships for "LandingPro"), not OIDC.

**Auth flow (web):** OpsCore `/api/timepro/handoff` (session-gated) mints a 60s HS256 JWT → redirects to
TimePro `/auth/opscore?token=…` → web POSTs to `/v1/auth/opscore/exchange` → API verifies (shared secret),
JIT-creates user + membership (role-mapped) → session in `localStorage`.

**Directory sync:** OpsCore exposes Bearer-authed `GET /api/timepro/sync/{employees,projects,business-partners}`.
TimePro `POST /v1/admin/opscore/sync` (admin) pulls + upserts, keyed on `opscore_*_id`. Role map:
`ADMIN→admin`, `*_MANAGER→manager`, else `employee`. Project↔client comes from OpsCore's `business_partner_id` (C3).
Verified counts: **10 active employees, 18 business partners, 19 projects**.

**Files added:**
- OpsCore: `lib/timepro.ts`, `app/api/timepro/handoff/route.ts`, `app/api/timepro/sync/{employees,projects,business-partners}/route.ts`; edited `lib/auth.config.ts` (allowlist `/api/timepro/sync`); `.env` + `.env.example` (`TIMEPRO_URL`, `TIMEPRO_HANDOFF_SECRET`, `TIMEPRO_API_KEY`).
- TimePro: `apps/api/src/lib/opscore.ts`, `routes/auth.ts` (exchange), `routes/admin.ts` (sync); web `app/auth/opscore/page.tsx`, login button, Team sync button; `opscore_employee_id`/`opscore_project_id` columns (migration `0003`).

**Shared secrets (must match across both `.env`s):**
- `OPSCORE_HANDOFF_SECRET` (TimePro) == `TIMEPRO_HANDOFF_SECRET` (OpsCore) = `opscore-timepro-shared-handoff-secret-dev`
- `OPSCORE_API_KEY` (TimePro) == `TIMEPRO_API_KEY` (OpsCore) = `opscore-timepro-service-api-key-dev`
- TimePro `OPSCORE_ORG_SLUG=demo`, `OPSCORE_ORG_NAME=Systemsd` (the org JIT-created on first login).

**✅ Production wiring (verified):** web `apps/web/.env.local` → `NEXT_PUBLIC_OPSCORE_URL=https://opscore.systemsd.co`;
prod OpsCore `.env` → `TIMEPRO_URL=http://localhost:3005` (the TimePro web port — **must not be 3000**, see §7 nginx gotcha)
+ the two shared secrets above. First prod login JIT-created the `Systemsd` org + `Hamid` (admin). The handoff token
verifies locally (signature only) — sign-in does **not** call `OPSCORE_API_URL`; that's only for the directory sync.

---

## 5. API route inventory (`apps/api/src/routes/`)

`auth` (dev-login, opscore/exchange, handoff, handoff/exchange) · `health` · `me` (today, profile) ·
`projects` (list is **member-scoped** to the caller's active assignments; + manage, :id/members) · `screenshots` (ingest + list + raw + **DELETE `:id`**, C9-gated) ·
`team` · `timer` · `roster` (self-scoped for employees) · `timeline` (+ `:userId/activity` for the strip bars, `:userId/apps-urls` for the summary panel) · `clients` ·
`settings` (+ /effective, /user/:id) · `presence` (agent/heartbeat) · `ingest` (activity, app-usage, url-usage) ·
`admin` (opscore/sync — **disables members absent from the response**, re-activates returners; **screenshots/prune**) · `reports` (filters [no clients/projects for employees], run, saved CRUD) · `realtime` (ws presence).

**Auth shim:** `requireAuth` accepts `x-dev-org` + `x-dev-user` headers (non-prod). RBAC scoping (admin=all /
manager=own team / employee=self, **C1**) is centralized in `apps/api/src/lib/access.ts`.

---

## 6. Resolved decisions (from the conflict pass — see docs/13 §4)

C1 managers manage own team · C2 OpsCore-authoritative read-only catalogs · C3 OpsCore owns project↔client ·
C4 presence = 3 states · C5 settings = org default + per-user override (2-level) · C6 viewer/org timezone ·
C8 break-glass local owner · C9 screenshot self-delete admin-configurable default-off — **implemented**: `DELETE /v1/screenshots/:id` (row + file) gated by the `screenshots.allow_self_delete` setting (default off); admins/managers may delete any screenshot of someone they manage. Timeline thumbnails have a trash button.
**C7 (My Account vs Settings) is the one still-open conflict** (assumed: separate owner-only area later).

---

## 7. Gotchas (hard-won)

- **pnpm 9 has no `--env-file`** → scripts load root `.env` via `loadRootEnv()` helpers, not `import 'dotenv/config'`.
- **`pkill -f "next dev"` kills OpsCore.** Kill TimePro web by port.
- **Raise `ulimit -n`** before starting Next dev or you get `EMFILE: too many open files`.
- **Migrations bootstrap `citext`/`pgcrypto`** (in `migrate.ts`); they're **expand-only / forward-only**.
- **Desktop API base is baked at build** (`apps/desktop/src-tauri/src/state.rs` → `PRODUCTION_API_BASE`); change before building installers.
- **Sandbox quirk:** raw `sed -i`/in-place writes from a shell *loop* sometimes get blocked here — single `perl -pi` over all files works. Use `dangerouslyDisableSandbox` for DB/psql/file-write shell ops.
- **psql path:** `/opt/homebrew/bin/psql` (not always on PATH in the sandbox).
- **Web is :3005 because of the prod-OpsCore nginx.** Prod OpsCore is behind nginx with its own app on `:3000`;
  nginx rewrites `Location: http://localhost:3000/…` (its upstream) to `https://opscore.systemsd.co`. If TimePro
  web were on 3000, the OpsCore→TimePro handoff redirect gets clobbered → lands on OpsCore's domain → 404. Fix:
  web on **3005**, OpsCore `TIMEPRO_URL=http://localhost:3005`, `API_CORS_ORIGINS` includes `:3005`. Diagnose a
  recurrence with `curl -sI <opscore>/api/timepro/handoff -b <cookie> | grep -i location`.
- **Web env lives in `apps/web/.env.local`, not root `.env`.** Next reads env from `apps/web/`; root `.env`
  `NEXT_PUBLIC_*` lines are ignored by the web. `NEXT_PUBLIC_*` are inlined at startup → restart `next dev` after edits.

---

## 8. Git state

- **TimePro: committed & clean.** `main` @ `0002431 feat: implement OpsCore integration…`
  (Phases 1/3/4 + the TrackFlow→TimePro rename are in history).
- ⚠️ **OpsCore: still has uncommitted files** — the integration I added:
  `app/api/timepro/` (handoff + sync routes), `lib/timepro.ts`, edited `lib/auth.config.ts`, and `.env`.
  These need committing in the OpsCore repo or they'll be lost on a fresh checkout/reset.

---

## 9. Recommended next steps

Phases 0–5 are done; **Phase 6 (multi-tenancy) is PAUSED** — the focus is the single-tenant Systemsd product,
which is **live against production OpsCore and verified end-to-end** (web + desktop). Sensible next work:

1. **Verify & polish the built UIs** in a browser (employee dashboard, Timeline strip + screenshot modal, Reports, My Account) + remaining **Phase P** wins (keyboard/mouse activity counts, Reports shareable links).
2. **Phase 7 — Ship pipeline** — installer sign/notarize/host so the agent can be distributed (needs signing creds + hosting).
3. **Phase 8 / 9** — scale & storage (rollups, S3), then billing — only when needed.
4. **Phase 6 (multi-tenancy)** — resume if/when going multi-company (real auth + onboarding + RLS).

> **DB note:** the production OpsCore login + sync populated the `Systemsd` org (employees/projects/clients); the migration journal is intact.

Everything verified this session is reproducible via the commands in §3.
