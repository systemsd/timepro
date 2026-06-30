# TimePro — Deploy & Download: Feature Progress Tracker

> **Goal (requirement):** *"Make the app downloadable so that a user can start tracking, and on the app
> side make sure tracking is visible."*
>
> This tracker covers the two groups we committed to: **A — deploy the backend** (the prerequisite that
> makes tracking actually work) and **B — make the desktop app downloadable**. The "tracking is visible"
> half (group C) is already ~90% built and is verified inside B5; remaining C polish is parked at the bottom.
>
> Maps to **Phase 7 — Ship pipeline (B9)** in [docs/13-opscore-feature-roadmap.md](13-opscore-feature-roadmap.md).
> Read [CLAUDE.md](../CLAUDE.md) + [docs/HANDOFF.md](HANDOFF.md) first for ground truth.

**Status:** 🟡 In progress — all off-server work built & validated (A1/A2/A3/A6, B1/B2/B4); local dry-run proved download→track→visible. Remaining is server setup + CI runs (see §0.1 + table below).
**Last updated:** 2026-06-16.

Status legend: ✅ done · 🟡 in progress · 🔴 not started · ⏳ blocked (needs input/credential) · ⛔ cut/deferred.

---

## 0. Decisions (locked)

All four chosen to **mirror what's already in use** (the sibling app **OpsCore**) — no new platforms introduced.

| # | Decision | Choice | Rationale |
| - | -------- | ------ | --------- |
| 1 | **Hosting** | Single **Ubuntu + Docker + nginx + Let's Encrypt** host | What `docs/09-deployment.md` prescribes; OpsCore is deployed this way. AWS/ECS is the doc's "at-scale" target, not in repo. |
| 2 | **Domain** | `*.systemsd.co` subdomains: web `timepro.systemsd.co`, API `api.timepro.systemsd.co` | Mirrors OpsCore (`opscore.systemsd.co`) on a domain already owned. Exact labels confirmable at A0. |
| 3 | **Code signing** | **Unsigned interim** (Gatekeeper/SmartScreen click-through) | Nothing signing-related exists; Download page already carries interim copy. No cert procurement. Signing = separate future task. |
| 4 | **Installer hosting** | **GitHub Releases — in a separate PUBLIC repo `systemsd/timepro-downloads`** (revised 2026-06-18) | Code repo is private; release downloads inherit repo visibility, so installers go in a binaries-only public repo. CI is already GitHub-centric. CloudFront/`updates.timepro.app` is the at-scale target, not in use. |

> ⚠️ **Consequence of decision 2:** the desktop binary currently bakes `api.timepro.app` / `app.timepro.app`.
> **B1 must rewrite** `PRODUCTION_API_BASE` / `PRODUCTION_WEB_BASE` in `state.rs` to the `*.systemsd.co` names,
> plus matching `API_CORS_ORIGINS`, `NEXT_PUBLIC_*`, and OpsCore `TIMEPRO_URL`.

---

## 0.1 Direction update (2026-06-16) — CI/CD auto-deploy on push to `main`

Per manager (Hamid, Slack): **"we'll set up CI/CD for this repo … push to `main` → code auto-deploys."**
This reshapes how **group A is executed** — the host steps (A3 apply / A4 / A5) get wrapped into a
GitHub Actions **deploy workflow** instead of being run by hand. The Dockerfiles/compose/nginx/migrate
already built are exactly what that workflow runs — nothing wasted.

- **New task A6 — backend deploy workflow** (`.github/workflows/deploy.yml`): on push to `main`, SSH to
  `178.105.58.173` → `git pull` → `docker compose -f infra/compose/docker-compose.prod.yml up -d --build`
  (migrate one-shot runs automatically). Authorable off-server now.
- **"Server access" = one-time setup**, then automated: (1) deploy SSH key on the server + private key as a
  GitHub secret; (2) env files (`.env`, `envs/api.env`) on the server; (3) nginx + certbot once (A3 runbook).
