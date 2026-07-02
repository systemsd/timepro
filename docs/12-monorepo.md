# TimePro — Monorepo (Execution Spec)

> **Implementation status** — ✅ built · ⛔ planned.
>
> - ✅ Scaffolded: apps `api`, `web`, `desktop`; packages `db`, `tsconfig`, `eslint-config`.
> - ⛔ Described here but **not yet scaffolded:** apps `worker`, `scheduler`, `realtime`; packages `shared`, `auth`, `ui`, `storage`, `desktop-sdk`, `tailwind-config`. Codegen (`gen:openapi`/`gen:sdk`) is stubbed.
>
> This spec is the target layout; current reality is in [`CLAUDE.md`](../CLAUDE.md).

Turborepo + pnpm. Workspaces driven by `pnpm-workspace.yaml`. Turbo pipelines for build/test/lint with remote caching (Turbo Cloud or self-hosted).

## 1. Top-Level Layout

```
timepro/
├── apps/
│   ├── web/                    # Next.js dashboard
│   ├── api/                    # Fastify REST API
│   ├── worker/                 # BullMQ workers
│   ├── scheduler/              # Cron emitter
│   ├── realtime/               # WebSocket hub
│   └── desktop/                # Tauri agent (Rust + React)
├── packages/
│   ├── db/                     # Drizzle schema + migrations + repo helpers
│   ├── shared/                 # Shared types, zod schemas, utilities
│   ├── auth/                   # Auth core, abilities (RBAC), token handling
│   ├── ui/                     # shadcn/ui re-exports + TimePro components
│   ├── storage/                # S3 client, presign, encryption envelopes
│   ├── desktop-sdk/            # TS client generated from OpenAPI; used by `desktop`'s UI tests + integration
│   ├── eslint-config/          # Shared ESLint config
│   ├── tsconfig/               # Shared tsconfig presets
│   └── tailwind-config/        # Shared Tailwind preset
├── tools/
│   ├── docker/                 # Per-service Dockerfiles
│   ├── scripts/                # Generation, migrations, seed
│   └── otel-collector/         # OTLP collector config
├── infra/
│   ├── compose/                # docker-compose.dev.yml, .staging.yml
│   ├── nginx/                  # Nginx confs per env
│   └── terraform/              # Cloud infra (Phase 2)
├── .github/
│   └── workflows/              # CI per app + shared
├── docs/                       # Architecture docs (this folder)
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

### 1.1 `pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### 1.2 `turbo.json` (excerpt)

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": ["**/.env.*local"],
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "src-tauri/target/release/**"]
    },
    "dev": { "cache": false, "persistent": true },
    "lint": { "outputs": [] },
    "test": { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "typecheck": { "dependsOn": ["^build"], "outputs": [] },
    "db:generate": { "cache": false },
    "db:migrate": { "cache": false }
  }
}
```

### 1.3 Root `package.json` (excerpt)

```json
{
  "name": "timepro",
  "private": true,
  "packageManager": "pnpm@9.10.0",
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "db:generate": "turbo run db:generate --filter=@timepro/db",
    "db:migrate": "turbo run db:migrate --filter=@timepro/db"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.6.0",
    "@timepro/eslint-config": "workspace:*",
    "@timepro/tsconfig": "workspace:*"
  }
}
```

---

## 2. Apps

### 2.1 `apps/web` — Next.js dashboard

**Responsibility**: marketing + SaaS web console. SSR + RSC. Auth pages, dashboard, settings, gallery.

**Folder structure**

```
apps/web/
├── package.json
├── next.config.mjs
├── tailwind.config.ts
├── tsconfig.json
└── src/
    ├── app/
    │   ├── (marketing)/         # public site
    │   ├── (auth)/login, register, reset/
    │   ├── (app)/
    │   │   ├── layout.tsx       # auth gate, sidebar
    │   │   ├── dashboard/page.tsx
    │   │   ├── time/page.tsx
    │   │   ├── screenshots/page.tsx
    │   │   ├── projects/[id]/page.tsx
    │   │   ├── reports/page.tsx
    │   │   ├── team/page.tsx
    │   │   └── settings/...
    │   └── api/                 # only auth callbacks + edge utilities
    ├── components/              # page-local components
    ├── lib/
    │   ├── api-client.ts        # generated from desktop-sdk for web parity
    │   ├── auth.ts              # cookie helpers, server actions
    │   └── realtime.ts          # WS client
    └── hooks/
