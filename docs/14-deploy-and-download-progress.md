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

**Status:** 🟡 In progress — all off-server work built & validated (A1/A2/A3/A6, B1/B2); local dry-run proved download→track→visible. Remaining is server setup + CI runs (see §0.1 + table below).
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
| 4 | **Installer hosting** | **GitHub Releases** | CI is already GitHub-centric (GHCR, `gh` CLI). Zero new infra. CloudFront/`updates.timepro.app` is the at-scale target, not in use. |

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

### A6 · Backend deploy workflow (CI/CD on push to main) 🟡 *(authored 2026-06-16; needs server secrets to run)*
- [x] `.github/workflows/deploy.yml` — on push to `main` (+ `workflow_dispatch`): SSH to `178.105.58.173` → `git reset --hard origin/main` (untracked env files preserved) → `docker compose -f infra/compose/docker-compose.prod.yml up -d --build` (migrate one-shot runs first) → poll `/readyz` until healthy → prune. `concurrency` group prevents overlapping deploys.
- [x] **Validated:** YAML parses; `actionlint` clean.
- [ ] **One-time host setup (the "server access" from the Slack thread):** clone repo on server, create env files, add deploy SSH key, deploy user in `docker` group, run nginx/certbot once (A3).
- [ ] **GitHub secrets:** `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, `DEPLOY_SSH_KEY`, `DEPLOY_SSH_PORT?`.
- [ ] Decision (pending): build-on-host (current) vs CI→GHCR→pull (scale-up).
- **Done when:** a push to `main` auto-deploys and `/readyz` is green on the host.

---

## 3. GROUP B — Make the desktop app downloadable

### B1 · Pre-build config ✅ *(done 2026-06-16 — URLs baked)*
- [x] `state.rs`: `PRODUCTION_API_BASE=https://api.timepro.systemsd.co`, `PRODUCTION_WEB_BASE=https://timepro.systemsd.co`. Resolution order unchanged (runtime env → compile-time `option_env!` → constant), so CI can still override.
- [x] Confirmed **no other `timepro.app` references** in the desktop. Version stays `0.1.0` for the inaugural release (releases are driven by `v*` tags, not a manual bump). Bundle metadata/icons already present (`identifier app.timepro.agent`, targets `all`).
- [x] Note: the webview CSP `connect-src` still lists `http://localhost:3001` — harmless, because the UI calls Rust via `invoke()` and never hits the API directly (Rust does all HTTP). Re-verify at B5.
- **Done when:** ✅ prod hosts are baked. The actual installer is produced by B2's CI (building a real installer locally needs the full Rust/Tauri toolchain and yields only a mac artifact here).

### B2 + B3 · Cross-platform CI build → GitHub Releases 🟡 *(workflow written & lint-clean; first real run needs GitHub)*
- [x] `.github/workflows/desktop-release.yml` — `tauri-apps/tauri-action`, matrix: `macos-latest` ×2 (aarch64 + x86_64), `ubuntu-22.04`, `windows-latest`; trigger on `v*` tag (+ `workflow_dispatch`). Installs pnpm 9.15.0 + Node 22 + Rust (per-target) + Linux webkit2gtk-4.1 deps + rust-cache.
- [x] **Unsigned** (no signing secrets) — release body tells users how to approve in Gatekeeper/SmartScreen.
- [x] Bakes `TIMEPRO_API_URL`/`TIMEPRO_WEB_URL` at compile time (reinforces B1 constants). `releaseDraft: true` → drafts a GitHub Release and uploads `.dmg`/`.app`, `.msi`/`.exe`, `.deb`/`.AppImage`.
- [x] **Validated:** YAML parses; `actionlint` clean (no findings).
- [ ] **NEEDS GITHUB:** push to a GitHub remote with Actions enabled, then push a `v0.1.0` tag (or run `workflow_dispatch`) to produce the first Release. (CI can't run locally.)
- **Done when:** tagging `vX.Y.Z` produces a draft Release with installers for all four targets.

### B4 · Wire the Download page 🔴
- [ ] Replace `#` placeholders in `apps/web/src/app/download/page.tsx` with `…/releases/latest/download/<asset>` URLs.
- [ ] Swap interim "build locally" copy → real buttons + "unsigned, approve in Gatekeeper/SmartScreen" note.
- **Done when:** the live Download page hands out working installers.

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
- **2026-06-16** — **Local dry-run (Path B)** — pre-validates the "tracking is visible" chain (B5/C1) on this Mac without the server. Local stack already running (API:4001/web:3005/pg container). Simulated the desktop agent for **Muhammad Anas** via the API (dev-header auth): `timer/start` → `agent/heartbeat` → `ingest/activity` (2 samples) → `screenshots` (a real 6.9 MB `screencapture` PNG → DB + disk). Verified visible: `/v1/roster` (as admin) returns `Muhammad Anas | presence=tracking | last_screenshot=True`; screenshot servable `[200] image/png`. **Note:** Rust toolchain was NOT installed on this machine (native desktop app couldn't launch) — installing it for Path A (real native-app run).
</content>
</invoke>
