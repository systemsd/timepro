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

**Status:** 🟡 In progress — planning complete, build not started.
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
- [ ] **USER ACTION** — add two DNS A-records (DNS-only / not proxied, matching opscore):
  - `timepro.systemsd.co.` → `178.105.58.173`
  - `api.timepro.systemsd.co.` → `178.105.58.173`
- [ ] Verify both resolve: `dig +short timepro.systemsd.co api.timepro.systemsd.co` → `178.105.58.173`.
- [ ] Confirm SSH access to `178.105.58.173`.
- **Done when:** host has SSH access + both DNS names resolve to `178.105.58.173`.
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

### A3 · Nginx + TLS 🔴 *(mirror OpsCore)*
- [ ] nginx vhosts: `timepro.systemsd.co` → web:3005, `api.timepro.systemsd.co` → api:4001, with `/v1/realtime` WebSocket upgrade headers.
- [ ] Let's Encrypt (certbot) for both names.
- **Done when:** both URLs serve over HTTPS.

### A4 · OpsCore prod wiring ⏳ *(user-gated)*
- [ ] OpsCore prod `.env`: `TIMEPRO_URL=https://timepro.systemsd.co`; verify shared secrets match; restart.
- [ ] **Commit OpsCore's uncommitted integration files** (handoff + sync routes, `lib/timepro.ts`, `auth.config.ts` edit) — at risk per HANDOFF §8.
- **Done when:** OpsCore handoff redirect targets the live TimePro web.

### A5 · Migrate, deploy, smoke-test 🔴
- [ ] Run `migrate` against prod Postgres.
- [ ] Bring stack up; verify end-to-end: OpsCore login → JIT org → Team "Sync from OpsCore" → API over HTTPS → realtime presence WS connects.
- **Done when:** ✅ a real user can log into TimePro on the public web. *(Group A complete.)*

---

## 3. GROUP B — Make the desktop app downloadable

### B1 · Pre-build config 🔴 *(can start once A0 hostnames fixed)*
- [ ] `state.rs`: `PRODUCTION_API_BASE=https://api.timepro.systemsd.co`, `PRODUCTION_WEB_BASE=https://timepro.systemsd.co`.
- [ ] Bump version (`tauri.conf.json` + `Cargo.toml`); confirm bundle metadata/icons.
- **Done when:** local `tauri build` produces an installer pointing at prod.

### B2 + B3 · Cross-platform CI build → GitHub Releases 🔴 *(fold together)*
- [ ] `.github/workflows/desktop-release.yml` using `tauri-apps/tauri-action`, matrix: `macos-latest` (arm64 + x64), `windows-latest`, `ubuntu-latest`; trigger on `v*` tag.
- [ ] Unsigned (omit signing secrets).
- [ ] Action drafts a GitHub Release + uploads `.dmg` / `.exe` / `.AppImage`.
- **Done when:** tagging `vX.Y.Z` produces a Release with installers for all four targets.

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
</content>
</invoke>