```

**Dependencies**

- `@timepro/shared`
- `@timepro/auth`
- `@timepro/ui`
- `next`, `react`, `@tanstack/react-query`, `zod`, `tailwindcss`

**Environment variables**

```
NEXT_PUBLIC_API_URL=https://api.timepro.app
INTERNAL_API_URL=http://api:3001         # private, for server actions
AUTH_COOKIE_DOMAIN=.timepro.app
AUTH_INTERNAL_SHARED_SECRET=...          # service-to-service
SENTRY_DSN=...
```

**Build**: `next build`. Output: `.next/`. Standalone server output mode for the container.

---

### 2.2 `apps/api` — Fastify REST API

**Responsibility**: All HTTP endpoints from [03-api-design.md](03-api-design.md). Auth, business logic, ingest. Stateless.

**Folder structure**

```
apps/api/
├── package.json
├── tsconfig.json
└── src/
    ├── server.ts                # bootstrap
    ├── app.ts                   # fastify factory
    ├── plugins/
    │   ├── auth.ts              # JWT, sessions, ability builder
    │   ├── tenant.ts            # sets RLS GUC on each request
    │   ├── ratelimit.ts         # token bucket via @fastify/rate-limit + custom Redis store
    │   ├── otel.ts
    │   └── error-mapper.ts      # to RFC 9457 problem+json
    ├── routes/
    │   ├── auth.ts
    │   ├── agents.ts
    │   ├── organizations.ts
    │   ├── members.ts
    │   ├── teams.ts
    │   ├── projects.ts
    │   ├── time-entries.ts
    │   ├── timer.ts
    │   ├── ingest.ts
    │   ├── screenshots.ts
    │   ├── activity.ts
    │   ├── reports.ts
    │   ├── exports.ts
    │   ├── settings.ts
    │   ├── notifications.ts
    │   ├── webhooks.ts
    │   └── audit.ts
    ├── services/                # business logic split per domain
    │   ├── timer.ts
    │   ├── screenshots.ts
    │   ├── reports.ts
    │   └── ...
    ├── repos/                   # thin Drizzle wrappers; tenant-bound
    ├── queues/                  # enqueue helpers per BullMQ queue
    ├── schemas/                 # zod request/response shapes
    └── lib/
        ├── jwt.ts
        ├── idempotency.ts
        └── presence.ts
```

**Dependencies**

- `fastify`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/jwt`, `@fastify/swagger`, `@fastify/cookie`
- `@timepro/db`, `@timepro/auth`, `@timepro/shared`, `@timepro/storage`
- `bullmq`, `ioredis`, `zod`
- `pino`, `@opentelemetry/sdk-node`, `@sentry/node`

**Environment variables**

```
PORT=3001
DATABASE_URL=...
REDIS_URL=...
S3_BUCKET_SCREENSHOTS=timepro-screenshots
S3_BUCKET_EXPORTS=timepro-exports
S3_REGION=us-east-1
KMS_KEY_ID=...
JWT_SIGNING_KEY_PRIMARY=...
JWT_SIGNING_KEY_NEXT=...
AUTH_REFRESH_TTL_DAYS=30
RATE_LIMIT_REDIS_PREFIX=rl:
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
LOG_LEVEL=info
```

**Build**: `tsup src/server.ts --format esm --target node22`. Output: `dist/`.

---

### 2.3 `apps/worker` — BullMQ workers

**Responsibility**: process every queue listed in [05-queue-architecture.md](05-queue-architecture.md). Single image; queue selection via env.

**Folder structure**

