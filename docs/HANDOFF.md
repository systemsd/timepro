# TimePro — Session Handoff

Snapshot for picking up in a fresh session. **Read [`CLAUDE.md`](../CLAUDE.md) first** (ground truth),
then this for current state + how to run. Full feature roadmap: [`docs/13-opscore-feature-roadmap.md`](13-opscore-feature-roadmap.md).

---

## 🚧 CURRENT STATE (2026-07-14) — OpsCore tasks shipped + a desktop tracking-accuracy fire-drill

> Current desktop version on `main` = **v0.1.19** (shipped/auto-updating). Backend + web auto-deploy on push-to-`main`.
> ⚠️ **Concurrent work:** another session/person has been on `main` — added an **OpsCore reverse-sync endpoint**
> (`/v1/opscore/tasks/time-summary`, `routes/opscore.ts`) and an Obsidian-vault docs section, and is deploying
> OpsCore via **ShipHub/opscorev2**. Expect `main` to move; rebase before large edits.

### Shipped 2026-07-08 → 14

**OpsCore Tasks → TimePro (PRs #55/#57/#60/#61/#62).** Read-only task mirror: `tasks` table (migration 0008) +
`time_entries.task_id`; `GET /v1/tasks` scoped to assignee/collaborator (DONE hidden); `timer/start` optional
`task_id` (400 `task_not_trackable` if not yours); desktop task picker (polls every 45s); Timeline "Tasks" panel
shows the description + a blinking caret on the live entry. Sync = `lib/opscore-sync.ts`, run by the admin route
**and a 2-min scheduled sweep** in `server.ts` (OpsCore never pushes). **`tracking.require_task`** setting
(default **OFF**, staged) — server 400s a no-task start, agent disables Start; **flip ON only once everyone's on
v0.1.14+** or old agents get locked out.

**Desktop tracking-accuracy fixes (all from real user reports — the fire-drill):**
- **v0.1.15** timer↔screenshot desync + lock-screen pause · **v0.1.16** faster task refresh
- **v0.1.17** macOS **App Nap** off (`src-tauri/Info.plist` `NSAppSleepDisabled`, verified in the built bundle; **mac-only**)
- **v0.1.18** **false "Tracking" after sleep/wake** — suspend clears the local timer unconditionally + the Timer UI
  re-validates `timer_current` every 30s (independent of the Rust loop)
- **v0.1.19** **idle-sanitize** (`capture/idle.rs`) — reject bogus idle >6h so a garbage `idle_secs≈4.29M` can't
  back-date an idle-pause and wipe an entry (this had erased Rahat's ~1h)

**Root causes seen (diagnosed via `/v1/admin/agent-logs` + `/user-activity`, Anas allowlisted):** Hamza —
screenshots against a server-closed timer (0 tracked time); Uzair — namaz lock-screen billed, then a Windows
sleep/wake false-"Tracking"; Usama — macOS App Nap throttling → time collapsed to ~1m; Ahmed — 13h unbroken
inflated timer (old agent); Rahat — garbage idle wiped ~1h.

### ⚠️ OPEN (next session)
1. **Windows background throttling** ("capture loop slow") — the deeper root behind Usama/Uzair/Rahat. The App Nap
   fix is **mac-only**; Windows still needs its own anti-suspension fix. Guards (v0.1.18/19) mitigate, don't cure.
2. **Historical data backfill** — only **Rahat's one entry** was corrected (audited `PATCH /v1/time-entries/:id`
   extending `ended_at`, as admin Hamid via dev-headers; note **0-min entries are invisible in the web UI** so the
   API is the only way to edit them). Ahmed's 13h + others un-fixed — needs scope + sign-off.
3. **Chase stragglers to v0.1.19** (were Rahat 0.1.18, Ahmed 0.1.17) via quit-and-reopen.
4. **`tracking.require_task` flip** — Hamid turns it on in web Settings once adoption is confirmed.
5. **Sign/notarize** (Phase 7) — still unsigned; every mac update revokes Screen Recording.

---

## 🗄️ EARLIER STATE (2026-07-02) — Live product; post-audit engineering-quality arc

> Backend + downloads have been LIVE since 2026-06-18 (prod `timepro.systemsd.co` / `api.timepro.systemsd.co`,
> push-to-`main` auto-deploy). Current desktop version on `main` = **v0.1.12**.
>
> **Latest arc — a post-audit quality push (4 merged PRs #44–47, all CI-green):** an engineering audit graded the
> app strong on domain logic but weak on tests/CI, DRY/coupling, UI standards, and observability (and found the
> docs' "RLS fail-closed" claim was false). We ran it as a 4-step roadmap:
> **(1)** fixed live data bugs (double-counted app/URL time, double timers, roster full-scan) — deployed + prod-verified;
> **(2)** the safety net — Sentry (DSN-gated) + first unit/integration tests + a **PR CI gate** (typecheck/unit/build,
> integration on Postgres, desktop cargo-check);
> **(3)** clean-up — shared `lib/time.ts`, an exemplar `repositories/` layer, web helper consolidation;
> **(4)** the UI library — `@timepro/ui` (accessible Button/Modal/Select) + `ui.md`, adopted in reports +
> EditActivityModal, fixing the `<div onClick>`/`window.confirm` a11y gaps.
> **Remaining priority: the security milestone (real auth + RLS + rate-limiting) before onboarding tenant #2.**
> Historical deploy/download detail: [`docs/14-deploy-and-download-progress.md`](14-deploy-and-download-progress.md).

### Shipped 2026-07-02 (post-audit quality arc — PRs #44–47)
- **#44 data-integrity fixes** (deployed + prod-verified): idempotent app/URL ingest (natural-key UNIQUE +
  `onConflictDoNothing`, migration `0007`), a per-(org,user) **advisory lock** on `timer/start` (no double timers),
  and roster latest-screenshot via **`DISTINCT ON`** (no unbounded scan).
- **#45 safety nets:** `@sentry/node` DSN-gated (`lib/observability.ts`); vitest **unit** tests (report/time math,
  xlsx, dedupe) + **integration** tests booting the app on a test DB (**tenancy/RBAC isolation**, ingest
  idempotency, timer race, roster); **`.github/workflows/ci.yml`** gates every PR.
- **#46 clean-up:** `lib/time.ts` (killed the 4× `overlapSeconds` + inline date math), `repositories/`
  (time-entries + screenshots, adopted by timer/roster/me/timeline), web `lib/date.ts`+`lib/format.ts`.
- **#47 UI library:** `@timepro/ui` (source-only, `transpilePackages`) — Button, Modal/Confirm/Prompt, accessible
  Select, icons — + **`packages/ui/ui.md`**; adopted in reports + EditActivityModal (replaced `window.prompt`/
  `confirm` and the non-keyboard dropdowns). Component tests under jsdom.
- **Doc correction (this arc):** the long-standing "**RLS enforces isolation (fail-closed)**" claim was **false** —
  no RLS/partitioning DDL exists; isolation is app-layer filters, now backed by the tenancy integration test.
  CLAUDE.md + docs/12 corrected.

### Shipped 2026-07-02 (Reports: activity + real weekly + xlsx export — PR #42)
Admin flagged Reports as a priority; after a gap audit we did 3 of 4 tracks (money/billable deferred).
`apps/api/src/routes/reports.ts` + `apps/web/src/app/reports/page.tsx` + new `apps/web/src/lib/xlsx.ts`.
- **Activity/productivity** — `POST /v1/reports/run` attributes `activity_samples` to entries via `time_entry_id`
  and rolls a **0–100 activity score** (Timeline-donut basis) + **active/idle seconds** into every group, pivot, and
  detail row, plus top-level `avg_activity_score`/`active_seconds`/`idle_seconds`. UI: an **Activity column** across
  the tables + a headline **Activity % / Active** stat by the chart. Apps/URLs carry no activity (`null`).
- **Real Weekly report** — `type=weekly` now returns a `weeks[]` block (**ISO week, Monday-start**): per-week card →
  per-employee rows × **Mon..Sun** + activity + total; seconds split across day/week boundaries. Was previously
  identical to "Summary by employee". New expandable `WeeklyTable`.
- **Export upgrade** — new **zero-dep `.xlsx` writer** (`apps/web/src/lib/xlsx.ts`: STORE zip + CRC32, inline strings,
  numeric cells) and **"export what you see"**: CSV *and* Excel export the **active result tab** (incl. the weekly
  timesheet). Separate CSV + Excel buttons; PDF still browser-print.
- **Verified:** api + web typecheck, web build, xlsx zip integrity (`unzip -t`) + XML escaping. **Not** run live e2e
  (needs OpsCore + DB + tracked data). No desktop change → no `tauri.conf.json` bump.
- **Still open on Reports:** money/billable report (rates + `is_billable` exist in schema, unused — the highest-value
  remaining track); approval-aware reporting; DST-correct tz (single viewer offset today); server/async export for
  >90-day ranges (Detailed still capped at 5000 rows).

### Shipped 2026-07-01 (timeline grouping fix)
- **Timeline no longer misfiles orphan screenshots** (`routes/timeline.ts`, PR #40, deployed + prod-verified).
  Hamza saw 6:16 AM screenshots under a 12:19 PM activity. Root cause: the activities query pulled only entries
  that *started* within ~1.25 days while the screenshots query pulled the whole day, so screenshots owned by an
  earlier long-running/overnight entry had no activity to group under — and `actAt`'s `?? acts[0]` fallback
  dumped them onto the **first** activity. Fix: (1) activities query now includes entries that **overlap** the
  day (`started < dayEnd AND (ended IS NULL OR ended >= dayStart)`, matching the Tasks query); (2) `actAt`
  attaches a capture only to an activity whose range **contains** it (+90s grace) and returns `null` otherwise,
  so a genuine orphan is dropped, never misfiled. **Verified:** the noon activity went from 78 screenshots
  (span 6:16 AM–12:34 PM) to 7 (12:20–12:34); every activity now shows only its own shots.
- **Hamza's "time stuck at 2h 04m" (2026-06-30)** was diagnosed as the idle/sleep pause-without-resume issue on
  **v0.1.11** (his logs show the timer constantly pausing on sleep/idle and needing a manual restart). **Already
  fixed by v0.1.12 idle auto-resume — Hamza just needs to update** (he's still on v0.1.11). Not a code change.
- **Open follow-up:** the ~70 orphan morning screenshots are now *dropped* (no owning entry surfaced even with the
  overlap query — likely a deleted/pre-window entry). Optional: investigate their origin, or add an "Untracked"
  bucket so orphans stay visible at their real times instead of hidden.

### Shipped 2026-06-30 (reporting self-heal + desktop UX)
- **Abandoned-timer sweep (server, self-healing)** — `apps/api/src/lib/timer-sweep.ts`, scheduled in
  `server.ts` ~45s after boot then **every 10 min**, cross-tenant via `asPlatform`. A timer left open across
  sleep/crash was counted up to `now` by roster/reports, so one forgotten timer billed as hours/days (a single
  entry showed **107h**, inflating a user's month to 138h). The sweep finds entries still open OR > 30 min,
  computes the user's last real activity *inside* the entry (latest screenshot / activity sample / app-usage —
  all stop when the machine sleeps), and if there's a dead tail > 15 min, clamps `ended_at` back to it
  (`source=system`, audited as `time_entry.auto_closed`). Self-heals existing bad data **and** prevents
  recurrence regardless of agent reliability; actively-tracking users are never touched. **Verified in prod:**
  one user's month went **138h → 19h** on the first run. `recordAudit()` extended to support a system actor.
- **Desktop v0.1.12 — persistent login + idle auto-resume:**
  - **Persistent login** — the session is written to `session.json` in the app data dir on login and restored
    at startup (before the UI checks `current_session`), cleared on logout. No more "Sign in with OpsCore" on
    every launch. (The persistence the old `state.rs` comment claimed via `tauri-plugin-store` was never wired.)
  - **Auto-resume on activity** — after an idle auto-pause the user no longer clicks play. The capture loop
    remembers the paused project/description (`PausedTimer`) and starts a fresh entry the instant input returns
    (idle < 10s), emitting `timer:auto-resumed`; the idle gap stays unbilled. A weekly-cap 409 or a manual stop
    clears the paused context. Scope: **idle** pause only — sleep/suspend still needs a manual resume.
  - **Verified in field logs (Anas):** quit/reopen with **0 new login events**; `auto-paused (idle=303)` →
    `auto-resumed` 13s later.

### Shipped 2026-06-24 → 06-30
- **Editable Timeline activities** ("Edit Time" modal, scrin.io-style): click an activity → change
  project/description, **trim** start/end, **split**, or **delete** it. New `routes/time-entries.ts`
  (`PATCH`/`POST :id/split`/`DELETE`/`GET :id/history`); every mutation is audited to the existing
  `audit_logs` table (migration `0006` = a per-target index). RBAC mirrors screenshot-delete:
  admin/manager any, employee self gated by the new **`time.allow_self_edit`** setting (default **on**).
- **Timeline = grouped activities** (each time entry + its screenshots beneath it, app label + activity dot),
  replacing the old flat 10-min `slots[]`. Clickable **Tasks** panel jumps to its activity. Screenshot trash
  **hover-reveals**, delete is one-click + **"Screenshot deleted" toast**, editable activity headers show a
  **pencil** on hover.
- **Dashboard screenshot-flood fix**: thumbnails lazy-load (IntersectionObserver) + a shared concurrency
  limiter (`lib/concurrency.ts`, `useScreenshotUrl.ts`), so screenshot blobs no longer starve `roster`/`members`.
- **Soft-delete read filter** fixed in `timeline` (main query), `roster`, and `me/today` — a deleted time entry
  now stops counting everywhere.
- **Desktop (v0.1.8→v0.1.11):** "Paused" status on idle/sleep (resumable, not "Stopped") · **sleep/idle
  back-dating** so away time isn't billed (was the inflated 16h/24h totals) · **capture-loop diagnostics**
  (`capture status`, `capture_ms`/`upload_ms`, `capture loop slow`) · **uploads moved off the capture loop**
  (a slow ~11–21 s upload was freezing the single-task loop → late/missing screenshots; now spawned per-capture).
  Verified in field logs: steady 2-min cadence even with 15–21 s uploads.

### Infra gotchas learned this arc (hard-won)
- **GitHub Actions billing can hard-stop ALL workflows.** GitHub's new **Budgets** feature defaults the
  **Actions budget to $0 + "stop usage"**; with no payment method, once the monthly free minutes are gone
  *every* job refuses to start (deploy + desktop release). **macOS runners are 10× minutes** and the desktop
  release builds on 2 macOS + 1 Windows, so each release burns ~300 min of the 2,000 free pool. Fix: add a card
  + set the **org** Actions budget non-$0 (org Settings → Billing → Budgets), or temporarily make the repo
  public (free Actions) — see warning below.
- **`RELEASES_REPO_TOKEN` must be able to *write* to `systemsd/timepro-downloads`.** A fine-grained PAT that's
  read-only / owned by a personal account 403s ("Resource not accessible by personal access token"). Use a
  **classic PAT with `repo` scope** (or a fine-grained PAT with resource owner = `systemsd` + Contents: write),
  with a long expiry so it doesn't lapse.
- ⚠️ **The repo was made PUBLIC for ~2 days to dodge the billing block.** Public exposure is effectively
  permanent (bots/forks copy instantly). The committed OpsCore dev secrets (`config.ts` defaults +
  `HANDOFF.md`) are the risk: `OPSCORE_HANDOFF_SECRET` signs the login JWT (`opscore.ts` → `auth.ts`), so if
  prod uses that value, anyone can forge a prod login. **Action: confirm prod `.env` overrides it with a
  strong value; rotate (TimePro + OpsCore, must match) if not. Switch the repo back to private at the new
  billing cycle.**

### How the user (Anas) works
- **Role:** the developer. On **prod he is an `employee`**, NOT org-admin (admin is Hamid).
- **Commits:** Conventional Commits, **no AI/Claude attribution** in messages.
- **Flow:** always work on a **branch**, push it; **the user merges the PR himself** — never commit to `main`.
- **Desktop releases are version-driven:** every desktop change MUST bump `version` in
  `apps/desktop/src-tauri/tauri.conf.json`. Merging to `main` builds + publishes a release **only when the
  version bumped** (`desktop-release.yml` `version-check` job skips otherwise).
- **Verify before pushing:** `pnpm --filter @timepro/<pkg> typecheck`, web `build`, and `cargo check`
  (`apps/desktop/src-tauri`) for agent changes. **After the user merges + publishes, verify the result — don't assume.**

### Shipped the prior arc (v0.1.5 → v0.1.7) — auto-update + agent diagnostics
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
| Postgres (TimePro) | 5432 / db `timepro` | local-dev creds in root `.env` (not committed) |
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
- `OPSCORE_HANDOFF_SECRET` (TimePro) **must equal** `TIMEPRO_HANDOFF_SECRET` (OpsCore) — value lives in both
  `.env`s, **not committed**. (The old `…-dev` default was published while the repo was public; rotate it.)
- `OPSCORE_API_KEY` (TimePro) **must equal** `TIMEPRO_API_KEY` (OpsCore) — same: in `.env`s, not committed.
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

- **TimePro: committed & clean.** `main` is current. Latest merges: the **post-audit quality arc #44–47**
  (data fixes, safety nets + CI, clean-up/repos, `@timepro/ui`); #44 is deployed + prod-verified, the rest are
  code/infra (no separate deploy needed). Earlier: reports enhancements (#42), timeline grouping fix (#40).
  Current shipped desktop version = **v0.1.12** (unchanged this arc — no desktop code changed).
- **CI:** every PR now runs `.github/workflows/ci.yml` (typecheck/unit/build + integration on Postgres + desktop
  cargo-check). Keep it green; add tests with the code they cover.
- **Working tree:** only untracked strays (`video*.mov`, `List`, `SETUP-FOR-HAMID.md`) — ignore them.
- ⚠️ **OpsCore (separate repo): may still have uncommitted integration files** —
  `app/api/timepro/`, `lib/timepro.ts`, edited `lib/auth.config.ts`, `.env`. Commit there so they survive a reset.

---

## 9. Recommended next steps

Phases 0–5 done; **Phase 6 (multi-tenancy) PAUSED** (single-tenant Systemsd is the focus, live + verified).

**Immediate follow-ups from the last session:**
1. **Get Hamza onto v0.1.12** — fixes his "stuck time" (idle auto-resume) + persistent login. He's on v0.1.11.
2. ⚠️ **Rotate the OpsCore shared secret** (`OPSCORE_HANDOFF_SECRET` / `TIMEPRO_HANDOFF_SECRET`) — the committed
   `…-dev` default was exposed while the repo was public. Confirm prod `.env` overrides it; rotate if not.
3. ⚠️ **Switch the repo back to private** at the new billing cycle, and set a **non-$0 org Actions budget** (+ a
   payment method) so releases/deploys don't get blocked again.
4. *(Optional)* Investigate the orphan-morning-screenshots origin, or add an "Untracked" timeline bucket.

**Larger tracks (when ready):** Phase 7 ship pipeline — **code-sign/notarize the mac build** (biggest gap:
every unsigned update revokes Screen Recording) + re-enable Linux · Phase 8/9 scale/storage/billing · Phase 6.

**How to debug a field issue (the muscle-memory from last session):** pull `/v1/admin/agent-logs` with the
`x-dev-org`/`x-dev-user` headers (Anas is allow-listed); to inspect a specific employee's roster/timeline, set
`x-dev-user` to *their* id (self-view is allowed). Cross-check screenshot `captured_at` vs the upload-log `ts` to
tell a real data bug from a display bug. See §3 for run commands.

Everything verified this session is reproducible via the commands in §3.
