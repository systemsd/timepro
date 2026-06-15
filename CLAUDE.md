# CLAUDE.md

Guidance for Claude Code when working in this repository.

> **TimePro** — a multi-tenant employee time-tracking + screenshot-monitoring platform
> (à la Hubstaff / Time Doctor / ScreenshotMonitor). Web console, desktop agent, REST API.

Full architecture lives in [`docs/`](docs/) — **read those, don't restate them here.**
Start at [docs/00-overview.md](docs/00-overview.md); the index is in [README.md](README.md).

---

## Monorepo layout

Turborepo + pnpm workspaces. Node 20, pnpm 9.

### Apps (`apps/*`)

| Package             | Stack                | Status | Notes |
| ------------------- | -------------------- | ------ | ----- |
| `@timepro/api`    | Fastify + Drizzle    | live   | All REST endpoints. Port **3001**. |
| `@timepro/web`    | Next.js 14 (App dir) | live   | Dashboard + Team + login. Port **3000**. |
| `@timepro/desktop`| Tauri 2 + Rust + React | live | Time tracker + screenshot capture. |

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
pnpm db:seed         # demo org, owner Hamid Ali (owner@timepro.local), 10 members, 9 projects
pnpm db:studio       # drizzle studio

# run services
pnpm --filter @timepro/api dev      # API on :3001 (tsx watch)
pnpm --filter @timepro/web dev      # web on :3000 (next dev)
source "$HOME/.cargo/env"
TIMEPRO_API_URL=http://localhost:3001 pnpm --filter @timepro/desktop tauri:dev

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
  these IDs. Seed login: **`owner@timepro.local`**.
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
`auth` · `health` · `me` · `projects` · `screenshots` · `team` · `timer` · `roster` · `timeline` · `clients`
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
  `GET /v1/screenshots/:id/raw`. The S3 driver from [docs/07-storage.md](docs/07-storage.md) isn't wired yet.
- **Screenshot capture cadence** is `screenshot_interval_sec` in `state.rs` (currently `300` = 12/hr,
  matching the Settings team policy). Capture only runs while a timer is active.
- **Migrations are expand-only / forward-only.** Never roll back the DB; write a new migration.
- **Commit messages**: Conventional Commits. Branch before committing on `main`. Only commit/push when asked.

---

## What's real vs stubbed

**Working end-to-end:** desktop time tracking + automatic screenshot capture → API → DB + disk;
web login + desktop→web handoff; **role-aware My Home** (admin/manager → team roster, employee →
personal); **employee Timeline** (screenshot slots + day total + day nav); **Team** page (roles,
project toggles, invite/pause/archive/delete, RBAC-scoped per C1); **Projects** page (member
assignment); **Clients** page; **Download** page (placeholder links); ☰ menu (role-filtered).

**Phase status** — the OpsCore/feature roadmap is in [docs/13-opscore-feature-roadmap.md](docs/13-opscore-feature-roadmap.md):
- ✅ **Phase 0** (quick wins) — done (the list above).
- 🔜 **Phase 1 — Settings engine (B6)** — in progress / next.
- 🔴 Phase 2 Presence (B3) · Phase 3 OpsCore OIDC+sync (B1/B2, needs real OpsCore details) ·
  Phase 4 activity + app/URL tracking (B4/B5) · Phase 5 reports/rollups/realtime (B7/B8/B10) ·
  Phase 6 build/sign/host pipeline (B9).

**Still stubbed / not built:** real password auth + MFA + JWT (email-only dev login + `x-dev-*` shim),
OpsCore integration, presence/heartbeat (online dots are grey), activity + app/URL tracking
(Timeline activity strip + roster app/URL column absent), settings engine (Settings page is a stub),
S3 storage + thumbnails, BullMQ workers/scheduler/realtime, reporting rollups, Reports tab, billing,
installer signing/hosting (Download links are placeholders).

See also [docs/11-roadmap.md](docs/11-roadmap.md) (original MVP/P2/P3) and the per-doc status banners.