- Decision pending: build-on-host (simplest, chosen default) vs CI builds → GHCR → server pulls (scale-up).
- **Domain confirmed:** `timepro` (single-p) is the real record; `timppro` (Hamid's nslookup typo) does not resolve.

## 1. Critical path

```
A0(DNS/host) → A1 → A2 → A3 → A4 → A5 ──┐
        └──────────────► B1 ─► B2+B3 ─► B4 ─► B5
```

- **A must be live before B is meaningful** — a downloaded app bakes the prod URLs and is dead until the server answers.
- **B1 can start once A0 hostnames are fixed**; B5 verification needs A5 done.
- **User-gated steps:** A0 (host + DNS), A4 (edit OpsCore prod env + restart), B2 (enable GitHub Actions).
- **Biggest net-new work / risk:** A1–A3 — no prod Dockerfiles, compose, or nginx config exist yet. Group B is mostly mechanical.

---

## 2. GROUP A — Deploy the backend

### A0 · Provision & DNS 🟡 *(user-gated — waiting on DNS)*
- [x] Decide host: **co-locate on OpsCore's box `178.105.58.173`** (Ubuntu, runs OpsCore + apex `systemsd.co`). Reuse its nginx + certbot. No port clash (TimePro 4001/3005 vs OpsCore 3000/3001).
- [x] Confirm subdomain labels: web **`timepro.systemsd.co`**, API **`api.timepro.systemsd.co`** (both currently free — no existing A record).
- [x] **DNS added** (2026-06-16) — `timepro` + `api.timepro` A-records → `178.105.58.173`. ✅ Verified via `@1.1.1.1` (both resolve; local resolver cache lagging but authoritative is correct).
- [x] Host reachable: SSH/22 open, HTTPS/443 already serving (OpsCore's nginx).
- [ ] **Open:** how on-host steps (A3-apply/A4/A5) get executed — no SSH creds in this env. Either user grants SSH (user@host) or runs the prepared commands.
- **Done when:** both DNS names resolve (✅) + a way to run commands on the host is settled.
- **Note:** OpsCore source repo is **not on this machine** (`/Users/macos/Code/systemsd/OpsCore` missing) — A4 (OpsCore env edit + commit) must run wherever that repo actually lives (likely on the server).

### A1 · Production Dockerfiles ✅ *(done 2026-06-16 — all three build & boot locally)*
- [x] `apps/api/Dockerfile` — multi-stage (turbo prune → install → build → `pnpm deploy --prod` → distroless node22), `EXPOSE 4001`. ✅ image boots: *"TimePro API listening on http://0.0.0.0:4001 (production)"*.
- [x] `apps/web/Dockerfile` — Next standalone; added `output: 'standalone'` to `next.config.mjs`. NEXT_PUBLIC_* passed as **build args** (inlined at build, not runtime). ✅ boots, serves (307 → login). No `apps/web/public` dir (so no public COPY).
- [x] `packages/db/Dockerfile` — `migrate` one-shot (keeps dev deps for tsx; `CMD pnpm db:migrate`). ✅ builds. (Run needs a DB → verified at A5.)
- [x] Root `.dockerignore` — excludes node_modules/dist/.next/.turbo, **`apps/desktop/src-tauri/target`** (GBs), `data/`, and all `.env*`.

**Required fixes made to get a working production build (latent issues, not just packaging):**
1. **`apps/api/tsup.config.ts` (new)** — `noExternal: [/^@timepro\//]` bundles the source-only `@timepro/db` into `dist/server.js`. Without it, `node dist/server.js` couldn't resolve the TS workspace package — the documented prod path was broken (dev-only worked via tsx). Build script simplified to `tsup`.
2. **`pg` + `uuid` added to `apps/api/package.json` deps** — once db is bundled, its runtime deps become the API's. `pg` (CommonJS) must stay **external** or its dynamic `require("events")` crashes the ESM bundle at boot. Declaring them externalizes them and `pnpm deploy` installs them. Lockfile resynced.
3. **`output: 'standalone'`** added to `apps/web/next.config.mjs`.
4. **Pinned `turbo@2.9.16`** in all Dockerfiles — `pnpm dlx turbo@2` was non-deterministic and produced a broken pruned lockfile (`ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY: eslint@9.39.4`). Pinning to the repo's turbo version fixed it. *(The committed root lockfile itself is fine.)*

**Files touched (uncommitted — commit when ready):** `apps/api/{Dockerfile,tsup.config.ts,package.json}` · `apps/web/{Dockerfile,next.config.mjs}` · `packages/db/Dockerfile` · `.dockerignore` · `pnpm-lock.yaml`.
**Done when:** ✅ all three images build locally; API + web boot.

### A2 · Production compose stack ✅ *(done 2026-06-16 — full stack built, ran & verified locally)*
- [x] `infra/compose/docker-compose.prod.yml`: `postgres` (vol `pgdata`, healthcheck), one-shot `migrate` (runs before api via `service_completed_successfully`), `api` (+ `screenshots` named volume → `/data/screenshots`), `web` (build args for NEXT_PUBLIC_*). Ports bound to **`127.0.0.1`** only (nginx fronts them in A3).
- [x] Env templates: `infra/compose/.env.example` (Postgres creds + NEXT_PUBLIC_* build args) + `infra/compose/envs/api.env.example` (only the keys `config.ts` reads). `DATABASE_URL` injected by compose from `POSTGRES_*` so the password lives in one place. `.gitignore` updated so real `.env`/`envs/*.env` stay out of git.
- [x] **Redis ⛔ confirmed unused** — grep shows no client ever dials `REDIS_URL`; satisfied by a placeholder, no container. (Honors the deferral.)
- [x] **Volume ownership fix** — distroless `api` runs as `nonroot`; seeded a `nonroot`-owned `/data/screenshots` into the image (Dockerfile) so the named volume inherits writable ownership.
- **Verified end-to-end** (local `docker compose up -d --build`): postgres healthy → migrate `extensions ready: citext, pgcrypto` + applied migrations (**19 tables**) + exited → api `listening on 0.0.0.0:4001` → **`/readyz` = `{"checks":{"db":"ok"}}` [200]** (real API→Postgres round-trip) → web `[307]`. Torn down with `down -v`; throwaway test env files removed (templates kept).
- **Files added:** `infra/compose/docker-compose.prod.yml` · `infra/compose/.env.example` · `infra/compose/envs/api.env.example` · `.gitignore` rule · `apps/api/Dockerfile` (+`/data` seed).
- **Done when:** ✅ `docker compose up` runs the full stack; migrations apply; API serves with DB connected.

### A3 · Nginx + TLS 🟡 *(config written & syntax-validated; apply needs the host — blocked on A0)*
- [x] nginx vhost `infra/nginx/timepro.systemsd.co.conf`: `timepro.systemsd.co` → `127.0.0.1:3005` (web), `api.timepro.systemsd.co` → `127.0.0.1:4001` (api) with `/v1/realtime` WebSocket upgrade (1h timeout), HSTS, `client_max_body_size 25m`, http→https redirect + ACME location. Upstreams use keepalive. ✅ **`nginx -t` passes** (validated in nginx:1.27-alpine with stub certs).
- [x] Confirmed API has `trustProxy: true` — honors `X-Forwarded-Proto` from nginx. No app change needed.
- [x] `infra/nginx/README.md` runbook: `certbot certonly --nginx` for both names → install vhost → `nginx -t && systemctl reload nginx` (reload, **not** restart — OpsCore shares this nginx) → verify `/healthz` + `/readyz`.
- [ ] **HOST STEP (needs A0):** run the runbook on `178.105.58.173` — obtain certs, enable vhost, reload.
- **Done when:** both URLs serve over HTTPS (`https://api.timepro.systemsd.co/readyz` → db:ok).

### A4 · OpsCore prod wiring ⏳ *(user-gated)*
- [ ] OpsCore prod `.env`: `TIMEPRO_URL=https://timepro.systemsd.co`; verify shared secrets match; restart.
- [ ] **Commit OpsCore's uncommitted integration files** (handoff + sync routes, `lib/timepro.ts`, `auth.config.ts` edit) — at risk per HANDOFF §8.
- **Done when:** OpsCore handoff redirect targets the live TimePro web.

### A5 · Migrate, deploy, smoke-test 🔴
- [ ] Run `migrate` against prod Postgres.
- [ ] Bring stack up; verify end-to-end: OpsCore login → JIT org → Team "Sync from OpsCore" → API over HTTPS → realtime presence WS connects.
- **Done when:** ✅ a real user can log into TimePro on the public web. *(Group A complete.)*
- **Note:** once A6 (deploy workflow) is live, A5 is performed *by* the workflow (push to main) rather than by hand — this manual run is the first-time bring-up / fallback.

### A6 · Backend deploy workflow (CI/CD on push to main) 🟡 *(rewritten to mirror OpsCore 2026-06-17; needs server + secrets to run)*
- [x] `.github/workflows/deploy.yml` — **same shape as OpsCore's deploy** (uses `appleboy/ssh-action@v1.0.3` + `VPS_*` secrets). On push to `main` (+ `workflow_dispatch`), two jobs:
  - **`verify-build`** — rsync `/var/www/timepro` → `/var/www/timepro-staging`, `git reset --hard origin/main`, `docker compose -f docker-compose.prod.yml build`. If it fails, deploy never runs (prod untouched).
  - **`deploy`** (needs verify) — in `/var/www/timepro`: `git reset --hard origin/main` (untracked env files preserved) → `docker compose -f docker-compose.prod.yml up -d --build` (migrate one-shot first) → poll `/readyz` (dumps api logs + fails on timeout) → prune + clean staging. `concurrency` group prevents overlapping deploys; `command_timeout: 30m` for Docker builds.
- [x] **Validated:** YAML parses clean (both workflows). Live run needs the VPS + secrets.
- [ ] **One-time host setup:** clone repo to **`/var/www/timepro`**, create the env files (`infra/compose/.env` + `infra/compose/envs/api.env`, both gitignored), `VPS_USER` in the `docker` group, run nginx/certbot once (A3). ⚠️ **Docker daemon must be running** (`systemctl enable --now docker`) and the **`.env` must exist before `docker compose build`** — otherwise `POSTGRES_*`/`NEXT_PUBLIC_*` resolve blank.
- [ ] **GitHub secrets** (TimePro repo — same values as OpsCore's, same VPS): `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`.
- [ ] Decision (pending): build-on-host (current) vs CI→GHCR→pull (scale-up).
- **Done when:** a push to `main` auto-deploys and `/readyz` is green on the host.

---

## 3. GROUP B — Make the desktop app downloadable

### B1 · Pre-build config ✅ *(done 2026-06-16 — URLs baked)*
- [x] `state.rs`: `PRODUCTION_API_BASE=https://api.timepro.systemsd.co`, `PRODUCTION_WEB_BASE=https://timepro.systemsd.co`. Resolution order unchanged (runtime env → compile-time `option_env!` → constant), so CI can still override.
- [x] Confirmed **no other `timepro.app` references** in the desktop. Version stays `0.1.0` for the inaugural release (releases are driven by `v*` tags, not a manual bump). Bundle metadata/icons already present (`identifier app.timepro.agent`, targets `all`).
- [x] Note: the webview CSP `connect-src` still lists `http://localhost:3001` — harmless, because the UI calls Rust via `invoke()` and never hits the API directly (Rust does all HTTP). Re-verify at B5.
- **Done when:** ✅ prod hosts are baked. The actual installer is produced by B2's CI (building a real installer locally needs the full Rust/Tauri toolchain and yields only a mac artifact here).

> ⚠️ **Hosting revision (2026-06-18):** the code repo `systemsd/timepro` is **private**, and GitHub release
> downloads **inherit repo visibility** — so a private repo's installers can't be fetched by the page's
> unauthenticated API call *or* downloaded by employees (who aren't GitHub users). There's no "public releases on
> a private repo" toggle. **Fix:** publish installers to a **separate PUBLIC repo `systemsd/timepro-downloads`**
> (binaries only, no source); the code repo stays private. Considered alternatives — server proxy w/ token (B),
> host on server/S3 (C) — but A′ (separate public repo) is the least infra and keeps GitHub as the artifact store.

### B2 + B3 · Cross-platform CI build → public downloads repo 🟡 *(reworked 2026-06-18; first real run needs a `v*` tag)*
- [x] `.github/workflows/desktop-release.yml` — **two-phase** (private GITHUB_TOKEN can't write cross-repo):
  - **build** (matrix: `macos-latest` ×2 aarch64+x86_64, `ubuntu-22.04`, `windows-latest`) → `tauri-action` builds installers (no `tagName` → build-only) → `upload-artifact` each platform's bundles.
  - **publish** (single job) → `download-artifact` all → `softprops/action-gh-release` creates ONE draft Release in **`systemsd/timepro-downloads`** via `secrets.RELEASES_REPO_TOKEN` (fine-grained PAT, Contents:write on the downloads repo).
- [x] **Unsigned** (no signing secrets) — release body tells users how to approve in Gatekeeper/SmartScreen. Bakes `TIMEPRO_API_URL`/`TIMEPRO_WEB_URL` at compile time (reinforces B1 constants).
- [x] **Validated:** YAML parses (`build`→`publish`, `publish` needs `build`). **Local build proven** (2026-06-18): `tauri build` on Intel mac → `TimePro.app` + `TimePro_0.1.0_x64.dmg` (5.75 MB); the built app launches, OpsCore loopback login works, authenticates against **prod** — so the CI artifacts will be functional.
- **Setup done by Hamid:** public repo `timepro-downloads` created (+ a README commit so a release tag has a target), fine-grained PAT added as `RELEASES_REPO_TOKEN` in the `timepro` repo.
- [ ] **NEEDS:** this branch merged to `main` (tag triggers run from the default branch), then push `v0.1.0` → builds 4 targets → **publish the draft Release**.
- **Done when:** tagging `vX.Y.Z` produces a draft Release **in `timepro-downloads`** with installers for all four targets.

### B4 · Wire the Download page ✅ *(done 2026-06-17; repointed 2026-06-18)*
- [x] `apps/web/src/app/download/page.tsx` resolves installer URLs from the **latest published Release of `systemsd/timepro-downloads`** (public → the page's anonymous `api.github.com/repos/systemsd/timepro-downloads/releases/latest` works for employees), matching assets by pattern (`.dmg`+`aarch64` → Apple Silicon, `.dmg`+`x64` → Intel, `.exe`/`.msi` → Windows, `.AppImage`/`.deb` → Linux). **Why not static `releases/latest/download/<asset>`:** Tauri bundle names embed the version (`TimePro_0.1.0_x64.dmg`), so a literal path breaks on every version bump; pattern-matching the latest release stays correct. Browser extension link still points at `apps/extension` in the private code repo (separate concern — extension is loaded unpacked).
- [x] Swapped interim "build locally" copy → real buttons + **unsigned Gatekeeper/SmartScreen** approval note (shows latest tag). Loading + "no release yet / build-locally" fallback states; disabled placeholder buttons for targets without an asset. ✅ `pnpm --filter @timepro/web typecheck` clean.
- **Done when:** ✅ the live Download page hands out working installers — *fully wired; resolves live once the first `v0.1.0` Release is published to `timepro-downloads` (drafts are invisible to the public API, as expected).*

### B5 · End-to-end verification on a clean machine 🔴 *(also satisfies group C "tracking visible")*
- [ ] Download from live page → install → OpsCore loopback login → start timer.
- [ ] Confirm tracking is visible: desktop green ticking clock; web presence dot → "tracking", screenshots appear, Timeline populates — all against prod.
- **Done when:** ✅ download → install → track → see it, fully working. *(Group B complete; original requirement met.)*

---

## 4. Parked — Group C polish (tracking visibility), not required for this feature

Tracking visibility already works end-to-end; these are optional enhancements surfaced during scoping.

- 🔴 **C2** Desktop system-tray indicator (tracking state visible when window minimized/hidden).
- 🔴 **C3** Employee self "tracking active" banner on their own web dashboard.
- 🔴 **C4** More-immediate (vs historical) activity / last-screenshot feedback.

---

## 5. Progress log

Append dated entries as work lands.

- **2026-06-16** — Scoped the feature; locked the 4 decisions (§0); wrote this tracker. Build not started.
- **2026-06-16** — A0 decisions made: co-locate on OpsCore host `178.105.58.173`; subdomains `timepro.systemsd.co` + `api.timepro.systemsd.co` (both confirmed free). DNS records handed to user; A0 blocked on user adding them. Noted OpsCore repo absent locally (affects A4).
- **2026-06-16** — **A1 done.** Wrote 3 Dockerfiles + `.dockerignore`; all build & boot via local `docker build` (Docker 27.4 present). Fixed 4 latent issues found by actually building: tsup wasn't bundling `@timepro/db` (prod boot broken), `pg` dynamic-require crash (added pg+uuid to api deps), missing Next `standalone` output, non-deterministic `turbo` prune (pinned 2.9.16). Build context now excludes the multi-GB Rust target dir. Files uncommitted.
- **2026-06-16** — **A2 done.** Wrote `docker-compose.prod.yml` + env templates; ran the full stack locally and verified end-to-end (postgres→migrate→api→web; `/readyz` db:ok; 19 tables migrated). Confirmed Redis is genuinely unused (placeholder, no container). Fixed nonroot screenshot-volume ownership via a seeded dir in the api image. Pre-validates the A5 migration path. Files uncommitted.
- **2026-06-16** — Committed A1+A2 on branch `feat/backend-deploy-pipeline` (`40d3905`, `2861049`).
- **2026-06-16** — **A3 authored.** Wrote `infra/nginx/timepro.systemsd.co.conf` + runbook; `nginx -t` passes (validated in a container with stub certs). Confirmed API `trustProxy: true`. Apply step (certs + reload on host) blocked on A0. Files uncommitted.
- **2026-06-16** — Committed A3 (`a09a9db`). **B1 done** — baked `*.systemsd.co` hosts into `state.rs`. **B2/B3 authored** — `desktop-release.yml` (4-target matrix, unsigned, drafts a GitHub Release); YAML + actionlint clean. First CI run needs a GitHub remote + a `v*` tag. Remote exists: `github.com:systemsd/timepro.git`.
- **2026-06-16** — A0 DNS verified resolving (`@1.1.1.1` → `178.105.58.173`).
- **2026-06-16** — **A6 authored** — `deploy.yml` (push-to-main → SSH → compose up --build → /readyz health-gate). Per manager's CI/CD direction. YAML + actionlint clean. Needs one-time host setup + GitHub secrets. Domain re-verified: `timepro` resolves, `timppro` (Slack typo) does not.
- **2026-06-17** — **B4 done.** Wired `download/page.tsx` to the latest GitHub Release via the public API (pattern-matched assets, version-agnostic), real unsigned-installer copy + loading/fallback states; typecheck clean. Resolves live once the first release is published.
- **2026-06-16** — **Local dry-run (Path B)** — pre-validates the "tracking is visible" chain (B5/C1) on this Mac without the server. Local stack already running (API:4001/web:3005/pg container). Simulated the desktop agent for **Muhammad Anas** via the API (dev-header auth): `timer/start` → `agent/heartbeat` → `ingest/activity` (2 samples) → `screenshots` (a real 6.9 MB `screencapture` PNG → DB + disk). Verified visible: `/v1/roster` (as admin) returns `Muhammad Anas | presence=tracking | last_screenshot=True`; screenshot servable `[200] image/png`. **Note:** Rust toolchain was NOT installed on this machine (native desktop app couldn't launch) — installing it for Path A (real native-app run).
- **2026-06-18** — **Backend deploy live + Download repointed.** Prod is up (`timepro.systemsd.co` web / `api.timepro.systemsd.co` `readyz` db:ok), OpsCore login handoff verified end-to-end (after Hamid fixed OpsCore `TIMEPRO_URL`). Branch `feat/timeline-reports-settings-revamp` merged to `main` and auto-deployed. **Download hosting revised** (branch `feat/download-installers`): private-repo gap surfaced → installers move to a separate **public** repo `systemsd/timepro-downloads`; `desktop-release.yml` reworked to two-phase (build artifacts → publish to downloads repo via `RELEASES_REPO_TOKEN` PAT), `download/page.tsx` repointed there. **Local `tauri build` verified** → `TimePro_0.1.0_x64.dmg` (5.75 MB); built app launches + OpsCore login + auth against prod. Remaining: merge `feat/download-installers` → `main`, push `v0.1.0`, publish the draft Release.
</content>
</invoke>
- **2026-06-23 → 24** — **Desktop arc v0.1.8/v0.1.9 authored.** v0.1.8: "Paused" status on idle/sleep + ships the sleep/idle **back-dating** fix (away time no longer billed — was the inflated 16h/24h roster totals). v0.1.9: **capture-loop diagnostics** (`capture status`, `capture_ms`/`upload_ms`, `capture loop slow`) to trace a "screenshots not landing on cadence" report from a field user. Both `cargo check` clean. Web side same arc: editable Timeline activities, grouped activity layout, dashboard screenshot-flood fix, screenshot delete UX.
- **2026-06-24 → 29** — **Release pipeline blocked by two org-account issues (cost ~a day).** (1) **`RELEASES_REPO_TOKEN` 403** on release-create: the fine-grained PAT was read-only / owned by a personal account → can't write to the org's `timepro-downloads`. Fixed with a **classic PAT (`repo` scope)**. (2) **GitHub Actions billing hard-stop:** the org's new *Budgets* feature defaulted the **Actions budget to $0 + "stop usage"** with no payment method, so once the 2,000 free min ran out **no job would start** (deploy or release). macOS runners are 10× minutes; each desktop release builds on 2 macOS + 1 Windows (~300 min/release). Builds succeeded but `version-check`/`publish` couldn't start.
- **2026-06-29 → 30** — **Unblocked + shipped.** Temporary workaround: made `systemsd/timepro` **public for ~2 days** (public repos get free Actions) to clear the backlog, with the plan to revert to private at the next billing cycle. ⚠️ Exposure is effectively permanent — flagged the committed OpsCore dev secrets (`OPSCORE_HANDOFF_SECRET` signs the login JWT) for **rotation**. Re-ran Deploy (web changes live) and Desktop Release. Published **v0.1.10** (accumulated work) then **v0.1.11** (`fix/desktop-decouple-upload`): uploads now run off the capture loop. **Verified in field logs** — a user whose uploads take 15–21 s now gets a steady 2-min screenshot cadence (no more loop-slow / missing shots). Permanent fix for the billing block: add a card + non-$0 org Actions budget.
- **2026-06-30 (later)** — **Reporting self-heal + desktop UX.** (1) **Abandoned-timer sweep** (`apps/api/src/lib/timer-sweep.ts`, scheduled in `server.ts` every 10 min, `asPlatform`): a timer left open across sleep/crash was counted to `now` by roster/reports — one entry hit **107h**, inflating a user's month to 138h. The sweep clamps entries with a > 15 min dead tail (no screenshots/activity/app-usage) back to last real activity (`source=system`, audited `time_entry.auto_closed`); self-healing for all users, never touches an actively-tracking user. **Verified in prod:** a user's month went **138h → 19h** on the first run. API-only → shipped via Deploy (#37, no version bump). (2) **Desktop v0.1.12** (#38): **persistent login** (`session.json` in the app data dir → restored at startup; no sign-in every launch) + **idle auto-resume** (after an idle pause, the loop starts a fresh entry the instant input returns — no manual play; idle gap unbilled). **Verified in field logs (Anas):** quit/reopen with 0 new logins; `auto-paused (idle=303)` → `auto-resumed` 13s later.