```
apps/worker/
├── package.json
└── src/
    ├── index.ts                 # bootstraps based on QUEUES env
    ├── processors/
    │   ├── screenshot.process.ts
    │   ├── ingest.fanout.ts
    │   ├── rollup.daily.ts
    │   ├── rollup.weekly.ts
    │   ├── rollup.monthly.ts
    │   ├── rollup.hourly.live.ts
    │   ├── notify.email.ts
    │   ├── notify.push.ts
    │   ├── export.timesheet.ts
    │   ├── export.screenshots.ts
    │   ├── retention.sweep.ts
    │   ├── webhook.delivery.ts
    │   └── agent.maintenance.ts
    ├── lib/
    │   ├── mailer.ts            # SES wrapper + MJML render
    │   ├── pdfgen.ts            # report PDFs (Phase 2)
    │   └── presence.ts
    └── workers/                 # BullMQ Worker factories per queue
```

**Dependencies**

- `bullmq`, `ioredis`
- `@timepro/db`, `@timepro/storage`, `@timepro/shared`
- `@aws-sdk/client-s3`, `@aws-sdk/client-ses`, `@aws-sdk/client-kms`
- `sharp` (thumbnails), `exceljs`, `csv-stringify`, `mjml`, `nodemailer`
- `pino`, OpenTelemetry, Sentry

**Environment variables**

```
QUEUES=screenshot.process,rollup.daily,...      # comma list
DATABASE_URL=...
REDIS_URL=...
S3_BUCKET_SCREENSHOTS=...
S3_BUCKET_EXPORTS=...
KMS_KEY_ID=...
SES_REGION=us-east-1
SES_FROM=noreply@timepro.app
WEBHOOK_USER_AGENT=TimePro-Webhook/1.0
LOG_LEVEL=info
```

**Build**: `tsup src/index.ts`. Distroless runtime.

---

### 2.4 `apps/scheduler` — Cron emitter

**Responsibility**: leader-elected singleton. Emits repeatable jobs to BullMQ on the cron schedule defined in [05-queue-architecture.md](05-queue-architecture.md).

**Folder structure**

```
apps/scheduler/
├── package.json
└── src/
    ├── index.ts                 # leader election + cron registration
    ├── leader.ts                # Redis SET NX PX leader lock
    └── jobs/
        ├── rollupDailyFanout.ts
        ├── rollupWeeklyFanout.ts
        ├── retentionSweep.ts
        ├── presenceSweep.ts
        ├── partmanMaintain.ts
        └── ...
```

**Dependencies**

- `bullmq`, `ioredis`, `node-cron`
- `@timepro/db`, `@timepro/shared`

**Environment variables**

```
DATABASE_URL=...
REDIS_URL=...
LEADER_LOCK_KEY=tf:scheduler:leader
LEADER_LOCK_TTL_MS=15000
LOG_LEVEL=info
```

---

### 2.5 `apps/realtime` — WebSocket hub

**Responsibility**: WS endpoints for browser and agent. Subscribes to Redis pubsub channels per org, fans out.

**Folder structure**

```
apps/realtime/
├── package.json
└── src/
    ├── index.ts                 # ws server (uWebSockets.js or @fastify/websocket)
    ├── auth.ts                  # JWT verify
    ├── channels/                # subscription mapping per topic
    └── pubsub.ts                # Redis adapter
```

**Dependencies**

- `@fastify/websocket` or `ws` + `uWebSockets.js`
- `ioredis`
- `@timepro/auth`, `@timepro/shared`

**Environment variables**

```
PORT=3010
REDIS_URL=...
JWT_VERIFY_KEY=...
LOG_LEVEL=info
```

---

### 2.6 `apps/desktop` — Tauri agent

**Responsibility**: per [04-desktop-agent.md](04-desktop-agent.md).

**Folder structure**

```
apps/desktop/
├── package.json
├── tauri.conf.json
├── src-tauri/                   # Rust crate (see desktop doc)
└── src/                         # React UI
    ├── App.tsx
    ├── pages/
    │   ├── Login.tsx
    │   ├── Timer.tsx
    │   └── Settings.tsx
    ├── components/
    └── ipc.ts                   # tauri invoke wrappers
```

**Dependencies (JS)**
- `react`, `vite`, `@tauri-apps/api`, `@timepro/desktop-sdk`, `@timepro/ui`

