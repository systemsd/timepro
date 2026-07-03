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
| `@timepro/ui`            | Shared **source-only** React primitives (Button, Modal/Confirm/Prompt, accessible Select, icons) + `styles.css`. Web consumes via `transpilePackages`; catalog in [`packages/ui/ui.md`](packages/ui/ui.md). |
| `@timepro/tsconfig`      | Shared tsconfig presets (`base`/`node`/`next`/`react`). |
| `@timepro/eslint-config` | Shared ESLint flat config (currently a near-noop stub). |

> Packages documented in [docs/12-monorepo.md](docs/12-monorepo.md) but **not yet scaffolded**:
> `worker`, `scheduler`, `realtime` apps; `shared`, `auth`, `storage`, `desktop-sdk` packages.
> (`ui` is now built — but as a plain-CSS source-only package, **not** the shadcn/tailwind that doc imagined.)
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
pnpm test            # vitest unit tests (api + web + ui) — no DB needed
pnpm test:int        # API integration tests — needs a Postgres; see below
# integration tests boot the real app against a dedicated test DB:
DATABASE_URL=postgres://…/timepro_test DATABASE_ADMIN_URL=… pnpm --filter @timepro/api test:int
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
  `app.organization_id` Postgres GUC. ⚠️ **Reality check (audit-verified): RLS is NOT implemented** — no
  `ENABLE ROW LEVEL SECURITY`/`CREATE POLICY` exists in any migration, and `asPlatform` does **not** switch to a
  BYPASSRLS role (it reuses the app pool). So isolation today rests entirely on **app-layer `eq(organizationId, …)`
  filters** in each query (centralized cross-user reads via `lib/access.ts`), now covered by the tenancy
  **integration tests** (`apps/api/test/integration/tenancy.int.test.ts`). Real RLS + a BYPASSRLS role split is the
  Phase 6.4 security milestone — **required before onboarding a second org.** The GUC is set now so policies can be
  added later without touching app code. See [docs/02-database-schema.md](docs/02-database-schema.md) §8.
- **Repository layer**: `apps/api/src/repositories/` holds thin, tenant-scoped, `tx`-taking data-access functions
  (`time-entries`: `getCurrentTimer`, `listForUsersStartedSince`; `screenshots`: `getLatestPerUser`,
  `listForUserDay`) so Drizzle queries stay out of the handlers. Adopted by timer/roster/me/timeline; the exemplar
  pattern for pulling more query logic out of routes.
- **Shared time math**: `apps/api/src/lib/time.ts` is the single home for date/overlap primitives
  (`overlapSeconds`, `localDateToUtcMs`, `bucketSecondsByDay`, …); `report-time.ts` keeps only report-domain
  grouping. Don't re-inline day/overlap math in routes — import from `lib/time.ts`.

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
- **Partitioning/RLS are DESIGN-ONLY, not built.** Despite docs §5/§8 (and some stale schema comments), **no
  partitioning and no RLS DDL exist in any migration** — `time_entries`/`activity_samples`/`app_usage`/`url_usage`
  are plain tables and tenant isolation is app-layer (see the Tenancy note above). When you hand-write such a
  migration later, `drizzle-kit` won't generate it for you.
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
- **Idle/suspend time is never billed.** Both the idle auto-pause and **sleep/suspend recovery** stop the timer
  *back-dated* to the last active moment, not when the agent notices. Idle ends at `now − idle`; a detected suspend
  (a wall-clock gap ≥60s across the 5s capture tick → lid closed/slept) ends just before the machine slept.
  `POST /v1/timer/stop` takes an optional `ended_at`, clamped server-side to `[started_at, now]`; the capture loop
  sets it. Suspend recovery is unconditional; the idle path needs `tracking.auto_pause_minutes > 0`. **Idle
  auto-pause now auto-resumes** (v0.1.12): the loop remembers the paused project/description (`state::PausedTimer`)
  and starts a fresh entry the instant input returns (idle < 10s) → emits `timer:auto-resumed`, no manual click.
  **Suspend** still resumes manually. A weekly-cap 409 or a manual stop clears the paused context.
- **Server self-heals inflated reports (abandoned-timer sweep).** A timer left open across sleep/crash is counted
  to `now` by roster/reports, so a forgotten timer can bill as hours/days. `apps/api/src/lib/timer-sweep.ts`
  (scheduled in `server.ts` ~45s after boot then every 10 min, cross-tenant via `asPlatform`) finds entries still
  open OR > 30 min, computes the user's last real activity *inside* the entry (latest screenshot/activity/app-usage
  — all stop when the machine sleeps), and if there's a dead tail > 15 min clamps `ended_at` back to it
  (`source=system`, audited `time_entry.auto_closed`). Self-healing + agent-independent; never touches an
  actively-tracking user or an entry with no activity signal.
