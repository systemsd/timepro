# TimePro — Project Brief

**What it is:** A multi-tenant employee time-tracking + screenshot-monitoring platform (Hubstaff / Time Doctor class). Three surfaces: web console (Next.js 14), desktop agent (Tauri + Rust + React), REST API (Fastify + Drizzle). Integrated with **OpsCore** as the upstream identity and directory system.

**Monorepo:** Turborepo + pnpm, Node 20. Apps: `api` (:4001), `web` (:3005), `desktop`. Packages: `db`, `tsconfig`, `eslint-config`.

---

## Phase status

| Phase | Status | Summary |
|-------|--------|---------|
| 0 — Quick wins | Done | Home dashboard (role-aware), Timeline, Projects/Clients, Download page, RBAC |
| 1 — Settings engine | Done | Org default + per-user overrides; agent enforces screenshots/tracking/idle/weekly-limit |
| 2 — Presence | Done | Agent heartbeat → in-memory store → 3-state dots + "N online" |
| 3 — OpsCore integration | Done | Handoff-JWT web login + Bearer directory sync; desktop loopback login via web bridge |
| 4 — Activity + App + URL tracking | Done | Agent ingest → Timeline + Reports; browser extension built (unverified in real browser) |
| 5 — Reports + realtime | Done | Reports console (Summary/Detailed/Weekly/Apps+URLs, CSV/PDF, saved), WS presence |
| 6 — Multi-tenancy & real auth | Paused | Single-tenant Systemsd is current focus; real JWT/Argon2/RLS deferred |
| 7 — Ship pipeline | In progress | Desktop CI builds done; backend live on prod; Download page wired to public `timepro-downloads` repo |

---

## Current active work (as of 2026-06-16)

Deploy & Download feature — making the app downloadable and the backend publicly accessible.

**Decisions locked:**
- Host: Ubuntu VPS `167.233.136.204`, Docker + nginx + Let's Encrypt
- Domains: `timepro.systemsd.co` (web), `api.timepro.systemsd.co` (API)
- Installers: unsigned interim builds, hosted on GitHub Releases in a separate public repo (`systemsd/timepro-downloads`) — code repo is private
- Push to `main` → auto-deploy via `appleboy/ssh-action`

**What's done:**
- Backend is live and verified — `timepro.systemsd.co` and `api.timepro.systemsd.co/readyz` return `db:ok`
- OpsCore login handoff verified end-to-end against prod
- Desktop CI workflow (`desktop-release.yml`): tag `v*` → build 4 OS targets → publish one draft Release to `timepro-downloads` via a PAT
- Download page wired to read from `timepro-downloads`

**What remains (Group B):**
1. Merge `feat/download-installers` → `main`
2. Push tag `v0.1.0` → CI builds + publishes draft Release
3. Publish the draft (drafts are invisible to the Download page's public API call)
4. Verify download → install → track on a clean machine

---

## Pending (longer horizon)

- **Phase P:** keyboard/mouse activity counts, Reports shareable links
- **Phase 8:** reporting rollups + scheduler, S3 storage, Redis-backed presence
- **Phase 9:** billing + plans
- **Phase 6:** multi-tenancy + real auth — resume when going multi-company

---

## Key gotchas

- Web runs on **:3005** (not 3000) — prod OpsCore's nginx would clobber the handoff redirect on 3000
- `pkill -f "next dev"` kills OpsCore too — kill by port instead
- Desktop API base URL is **baked at build time** in `state.rs` (`PRODUCTION_API_BASE`)
- Root `.env` `NEXT_PUBLIC_*` vars are ignored by the web — those live in `apps/web/.env.local`
- pnpm 9 has no `--env-file` — use `loadRootEnv()` helpers