**Dependencies (Rust)**: in `Cargo.toml`:
- `tauri`, `tauri-plugin-single-instance`, `tauri-plugin-updater`, `tauri-plugin-autostart`, `tauri-plugin-store`
- `tokio`, `sqlx` (sqlite), `reqwest`, `serde`, `uuid`, `chrono`, `argon2`, `aes-gcm`, `image`, `webp`, `screencapturekit-rs` (macOS), `windows` crate (Win), `evdev` (Linux), `keyring`, `tracing`, `sentry`

**Environment variables (dev)**

```
TIMEPRO_API_URL=https://api.timepro.app
TIMEPRO_UPDATES_URL=https://updates.timepro.app
TIMEPRO_LOG_DIR=~/.timepro/logs
RUST_LOG=info
```

**Build**

- `pnpm --filter @timepro/desktop tauri build` per platform.
- macOS: signed with Developer ID, notarized.
- Windows: signed with EV cert + Authenticode.
- Linux: .AppImage + .deb + .rpm.
- Updater manifest published to `s3://timepro-agent-updates/`.

---

## 3. Packages

### 3.1 `packages/db`

**Responsibility**: Drizzle schemas, migrations, query helpers, tenant context.

```
packages/db/
├── package.json
├── drizzle.config.ts
├── src/
│   ├── client.ts                # createPool() with pg + drizzle
│   ├── tenant.ts                # withTenant(orgId, fn) wraps SET LOCAL app.organization_id
│   ├── schema/
│   │   ├── index.ts             # re-export everything
│   │   ├── organizations.ts
│   │   ├── users.ts
│   │   ├── memberships.ts
│   │   ├── teams.ts
│   │   ├── projects.ts
│   │   ├── devices.ts
│   │   ├── timeEntries.ts
│   │   ├── activitySamples.ts
│   │   ├── appUsage.ts
│   │   ├── urlUsage.ts
│   │   ├── screenshots.ts
│   │   ├── settingsScoped.ts
│   │   ├── notifications.ts
│   │   ├── auditLogs.ts
│   │   ├── timesheets.ts
│   │   └── reports.ts
│   ├── enums.ts                 # role, status, source, etc
│   └── seeds/
│       └── dev.ts
└── migrations/
    ├── 0000_init.sql
    ├── 0001_partitions.sql
    ├── 0002_rls.sql
    └── ...
```

**Dependencies**: `drizzle-orm`, `drizzle-kit`, `pg`.

**Environment variables**:
```
DATABASE_URL=...
```

**Scripts**:
```
db:generate    drizzle-kit generate
db:migrate     drizzle-kit migrate
db:studio      drizzle-kit studio
```
(No `db:seed` — data comes from OpsCore at runtime: the org is JIT-created on first OpsCore login, the rest via the directory sync.)

### 3.2 `packages/shared`

**Responsibility**: Zod schemas (request/response), domain types, time utilities, error classes. Importable by both Node and the desktop UI.

```
packages/shared/
└── src/
    ├── schemas/                 # one .ts per resource
    ├── types/                   # inferred types from zod
    ├── errors.ts                # ProblemDetails class
    ├── time.ts                  # tz-aware helpers
    └── constants.ts             # setting keys, role names
```

**Dependencies**: `zod`, `date-fns`, `date-fns-tz`.

### 3.3 `packages/auth`

**Responsibility**: JWT sign/verify, refresh rotation, abilities (CASL), password hashing, MFA.

```
packages/auth/
└── src/
    ├── jwt.ts
    ├── refresh.ts               # rotation w/ family detection
    ├── password.ts              # argon2id wrapper
    ├── mfa.ts                   # TOTP
    ├── abilities.ts             # CASL ability definitions per role
    └── middleware.ts            # framework-agnostic helpers used by api + web
```

**Dependencies**: `argon2`, `otplib`, `jose`, `@casl/ability`.

### 3.4 `packages/ui` — ✅ BUILT (but not as specced below)

> **Status update.** This package is now scaffolded and in use by `web`, but the shadcn/ui + Tailwind + Radix
> design below was **not** adopted — the app is plain-CSS + CSS-variable tokens with zero UI deps, so a
> shadcn/tailwind migration would be a big-bang rewrite against the grain. The actual package is **source-only
> React + one plain `styles.css`**, consumed via Next `transpilePackages` (no build step). First batch: `Button`,
> `Modal`/`ConfirmModal`/`PromptModal`, an accessible `Select`, and the shared line-icons. The living catalog +
> design-token contract is **[`packages/ui/ui.md`](../packages/ui/ui.md)** — read/update that, not this section.
> The library grows gradually (per-screen extraction). The block below is the original aspiration, kept for
> reference only.

