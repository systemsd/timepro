# CLAUDE.md

Guidance for Claude Code when working in this repository.

> **TimePro** — a multi-tenant employee time-tracking + screenshot-monitoring platform
> (à la Hubstaff / Time Doctor / ScreenshotMonitor). Web console, desktop agent, REST API.

Full architecture lives in [`docs/`](docs/) — **read those, don't restate them here.**
Start at [docs/00-overview.md](docs/00-overview.md); the index is in [README.md](README.md).

> 📌 **Resuming work?** Read [`docs/HANDOFF.md`](docs/HANDOFF.md) — current build status, ports, how to
> run all three apps, the OpsCore integration, gotchas, and the uncommitted-git warning.

---

## Monorepo layout

Turborepo + pnpm workspaces. Node 20, pnpm 9.

### Apps (`apps/*`)

| Package             | Stack                | Status | Notes |
| ------------------- | -------------------- | ------ | ----- |
| `@timepro/api`    | Fastify + Drizzle    | live   | All REST endpoints. Port **4001** (OpsCore owns :3001 locally). |
| `@timepro/web`    | Next.js 14 (App dir) | live   | Dashboard + Team + login. Port **3005** (moved off 3000 — see OpsCore-prod gotcha). |

> **OpsCore** (separate Next.js app at `/Users/macos/Code/systemsd/OpsCore`, runs on **:3001**) is the
> upstream identity + directory system. TimePro integrates via a **handoff-JWT login** (OpsCore is *not*
> an OIDC provider) + a Bearer-authed **service API** TimePro syncs from. Shared secret/API key live in
> both `.env`s. New code: `apps/api/src/lib/opscore.ts`, `routes/auth.ts` (`/v1/auth/opscore/exchange`),
> `routes/admin.ts` (`/v1/admin/opscore/sync`); OpsCore side `lib/timepro.ts` + `app/api/timepro/*`.
| `@timepro/desktop`| Tauri 2 + Rust + React | live | Time tracker + screenshot capture. Desktop OpsCore login (loopback flow). |
| `apps/extension`  | MV3 (plain JS, no build) | built | Browser URL-tracker → `/v1/ingest/url-usage`. **Not** a pnpm workspace package (no `package.json`); load unpacked per its README. |

### Packages (`packages/*`)

| Package                    | Purpose |
| -------------------------- | ------- |
| `@timepro/db`            | Drizzle schema, migrations, `withTenant` helper, seed. |
| `@timepro/tsconfig`      | Shared tsconfig presets (`base`/`node`/`next`/`react`). |
| `@timepro/eslint-config` | Shared ESLint flat config (currently a near-noop stub). |

> Packages documented in [docs/12-monorepo.md](docs/12-monorepo.md) but **not yet scaffolded**:
> `worker`, `scheduler`, `realtime` apps; `shared`, `auth`, `ui`, `storage`, `desktop-sdk` packages.
> Don't assume they exist.

---

## Commands

```bash
# install
pnpm install

# local infra (Postgres, Redis, Minio, MailHog) — optional if you run your own Postgres
docker compose -f infra/compose/docker-compose.dev.yml up -d

# database (reads DATABASE_URL / DATABASE_ADMIN_URL from root .env)
pnpm db:generate     # drizzle-kit: schema → SQL migration
pnpm db:migrate      # apply migrations (also bootstraps citext + pgcrypto extensions)
pnpm db:studio       # drizzle studio
# No seed: the org is JIT-created on the first OpsCore login (slug OPSCORE_ORG_SLUG,
# name OPSCORE_ORG_NAME); employees/projects/clients come from the OpsCore directory sync.

# run services
pnpm --filter @timepro/api dev      # API on :4001 (tsx watch)
pnpm --filter @timepro/web dev      # web on :3005 (next dev)
source "$HOME/.cargo/env"
# TIMEPRO_WEB_URL lets "Sign in with OpsCore" open the local web bridge (/desktop-auth)
TIMEPRO_API_URL=http://localhost:4001 TIMEPRO_WEB_URL=http://localhost:3005 \
  pnpm --filter @timepro/desktop tauri:dev

# quality gates
pnpm typecheck       # tsc --noEmit across workspaces
pnpm build           # turbo build
```

