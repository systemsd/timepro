# TrackFlow

A production-grade, multi-tenant employee time-tracking and productivity-monitoring platform — comparable in scope to Hubstaff, Time Doctor, and ScreenshotMonitor.

> **Status:** architecture + scaffold. Implementation tracks the roadmap in [`docs/11-roadmap.md`](docs/11-roadmap.md).

---

## What's in this repo

- **`docs/`** — complete production-ready architecture documentation (13 documents). Start with [`docs/00-overview.md`](docs/00-overview.md).
- **`apps/`** — `web` (Next.js), `api` (Fastify), `worker` (BullMQ), `scheduler`, `realtime`, `desktop` (Tauri + Rust).
- **`packages/`** — `db` (Drizzle), `shared` (types + zod), `auth` (RBAC + JWT), `ui` (shadcn), `storage` (S3 + KMS), `desktop-sdk`, plus shared dev configs.
- **`infra/`** — Docker Compose for local + staging, Nginx config, Terraform (Phase 2).

Full structure and per-app dependencies: [`docs/12-monorepo.md`](docs/12-monorepo.md).

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

> Prereqs: Node 22 (`nvm use`), pnpm 9 (`corepack enable`), Docker, Rust toolchain (only for desktop agent work).

```bash
# 1. Install JS deps
pnpm install

# 2. Bring up local infra (Postgres, Redis, Minio, MailHog)
docker compose -f infra/compose/docker-compose.dev.yml up -d

# 3. Run migrations + seed
pnpm db:migrate
pnpm db:seed

# 4. Start everything (api + web + worker + scheduler)
pnpm dev
```

Then:

- Web: <http://localhost:3000>
- API: <http://localhost:3001>
- API docs (OpenAPI / Stoplight): <http://localhost:3001/docs>
- Minio console: <http://localhost:9001> (`minio` / `minio123`)
- MailHog: <http://localhost:8025>

Desktop agent (separate terminal, after the API is running):

```bash
pnpm --filter @trackflow/desktop tauri dev
```

---

## Common scripts

```bash
pnpm dev                       # Run all apps in watch mode
pnpm build                     # Build everything (turbo orchestrated)
pnpm lint                      # ESLint across the monorepo
pnpm typecheck                 # TypeScript --noEmit across the monorepo
pnpm test                      # Unit + integration tests
pnpm db:generate               # Drizzle: diff schema → migration SQL
pnpm db:migrate                # Apply pending migrations
pnpm db:studio                 # Drizzle Studio
pnpm gen:openapi               # Emit OpenAPI from API route schemas
pnpm gen:sdk                   # Regenerate @trackflow/desktop-sdk
```

---

## Repository conventions

- **Conventional Commits** (`feat:`, `fix:`, `chore:`, …).
- Trunk-based with short-lived branches; PR required for `main`.
- CI: lint + type-check + test + OpenAPI/SDK drift check on every PR.
- Migrations are **expand-only**. Forward-only DB changes.
- Public-facing API changes require an OpenAPI diff review and `BREAKING:` label when applicable.

---

## License

Proprietary. © TrackFlow. All rights reserved.