**Responsibility**: shadcn/ui components + TimePro-branded primitives, used by `web` and `desktop`.

```
packages/ui/
├── components.json              # shadcn config
└── src/
    ├── primitives/              # shadcn-generated
    ├── timepro/               # branded composites
    │   ├── ProjectPicker.tsx
    │   ├── TimerButton.tsx
    │   ├── ScreenshotCard.tsx
    │   └── ActivityHeatmap.tsx
    └── theme/
        ├── tailwind.preset.ts
        └── icons.ts
```

**Dependencies**: `react`, `radix-ui` primitives, `lucide-react`, `tailwindcss`, `class-variance-authority`, `clsx`.

### 3.5 `packages/storage`

**Responsibility**: S3 + KMS wrappers; envelope encryption; presigned URL helpers; thumbnail jobs.

```
packages/storage/
└── src/
    ├── s3.ts                    # client factory
    ├── presign.ts               # PUT and GET signing
    ├── kms.ts                   # GenerateDataKey + caching
    ├── envelope.ts              # encrypt/decrypt with envelope
    ├── thumbnail.ts             # sharp-based resize
    └── keys.ts                  # path conventions (org/yyyy/mm/dd/...)
```

**Dependencies**: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/client-kms`, `sharp`.

### 3.6 `packages/desktop-sdk`

**Responsibility**: TypeScript SDK auto-generated from the API's OpenAPI spec; used by the desktop UI (and in `web` for parity tests).

```
packages/desktop-sdk/
├── package.json
├── openapi/                     # vendored spec
└── src/
    ├── client.ts                # fetch wrapper
    ├── generated/               # produced by openapi-typescript
    └── helpers/
        ├── auth.ts
        └── ingest.ts            # batching helpers
```

**Dependencies**: `openapi-fetch`, `openapi-typescript`. Generated on every API release; locked to a minor version per agent release.

### 3.7 Shared dev-config packages

- `packages/tsconfig` — `base.json`, `next.json`, `node.json`.
- `packages/eslint-config` — `base.js`, `next.js`, `node.js`.
- `packages/tailwind-config` — preset reused by `web`, `ui`, `desktop`.

---

## 4. Drizzle Schema Index (`packages/db/src/schema/index.ts`)

```ts
export * from './organizations';
export * from './users';
export * from './memberships';
export * from './teams';
export * from './projects';
export * from './devices';
export * from './deviceTokens';
export * from './timeEntries';
export * from './activitySamples';
export * from './appUsage';
export * from './urlUsage';
export * from './screenshots';
export * from './settingsScoped';
export * from './notifications';
export * from './auditLogs';
export * from './timesheets';
export * from './reports';
```

Each schema file matches the SQL in [02-database-schema.md](02-database-schema.md). The corresponding migrations live in `packages/db/migrations/` and are committed alongside the schema change.

---

## 5. BullMQ Queue Module (`apps/worker/src/queues.ts`)

```ts
import { Queue, QueueEvents, Worker } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

export const queues = {
  screenshotProcess: new Queue('screenshot.process', { connection }),
  ingestFanout:      new Queue('ingest.fanout',     { connection }),
  rollupDaily:       new Queue('rollup.daily',      { connection }),
  rollupWeekly:      new Queue('rollup.weekly',     { connection }),
  rollupMonthly:     new Queue('rollup.monthly',    { connection }),
  rollupHourlyLive:  new Queue('rollup.hourly.live',{ connection }),
  notifyEmail:       new Queue('notify.email',      { connection }),
  notifyPush:        new Queue('notify.push',       { connection }),
  exportTimesheet:   new Queue('export.timesheet',  { connection }),
  exportScreenshots: new Queue('export.screenshots',{ connection }),
  retentionSweep:    new Queue('retention.sweep',   { connection }),
  webhookDelivery:   new Queue('webhook.delivery',  { connection }),
  agentMaintenance:  new Queue('agent.maintenance', { connection }),
} as const;