Rust/cargo checks for the desktop agent:
```bash
source "$HOME/.cargo/env"
cd apps/desktop/src-tauri && cargo check
```

---

## How the pieces talk

- **Desktop agent → API**: all HTTP is in Rust (`apps/desktop/src-tauri/src/api.rs`); the React
  UI only calls Rust via `invoke()` (`src/ipc.ts`). The UI never hits the API directly.
- **Web → API**: client-side `fetch` in `apps/web/src/lib/api.ts`.
- **Auth (MVP)**: there is no real JWT yet. The API's `requireAuth` accepts dev headers
  `x-dev-org` + `x-dev-user` (non-production only). `POST /v1/auth/dev-login` maps an email →
  these IDs (works for any OpsCore-synced user in non-prod). **OpsCore is the only real auth
  path** — "Sign in with OpsCore" JIT-creates the org + your membership; there is **no local
  break-glass owner** anymore (an OpsCore outage means no logins — accepted trade-off).
- **Desktop → web auto-login ("view online")**: one-time handoff code.
  `POST /v1/auth/handoff` (desktop, authed) mints a single-use, 60s code →
  browser opens `/auth/handoff?code=…` → `POST /v1/auth/handoff/exchange` redeems it →
  session stored in the web app's `localStorage`. The long-lived identity is never in a URL.
- **Tenancy**: every tenant query runs inside `withTenant(orgId, fn)` which sets the
  `app.organization_id` Postgres GUC; RLS enforces isolation (fail-closed). Maintenance jobs
  use `asPlatform` (BYPASSRLS role). See [docs/02-database-schema.md](docs/02-database-schema.md) §8.

- **RBAC scoping (C1)**: `apps/api/src/lib/access.ts` resolves the requester's role + visible-user
  set — admin/owner = all, manager = own team (`teams.manager_user_id` → `team_members`), employee =
  self. Use `visibleUsers(req)` / `canView()` / `isAdmin()` for any cross-user read.

