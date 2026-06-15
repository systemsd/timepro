# TimePro

A production-grade, multi-tenant employee time-tracking and productivity-monitoring platform — comparable in scope to Hubstaff, Time Doctor, and ScreenshotMonitor.

> **Status:** working MVP across web, API, and desktop agent — time tracking, automatic
> screenshot capture, web dashboard, login, desktop→web auto-login, and team management.
> Tracks the roadmap in [`docs/11-roadmap.md`](docs/11-roadmap.md).
>
> Working on this repo with Claude Code? Read [`CLAUDE.md`](CLAUDE.md) first.

---

## What's in this repo

- **`docs/`** — complete architecture documentation (13 documents). Start with [`docs/00-overview.md`](docs/00-overview.md).
- **`apps/`** — `api` (Fastify), `web` (Next.js), `desktop` (Tauri + Rust + React). *Built.*
- **`packages/`** — `db` (Drizzle), `tsconfig`, `eslint-config`. *Built.*
- **`infra/`** — Docker Compose for local dev (Postgres, Redis, Minio, MailHog), OTel collector.

> The docs describe additional services (`worker`, `scheduler`, `realtime`) and packages
> (`shared`, `auth`, `ui`, `storage`, `desktop-sdk`) that are **planned but not yet scaffolded**.
> See [`docs/12-monorepo.md`](docs/12-monorepo.md) for the full target layout.

---

## Documentation map

| #  | Doc                                                          | What it covers                                        |
| -- | ------------------------------------------------------------ | ----------------------------------------------------- |
| 00 | [Overview](docs/00-overview.md)                              | Product, high-level diagram, principles, doc map      |
| 01 | [System architecture](docs/01-system-architecture.md)        | Services, runtime contracts, tenancy, auth, observability |
| 02 | [Database schema](docs/02-database-schema.md)                | ERD, SQL DDL, partitioning, indexes, RLS              |
| 03 | [API design](docs/03-api-design.md)                          | REST routes, auth, idempotency, errors, rate limits   |
| 04 | [Desktop agent](docs/04-desktop-agent.md)                    | Tauri/Rust architecture, capture, offline sync        |
| 05 | [Queue architecture](docs/05-queue-architecture.md)          | BullMQ queues, jobs, cron, retries, DLQ               |
| 06 | [Reporting](docs/06-reporting.md)                            | Rollup tables, materialized views, exports            |
| 07 | [Storage](docs/07-storage.md)                                | S3 layout, lifecycle, encryption, CDN                 |
| 08 | [Security](docs/08-security.md)                              | RBAC, audit, encryption, MFA, device trust            |
| 09 | [Deployment](docs/09-deployment.md)                          | Docker, Nginx, CI/CD, backups, sizing                 |
| 10 | [Scaling](docs/10-scaling.md)                                | Capacity model, costs from 100 → 10k orgs             |
| 11 | [Roadmap](docs/11-roadmap.md)                                | MVP, Phase 2, Phase 3                                 |
| 12 | [Monorepo execution](docs/12-monorepo.md)                    | Concrete folder layout, dependencies, env vars        |

---

## Quickstart (local dev)

> Prereqs: Node 20 (`nvm use`), pnpm 9 (`corepack enable`), a reachable Postgres, and — for the
> desktop agent only — the Rust toolchain (`rustup`).

```bash
# 1. install
pnpm install

# 2. local infra (optional — skip if you run your own Postgres; set DATABASE_URL in .env)
docker compose -f infra/compose/docker-compose.dev.yml up -d

# 3. database
cp .env.example .env          # then edit DATABASE_URL / DATABASE_ADMIN_URL
pnpm db:generate              # first run only: produce the initial migration
pnpm db:migrate               # apply migrations (auto-creates citext + pgcrypto)
pnpm db:seed                  # demo org + owner + team + projects

# 4. run the API and web (separate terminals)
pnpm --filter @timepro/api dev      # → http://localhost:3001
pnpm --filter @timepro/web dev      # → http://localhost:3000

# 5. desktop agent (separate terminal; needs the API running)
source "$HOME/.cargo/env"
TIMEPRO_API_URL=http://localhost:3001 pnpm --filter @timepro/desktop tauri:dev
```

Sign in (web or desktop) with **`owner@timepro.local`** (email-only MVP login).

Local services when using the Compose stack:

- Web: <http://localhost:3000> · API: <http://localhost:3001>
- Minio console: <http://localhost:9001> (`minio` / `minio123`) · MailHog: <http://localhost:8025>

---

## Common scripts

```bash
pnpm build                     # turbo build across workspaces
pnpm typecheck                 # tsc --noEmit across workspaces
pnpm db:generate               # drizzle-kit: schema diff → migration SQL
pnpm db:migrate                # apply pending migrations
pnpm db:seed                   # seed demo data
pnpm db:studio                 # drizzle studio
pnpm gen:openapi               # emit OpenAPI from API route schemas
```

> `pnpm lint` is currently a stub (ESLint not yet wired — see `packages/eslint-config`).

---

## Repository conventions

- **Conventional Commits** (`feat:`, `fix:`, `chore:`, …). Branch before committing on `main`.
- Migrations are **expand-only / forward-only** — never roll back the DB; write a new migration.
- The desktop agent's API URL is **baked at build time**, not user-entered — set `PRODUCTION_API_BASE`
  in `apps/desktop/src-tauri/src/state.rs` before building installers.
- More conventions and gotchas: [`CLAUDE.md`](CLAUDE.md).

---

## License

Proprietary. © TimePro. All rights reserved.