export type QueueName = keyof typeof queues;
```

The matching processor file per queue lives in `apps/worker/src/processors/<queue>.ts`. `index.ts` reads `QUEUES` env and starts the matching `Worker` instances. Graceful shutdown:

```ts
process.on('SIGTERM', async () => {
  await Promise.all(workers.map(w => w.close()));
  await Promise.all(Object.values(queues).map(q => q.close()));
  process.exit(0);
});
```

---

## 6. Tauri Module Map (recap)

| Module                    | Path                                | Surface to UI                            |
| ------------------------- | ----------------------------------- | ---------------------------------------- |
| Commands (auth)           | `src-tauri/src/commands/auth.rs`    | `login`, `pair_device`, `logout`         |
| Commands (timer)          | `commands/timer.rs`                 | `timer_start`, `timer_stop`, `timer_state`|
| Commands (projects)       | `commands/projects.rs`              | `list_projects`, `search_projects`       |
| Commands (settings)       | `commands/settings.rs`              | `get_settings`                           |
| Commands (sync)           | `commands/sync.rs`                  | `sync_status`, `force_sync`              |
| Capture services          | `capture/*`                         | (internal)                               |
| Sync engine               | `sync/*`                            | (internal)                               |
| Storage (sqlite + crypto) | `storage/*`                         | (internal)                               |
| Platform integration      | `platform/{macos,windows,linux}.rs` | (internal)                               |
| Supervisor                | `supervisor.rs`                     | (internal)                               |
| Updater                   | `updater.rs`                        | `check_for_updates` (manual)             |
| Telemetry                 | `telemetry.rs`                      | (internal)                               |

---

## 7. Generation & Codegen Pipeline

- `pnpm gen:openapi` — runs `apps/api` build with `@fastify/swagger` to emit `packages/desktop-sdk/openapi/openapi.json`.
- `pnpm gen:sdk` — runs `openapi-typescript` to produce `packages/desktop-sdk/src/generated/`.
- `pnpm db:generate` — diff schema → SQL migration.
- `pnpm build:agent:<platform>` — runs `pnpm --filter @timepro/desktop tauri build` with the right targets and signs the bundle.

CI runs `pnpm gen:openapi && pnpm gen:sdk` and fails the build if there are uncommitted changes (so SDK stays in lockstep with the API).

---

## 8. Environment Files (canonical)

`.env.example` per app, with documented vars. Values are placeholders. Production values are in Secrets Manager; local dev uses `.env.local` per app (gitignored).

---

## 9. Bring-up Order (first commit to running pilot)

1. Repo scaffold, Turbo + pnpm, shared configs.
2. `packages/db` + migrations 0000–0002 + RLS.
3. `apps/api` skeleton + auth + tenant plugin.
4. `apps/web` shell + auth pages + dashboard placeholder.
5. Compose with Postgres + Redis + Minio. End-to-end "register → login → see empty dashboard".
6. Projects + Time entries APIs + UI.
7. `apps/desktop` Tauri shell, pair flow, timer start/stop.
8. Activity + app capture (macOS first), local outbox, ingest endpoint, sync.
9. Screenshots: presign → upload → confirm → process worker → gallery.
10. Reports v1 + CSV export.
11. Notifications + audit log + onboarding.
12. Pilot deploy.

This sequence keeps each step demoable and never leaves the system half-built.

---

## 10. Quality Gates (PR checks)

- `lint`, `typecheck`, `test` per affected workspace (`turbo run --filter='[origin/main]'`).
- API integration tests in CI against an ephemeral Postgres + Redis (Testcontainers).
- DB migration dry-run on a staging snapshot.
- Bundle size budget for `web` (250 KB JS first-load).
- Mutation tests for `packages/auth` (high-value, low-noise).
- Dependency review (Renovate/Dependabot).
- OpenAPI diff: if breaking, requires explicit `BREAKING:` label and version bump.

---

This monorepo, the SQL/Drizzle schema, the route map, the BullMQ queue list, the Tauri module map, and the scheduler crons are everything an engineering team needs to begin Phase 1 from a green field.