### API routes (`apps/api/src/routes/`)
`auth` · `health` · `me` (today, profile) · `projects` (list **member-scoped** to the caller's active assignments) ·
`screenshots` · `team` · `timer` · `roster` (self-scoped for employees) · `timeline` (+ `/:userId/activity`) ·
`clients` · `settings` · `presence` · `ingest` (activity/app-usage/url-usage) ·
`admin` (`opscore/sync` — **disables members absent from the OpsCore response**) · `reports` (filters/run/saved;
employees get no clients/projects) · `realtime` (ws presence).
(OpenAPI is generated from the Zod route schemas: `pnpm gen:openapi`.)

### Desktop Rust modules (`apps/desktop/src-tauri/src/`)
`lib.rs` (bootstrap) · `commands.rs` (Tauri commands) · `api.rs` (HTTP client) ·
`state.rs` (in-memory session/timer/config) · `capture/{mod,screenshot,idle}.rs`.

---

## Conventions & gotchas (hard-won — keep these in mind)

- **pnpm 9 has no `--env-file`.** Node scripts load the root `.env` via a path-resolving helper
  (`packages/db/src/lib/loadEnv.ts`, `apps/api/src/lib/loadEnv.ts`) — *not* `import 'dotenv/config'`
  (which is cwd-relative and breaks when run from a subpackage). Reuse `loadRootEnv()`.
- **Migrations bootstrap extensions.** `packages/db/src/migrate.ts` runs
  `CREATE EXTENSION IF NOT EXISTS citext/pgcrypto` before applying migrations. Don't remove it.
- **Drizzle doesn't emit partitioning/RLS.** Those constructs are hand-written SQL migrations
  (per docs §5/§8), not generated by `drizzle-kit`.
- **Desktop API base is baked at build time, never user-entered.** `apps/desktop/src-tauri/src/state.rs`
  → `default_api_base()`: runtime `TIMEPRO_API_URL` (dev) → compile-time `TIMEPRO_API_URL` (CI) →
  `PRODUCTION_API_BASE` constant (shipped default). **Change `PRODUCTION_API_BASE` before building installers.**
  A `.env` won't work for the shipped app — installers carry no env.
- **Screenshots (MVP)** are written to the local filesystem under `STORAGE_DIR`
  (default `apps/api/data/screenshots/{org}/{date}/{id}.png`) and served via
  `GET /v1/screenshots/:id/raw`. `DELETE /v1/screenshots/:id` removes the row + file
  (admins/managers anytime within their visible set; employee self-delete gated by the
  `screenshots.allow_self_delete` policy, default off — C9; trash button on Timeline thumbnails).
  The S3 driver from [docs/07-storage.md](docs/07-storage.md) isn't wired yet.
- **Screenshot retention** — the org-wide `screenshots.retention_days` setting (default 90 = 3 months; `0` = forever)
  auto-prunes older screenshots (rows + files) via `apps/api/src/lib/retention.ts`. No scheduler yet (Phase 8), so
  `server.ts` runs an **in-process sweep** ~30s after boot then every 12h; `POST /v1/admin/screenshots/prune` applies a
  changed retention immediately. **Reports are unaffected** — they read `time_entries`/`app_usage`/`url_usage`, never `screenshots`.
- **Screenshot capture cadence** is `screenshot_interval_sec` in `state.rs`, derived from the
  `screenshots.per_hour` setting on each `/settings/effective` refresh (`300`s fallback before first fetch).
  Capture only runs while a timer is active. The agent also enforces `screenshots.blur=always` (gaussian blur
  before upload) and `tracking.auto_pause_minutes` (stops the timer after that many seconds of input idle).
- **Migrations are expand-only / forward-only.** Never roll back the DB; write a new migration.
- **Web is on :3005, not :3000 — prod-OpsCore/nginx collision.** Prod OpsCore (`https://opscore.systemsd.co`)
  runs behind nginx with its own app on `:3000`; nginx rewrites any `Location: http://localhost:3000/…` (its
  upstream) to the public host. The OpsCore→TimePro handoff redirect (`${TIMEPRO_URL}/auth/opscore?token=…`)
  would get clobbered if TimePro were on 3000. So **web runs on 3005**, OpsCore `TIMEPRO_URL=http://localhost:3005`,
  and `API_CORS_ORIGINS` includes `:3005`. The web's OpsCore target is `apps/web/.env.local`
  (`NEXT_PUBLIC_OPSCORE_URL`); Next reads env from `apps/web/`, **not** the root `.env`. **Login is OpsCore-only**
  (email/password fields removed; dev-login plumbing kept for later).
- **Commit messages**: Conventional Commits. Branch before committing on `main`. Only commit/push when asked.

---

## What's real vs stubbed

**Working end-to-end (desktop agent verified live against PRODUCTION OpsCore):** loopback OpsCore login → directory
sync → time tracking → real screen capture → API → DB + disk (native OS toast gated by `screenshots.notify`; the
timer colon "beats" while tracking); the agent **project picker shows only the user's active assignments**.
**Role-aware home** — admin/manager → 4-column team roster with realtime presence dots; **employee → company-row
dashboard** (org + role badge + last-active + period totals, via the self-scoped `/v1/roster`).
**Timeline** (Hubstaff-style: month strip with per-day activity bars + weekday labels (weekends red) + yellow selected
day; summary card with Week/Month totals + Apps/URLs panel + average-activity donut; 24h ruler with green run/stop bars
from `intervals[]`; screenshot slots with red time-range + app badge + thumbnails, trash to delete; click a thumbnail →
**lightbox** with prev/next) — `/v1/timeline/:id` + `/activity` + `/apps-urls`.
**Reports** console (Hubstaff-style filter bar — preset-link grid, report-type text links, group-by chip field;
Summary/Detailed/Weekly, saved reports, CSV/PDF, Apps & URLs; Clients/Projects filters hidden for employees);
**Team** page (RBAC-scoped per C1; **OpsCore sync auto-disables members absent from the directory**);
**Projects** + **Clients** pages; **Settings** (org + per-user overrides); **My Account** (`/account`, via `/v1/me/profile`)
from the **avatar dropdown** (Dashboard · My Account · Log out); **Download** page (resolves the latest GitHub Release);
☰ menu (role-filtered). Weekly-limit enforcement blocks `timer/start` at the cap. UI uses line icons
(`apps/web/src/components/icons.tsx`), no emojis. Login is OpsCore-only.

**Phase status** — the OpsCore/feature roadmap is in [docs/13-opscore-feature-roadmap.md](docs/13-opscore-feature-roadmap.md):
- ✅ **Phase 0** (quick wins) — done.
- ✅ **Phase 1 — Settings engine (B6)** — done (registry + resolver + API + Settings page + Team overrides + agent consumes `/settings/effective`). **Enforcement live:** agent honors `screenshots.{enabled,per_hour,blur=always,notify}`, `activity.tracking`, `app_url.tracking`, `tracking.auto_pause_minutes` (idle auto-pause); server enforces `limits.weekly_hours`, `screenshots.allow_self_delete` (C9 delete), and `screenshots.retention_days` (auto-prune). Only `time.allow_offline` is unenforced (offline-time feature not built).
- ✅ **Phase 2 — Presence (B3)** — done (agent heartbeat → in-memory store → 3-state dots + "N online").
- ✅ **Phase 4 — Activity + App tracking (B4/B5)** — done (agent activity aggregator + app polling →
  `/v1/ingest/activity` + `/ingest/app-usage` + `/ingest/url-usage`; Timeline activity %/per-slot app; roster last-app;
  Reports "Apps & URLs" tab aggregates `app_usage`/`url_usage`; settings gate the agent).
  **URL tracking: ingest + reporting + the browser-extension capture client (`apps/extension`, MV3, no-build) are
  built; the extension is unverified in a real browser (load unpacked per its README).**
- ✅ **Phase 3 — OpsCore integration (B1/B2)** — done for **web** (handoff-JWT login — OpsCore is *not*
  OIDC — + Bearer service-API sync of employees/projects/business-partners). **Desktop OpsCore login done** —
loopback flow: agent opens system browser → web `/desktop-auth` bridge → OpsCore handoff → token to the
agent's localhost callback → `/v1/auth/opscore/exchange` → device session (`commands::opscore_login`).
- ✅ **Phase 5** Reports (B7) + realtime presence (B10) — see [docs/06-reporting.md §0](docs/06-reporting.md). Rollups (B8) deferred, absences cut.

**Pending — phased (full detail in [docs/13 §3](docs/13-opscore-feature-roadmap.md)):**
- ⏸️ **Phase 6 — Multi-tenancy & real auth** *(PAUSED — single-tenant Systemsd is the current focus)* — one shared DB, many orgs: 6.1 real auth (Argon2 + JWT, retire the `x-dev-*` shim) · 6.2 org onboarding/signup + invites · 6.3 per-org OpsCore SSO · 6.4 RLS fail-closed + DB role split · 6.5 tenant audit + org-context UX.
- 🔴 **Phase 7 — Ship pipeline (B9)** — cross-platform CI builds, code-sign/notarize, host artifacts, wire Download URLs (credential-gated).
- 🔴 **Phase 8 — Scale & storage** — rollups + scheduler (B8) · S3 storage + thumbnails · worker/realtime services + Redis-backed presence.
- 🔴 **Phase 9 — Billing & plans**.
- 🟡 **Phase P — Polish** — ✅ native screenshot toast (`tauri-plugin-notification`, gated by `screenshots.notify`) · ✅ desktop "weekly limit reached" message on the `timer/start` 409 (`commands::map_start_err`) · ✅ idle auto-pause (`tracking.auto_pause_minutes`) + `screenshots.blur=always` enforcement · 🔴 keyboard/mouse activity counts · 🔴 Reports shareable links.

See also [docs/11-roadmap.md](docs/11-roadmap.md) (original MVP/P2/P3) and the per-doc status banners.
