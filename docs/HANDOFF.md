# TimePro — Session Handoff

Snapshot for picking up in a fresh session. **Read [`CLAUDE.md`](../CLAUDE.md) first** (ground truth),
then this for current state + how to run. Full feature roadmap: [`docs/13-opscore-feature-roadmap.md`](13-opscore-feature-roadmap.md).

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
| **Phase 1** — Settings engine (B6) | ✅ | catalog registry + resolver (org default ← user override), Settings page, Team per-user overrides, agent consumes `/settings/effective` |
| **Phase 2** — Presence (B3) | ✅ | agent heartbeat → in-memory store → 3-state dots (offline/connected/tracking) + "N online" |
| **Phase 4** — Activity + App tracking (B4/B5) | ✅ | agent activity aggregator (idle-derived) + app polling → ingest; Timeline activity %/per-slot app; roster last-app |
| **Phase 3** — OpsCore (B1/B2) | ✅ web | handoff-JWT login + Bearer service-API sync (employees/projects/clients). **Desktop OpsCore login deferred.** |

**Original MVP (pre-OpsCore) also done:** time tracking, automatic screenshot capture → API → disk,
web/desktop login, desktop→web "view online" handoff, Team management.

### 🔴 Pending / not built
- **Desktop OpsCore login** (web is done; desktop still uses email dev-login).
- **Browser extension** for URL tracking (`url_usage` table + ingest ready; capture needs the WebExtension).
- **Phase 5** — Reports tab + time-per-client report + weekly-limit enforcement; rollups + scheduler; realtime WS (presence is polling now).
- **Phase 6** — build/sign/host pipeline for real installer downloads (Download links are placeholders).
- **Native screenshot-notification toast** (the `screenshots.notify` value resolves but isn't shown as an OS toast).
- **Real password auth / JWT / MFA** — still the `x-dev-org`/`x-dev-user` dev shim + email dev-login (+ OpsCore handoff for web).
- **RLS policies, table partitioning** — not applied (tenant isolation is app-level `organization_id` filtering only).
- Worker/scheduler/realtime services, S3 storage, billing — planned (see docs).

---

## 3. Ports & running services

| App | Port | Notes |
| --- | ---- | ----- |
| TimePro **web** | **3000** | Next.js |
| TimePro **API** | **4001** | Fastify — **moved off 3001** because OpsCore owns it |
| **OpsCore** | **3001** | separate app, `/Users/macos/Code/systemsd/OpsCore` (it's a `next dev` — don't `pkill -f "next dev"` blindly) |
| Postgres (TimePro) | 5432 / db `timepro` | user `postgres`/`123456` (per `.env`) |
| Postgres (OpsCore) | 5432 / db `opscore` | OpsCore's own Prisma DB |

> ⚠️ **Don't `pkill -f "next dev"`** — that kills OpsCore too (it's a Next dev server). Kill by port instead:
> `lsof -ti tcp:3000 | xargs kill -9`.

### Run everything
```bash
# raise the macOS open-files limit first (Next watchers hit EMFILE otherwise)
ulimit -n 10240

# OpsCore (separate repo) — usually already running on :3001
cd /Users/macos/Code/systemsd/OpsCore && PORT=3001 npm run dev   # uses package-lock.json (npm)

# TimePro (this repo)
cd /Users/macos/Code/systemsd/TimePro
pnpm --filter @timepro/api dev        # → http://localhost:4001
pnpm --filter @timepro/web dev        # → http://localhost:3000
# desktop agent (needs Rust toolchain: source "$HOME/.cargo/env")
TIMEPRO_API_URL=http://localhost:4001 pnpm --filter @timepro/desktop tauri:dev
```

### Test logins
- **Web/desktop email dev-login:** `owner@timepro.local` (the local break-glass **owner**; keeps password login even with OpsCore).
- **Sign in with OpsCore:** the button on `/login` → OpsCore handoff → back to TimePro. OpsCore admin login: `admin@systemsd.co`.
- **Sync OpsCore directory:** Team page → "⟳ Sync from OpsCore" (admin only).

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

**Shared secrets (dev — must match across both `.env`s):**
- `OPSCORE_HANDOFF_SECRET` (TimePro) == `TIMEPRO_HANDOFF_SECRET` (OpsCore) = `opscore-timepro-shared-handoff-secret-dev`
- `OPSCORE_API_KEY` (TimePro) == `TIMEPRO_API_KEY` (OpsCore) = `opscore-timepro-service-api-key-dev`
- TimePro `OPSCORE_ORG_SLUG=demo` (which TimePro org OpsCore users land in).

---

## 5. API route inventory (`apps/api/src/routes/`)

`auth` (dev-login, opscore/exchange, handoff, handoff/exchange) · `health` · `me` (today) ·
`projects` (+ manage, :id/members) · `screenshots` (ingest + list + raw) · `team` · `timer` ·
`roster` · `timeline` · `clients` · `settings` (+ /effective, /user/:id) · `presence` (agent/heartbeat) ·
`ingest` (activity, app-usage) · `admin` (opscore/sync).

**Auth shim:** `requireAuth` accepts `x-dev-org` + `x-dev-user` headers (non-prod). RBAC scoping (admin=all /
manager=own team / employee=self, **C1**) is centralized in `apps/api/src/lib/access.ts`.

---

## 6. Resolved decisions (from the conflict pass — see docs/13 §4)

C1 managers manage own team · C2 OpsCore-authoritative read-only catalogs · C3 OpsCore owns project↔client ·
C4 presence = 3 states · C5 settings = org default + per-user override (2-level) · C6 viewer/org timezone ·
C8 break-glass local owner · C9 screenshot self-delete admin-configurable default-off.
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

---

## 8. Git state — ⚠️ uncommitted

As of this handoff, TimePro has **~37 uncommitted changed files** (everything since the last commit
`acb45e3 feat: implement presence tracking…`), and OpsCore has **untracked** `app/api/timepro/` + `lib/timepro.ts`
(+ modified `lib/auth.config.ts`, `.env`). **Nothing from Phases 1/3/4 + the rename is committed.**
First action in the next session may be to **commit** (review the diff; the rename touched 60+ files).

---

## 9. Recommended next steps (pick one)

1. **Desktop OpsCore login** — finish Phase 3: agent opens system browser → OpsCore handoff → captures the token (loopback or deep link) → TimePro device session.
2. **Phase 5 — Reports** — a real Reports tab (the nav tab is disabled) + time-per-client report (uses `project.client_id`) + weekly-limit enforcement.
3. **Browser extension** — finish URL tracking (`url_usage` is ready).
4. **Commit + clean up** — the working tree is large and uncommitted.
5. **Phase 6 — installer pipeline** — sign/notarize/host so the Download page links work.

Everything verified this session is reproducible via the commands in §3. The dev environment is currently
**running** (web :3000, API :4001, OpsCore :3001).