- **Desktop session persists (v0.1.12).** The OpsCore session is saved to `session.json` in the app data dir on
  login (`state::set_session`), restored at startup in `lib.rs` setup (before the UI's `current_session` check),
  and deleted on logout — so the agent no longer asks to sign in on every launch. The running timer is *not*
  persisted (intentional).
- **Migrations are expand-only / forward-only.** Never roll back the DB; write a new migration.
- **Web is on :3005, not :3000 — prod-OpsCore/nginx collision.** Prod OpsCore (`https://opscore.systemsd.co`)
  runs behind nginx with its own app on `:3000`; nginx rewrites any `Location: http://localhost:3000/…` (its
  upstream) to the public host. The OpsCore→TimePro handoff redirect (`${TIMEPRO_URL}/auth/opscore?token=…`)
  would get clobbered if TimePro were on 3000. So **web runs on 3005**, OpsCore `TIMEPRO_URL=http://localhost:3005`,
  and `API_CORS_ORIGINS` includes `:3005`. The web's OpsCore target is `apps/web/.env.local`
  (`NEXT_PUBLIC_OPSCORE_URL`); Next reads env from `apps/web/`, **not** the root `.env`. **Login is OpsCore-only**
  (email/password fields removed; dev-login plumbing kept for later).
- **Editing time entries (timeline activities).** `routes/time-entries.ts` — `PATCH /v1/time-entries/:id`
  (project/description/trim), `POST /:id/split`, `DELETE /:id` (soft-delete), `GET /:id/history`. Every mutation
  is written to `audit_logs` via `lib/audit.ts`. RBAC mirrors screenshot-delete; employee self-edit is gated by
  the `time.allow_self_edit` setting (default on). Soft-deleted entries are filtered in `timeline`/`roster`/`me`.
- **Timeline groups screenshots under the activity whose time range contains them.** `routes/timeline.ts` builds
  the day's activities from entries that **overlap** the day (`started < dayEnd AND (ended IS NULL OR ended >=
  dayStart)` — not just ones that *started* in-window, else long-running/overnight entries' screenshots orphan),
  and `actAt` attaches a capture only to a containing activity (+90s grace), returning `null` for a genuine
  orphan so it's **dropped, not misfiled onto the first activity** (the old `?? acts[0]` bug showed 6am shots
  under a noon entry). A capture's `captured_at` is agent-stamped but has matched the server upload time in the
  field (no clock skew) — trust it.
- **Desktop capture loop offloads uploads.** `capture/mod.rs` `run_capture_loop` reserves the cadence slot then
  spawns capture+upload as a task — a slow upload (seen ~11–21 s on weak links) no longer freezes the single-task
  loop. Diagnostics: `capture status`, `capture_ms`/`upload_ms`, `capture loop slow` (in agent logs).
- **CI/release operational gotchas (cost us a day):** (1) **GitHub Actions billing** — the org's new *Budgets*
  feature can default the **Actions budget to $0 + "stop usage"**; with no payment method, once the monthly free
  minutes run out **no workflow starts at all** (macOS runners are 10× minutes, and the desktop release uses
  2 macOS + 1 Windows). Fix at org Settings → Billing → Budgets. (2) **`RELEASES_REPO_TOKEN`** must be able to
  *write* to `systemsd/timepro-downloads` — use a classic PAT with `repo` scope (or fine-grained owned by the org
  with Contents: write), long expiry. A read-only / personal-owned fine-grained PAT 403s on release create.
- **Tests + CI (a PR gate now exists).** `.github/workflows/ci.yml` runs on **every PR** (and push to main):
  typecheck + `pnpm test` (vitest unit) + build, an **integration** job (Postgres service → `test:int`), and
  **`cargo check`** on the desktop agent. Unit tests are pure logic (`report-time`, `time`, xlsx, ingest dedupe,
  UI components under jsdom). Integration tests boot the real Fastify app via `app.inject` against a test DB and
  cover **tenancy/RBAC isolation**, ingest idempotency, the timer race, roster, and the repositories. Add/extend
  tests with the code they cover; CI must be green before merge. (Deploy still runs separately on push-to-main.)
- **Error tracking is DSN-gated Sentry.** `apps/api/src/lib/observability.ts` (`initObservability`/`captureError`,
  wired in `server.ts` + `error-mapper.ts`). No-op unless `SENTRY_DSN` is set — turn it on by setting the DSN in
  the prod `.env`. The error-mapper also masks the internal 500 message from clients in production.
- **API docs = OpenAPI (Zod-generated) + Scalar at `/docs`.** `@fastify/swagger` (registered in `app.ts` with
  `jsonSchemaTransform`) builds the spec from the Zod route schemas — single source of truth, can't drift.
  `pnpm gen:openapi` writes the spec to `apps/api/openapi/openapi.json` (gitignored; regenerate on demand). The
  interactive **Scalar** UI is gated by a **dedicated Basic-auth credential, separate from the app login**:
  `API_DOCS_PASSWORD` set → `/docs` exposed in **every env** behind Basic auth (`API_DOCS_USER`/`API_DOCS_PASSWORD`);
  unset → open in non-prod only, **not exposed in prod** (fail-closed). Turn on prod docs by setting
  `API_DOCS_PASSWORD` in the prod `.env` (same on/off pattern as `SENTRY_DSN`).
- **Data-integrity invariants (don't regress — they were live bugs).** `/ingest/app-usage` + `/ingest/url-usage`
  are **idempotent** via a natural-key UNIQUE index + `onConflictDoNothing` (a retried batch must not double-count).
  `timer/start` takes a **per-(org,user) advisory lock** so concurrent starts can't open two timers. Roster's
  latest-screenshot-per-user uses **`DISTINCT ON`** (never an unbounded scan). Migration `0007`.
- **UI: prefer `@timepro/ui` primitives.** Use `Button`/`Modal`/`ConfirmModal`/`PromptModal`/`Select` and the
  design tokens over ad-hoc markup, `window.confirm`/`prompt`, or `<div onClick>` dropdowns. Extract new reusable
  components into `@timepro/ui` **and document them in `packages/ui/ui.md`** in the same PR (the library grows
  gradually, per-screen). Web imports `@timepro/ui/styles.css` once in `app/layout.tsx`.
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
Summary/Detailed/**real ISO-week Weekly** (per-employee × Mon..Sun), saved reports, **per-group/entry Activity %** +
headline Activity/Active stat, **tab-aware CSV + real `.xlsx` export** ("export what you see", zero-dep writer
`apps/web/src/lib/xlsx.ts`), PDF print, Apps & URLs; Clients/Projects filters hidden for employees);
**Team** page (RBAC-scoped per C1; **OpsCore sync auto-disables members absent from the directory**);
**Projects** + **Clients** pages; **Settings** (org + per-user overrides); **My Account** (`/account`, via `/v1/me/profile`)
from the **avatar dropdown** (Dashboard · My Account · Log out); **Download** page (**live** — resolves the latest mac + Windows installers from the separate **public** `systemsd/timepro-downloads` repo; Linux leg disabled, unsigned);
**Agent Diagnostics** (`/diagnostics`; owners/admins + developer allowlist) — desktop-agent logs with a day picker (defaults to today) + all-users dropdown, via `/v1/admin/agent-logs`;
**Editable Timeline activities** (click an activity → "Edit Time" modal: change project/description, trim start/end, split, delete — audited to `audit_logs`; gated by `time.allow_self_edit`);
☰ menu (role-filtered). Weekly-limit enforcement blocks `timer/start` at the cap. UI uses line icons
(`apps/web/src/components/icons.tsx`), no emojis.

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
- 🟡 **Phase 7 — Ship pipeline (B9)** — ✅ CI builds + hosts installers (mac + Windows) via the public `timepro-downloads` repo; Download page live; **in-app auto-updater** live (v0.1.5+); current shipped **v0.1.12**. 🔴 remaining: **code-sign/notarize** (currently unsigned — every mac update revokes Screen Recording), re-enable the **Linux** build leg (`libgbm-dev`).
- 🔴 **Phase 8 — Scale & storage** — rollups + scheduler (B8) · S3 storage + thumbnails · worker/realtime services + Redis-backed presence.
- 🔴 **Phase 9 — Billing & plans**.
- 🟡 **Phase P — Polish** — ✅ native screenshot toast (`tauri-plugin-notification`, gated by `screenshots.notify`) · ✅ desktop "weekly limit reached" message on the `timer/start` 409 (`commands::map_start_err`) · ✅ idle + **sleep/suspend** auto-pause, back-dated so away-time isn't billed (`/v1/timer/stop` `ended_at`) · ✅ **idle auto-resume** on activity + **persistent desktop login** (v0.1.12) · ✅ **server abandoned-timer sweep** self-heals inflated reports · 🔴 keyboard/mouse activity counts · 🔴 Reports shareable links.

See also [docs/11-roadmap.md](docs/11-roadmap.md) (original MVP/P2/P3) and the per-doc status banners.
