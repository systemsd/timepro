# TimePro — Database Schema

> **Implementation status** — ✅ built · 🟡 partial · ⛔ planned.
>
> - ✅ 16 core tables exist via Drizzle + migrations + seed: `organizations`, `users`, `memberships`, `teams`, `team_members`, `projects` (+ `client_id`), `project_members`, `clients`, `devices`, `device_tokens`, `time_entries`, `activity_samples`, `screenshots`, `settings_scoped`, `notifications`, `audit_logs`. The `withTenant` helper is implemented.
> - ✅ `activity_samples` (written by the agent, B4), `app_usage` (written by the agent, B5), and `url_usage` (ready for the browser extension) now exist and are populated via `/v1/ingest/*`.
> - ⛔ **Not yet built:** table partitioning (all tables are non-partitioned), RLS policies (§8 — none applied), and the `project_tasks`, `timesheets`, and `reports_*` tables. Retention/archival jobs are not implemented.
>
> The DDL below is the target design; the live schema is what `packages/db/src/schema/` defines.

PostgreSQL 16. Drizzle ORM. UUIDv7 primary keys (lexicographically sortable, time-ordered, index-friendly). All timestamps `timestamptz`, stored as UTC.

## 1. ERD (Conceptual)

```
organizations ──┬── users (via memberships) ──┬── time_entries
                ├── teams ──── team_members   ├── activity_samples
                ├── projects ── project_members├── screenshots
                ├── settings_scoped            ├── app_usage
                ├── devices                    ├── url_usage
                ├── notifications              └── timesheets
                ├── audit_logs
                └── reports_daily / _weekly / _monthly
```

Foreign keys cascade `RESTRICT` by default; soft-delete via `deleted_at` on user-facing tables.

---

## 2. Naming & Conventions

- `snake_case` table & column names.
- Boolean columns prefixed `is_` (`is_billable`, `is_archived`).
- Timestamps: `created_at`, `updated_at`, `deleted_at`, plus domain-specific (`started_at`, `captured_at`).
- Every tenant table: `organization_id uuid NOT NULL` + `(organization_id, ...)` composite indexes.
- Every table: `created_at timestamptz NOT NULL DEFAULT now()`.
- IDs: `id uuid PRIMARY KEY DEFAULT uuidv7()` (custom function or app-generated).

---

## 3. Core Tables

### 3.1 Identity & tenancy

```sql
CREATE TABLE organizations (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  slug            citext UNIQUE NOT NULL,
  plan            text NOT NULL DEFAULT 'free',  -- free | starter | business | enterprise
  status          text NOT NULL DEFAULT 'active',-- active | suspended | cancelled
  trial_ends_at   timestamptz,
  data_region     text NOT NULL DEFAULT 'us-east-1',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE TABLE users (
  id              uuid PRIMARY KEY,
  email           citext UNIQUE NOT NULL,
  password_hash   text,                         -- nullable for SSO-only users
  display_name    text NOT NULL,
  avatar_url      text,
  timezone        text NOT NULL DEFAULT 'UTC',
  locale          text NOT NULL DEFAULT 'en',
  email_verified_at timestamptz,
  last_login_at   timestamptz,
  mfa_enabled     boolean NOT NULL DEFAULT false,
  mfa_secret      text,                         -- encrypted (KMS DEK)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE TABLE memberships (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner','admin','manager','employee')),
  employment_type text NOT NULL DEFAULT 'employee', -- employee | contractor
  hourly_rate_cents integer,
  currency        char(3) DEFAULT 'USD',
  weekly_hour_limit integer,                    -- nullable = no limit
  status          text NOT NULL DEFAULT 'active',-- active | invited | suspended
  invited_at      timestamptz,
  joined_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX memberships_org_idx ON memberships(organization_id) WHERE status = 'active';
CREATE INDEX memberships_user_idx ON memberships(user_id) WHERE status = 'active';
```

### 3.2 Teams & projects

```sql
CREATE TABLE teams (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  manager_user_id uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, name)
);

CREATE TABLE team_members (
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE projects (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  code            text,                         -- e.g. "ACME-001" for invoicing
  color           text NOT NULL DEFAULT '#6366f1',
  status          text NOT NULL DEFAULT 'active',-- active | archived | paused
  is_billable     boolean NOT NULL DEFAULT true,
  default_rate_cents integer,
  client_name     text,
  budget_hours    numeric(10,2),
  budget_cents    bigint,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, name)
);

CREATE TABLE project_members (
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rate_cents      integer,                      -- override membership.hourly_rate_cents
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE project_tasks (              -- optional task layer
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'open',
  estimate_hours  numeric(10,2),
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

### 3.3 Devices

```sql
CREATE TABLE devices (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,                -- "Macbook Pro 14"
  platform        text NOT NULL,                -- darwin | windows | linux
  os_version      text,
  agent_version   text,
  hostname        text,
  fingerprint     text NOT NULL,                -- HW-derived stable ID
  public_key      text,                         -- for E2E command signing (future)
  status          text NOT NULL DEFAULT 'active',-- active | revoked
  approved_at     timestamptz,
  last_seen_at    timestamptz,
  last_ip         inet,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  UNIQUE (user_id, fingerprint)
);

CREATE TABLE device_tokens (
  id              uuid PRIMARY KEY,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash      bytea NOT NULL,               -- sha256 of refresh token
  family_id       uuid NOT NULL,                -- for rotation chain detection
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  replaced_by     uuid REFERENCES device_tokens(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz
);

CREATE INDEX device_tokens_device_idx ON device_tokens(device_id) WHERE revoked_at IS NULL;
```

### 3.4 Time entries

```sql
CREATE TABLE time_entries (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      uuid REFERENCES projects(id),
  task_id         uuid REFERENCES project_tasks(id),
  device_id       uuid REFERENCES devices(id),
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,                  -- null while running
  duration_sec    integer GENERATED ALWAYS AS
                    (EXTRACT(EPOCH FROM (ended_at - started_at))::int) STORED,
  source          text NOT NULL DEFAULT 'desktop', -- desktop | web | mobile | manual
  is_manual       boolean NOT NULL DEFAULT false,
  is_billable     boolean NOT NULL DEFAULT true,
  description     text,
  client_event_id text NOT NULL,                -- idempotency from agent
  approval_status text NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  rejection_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, client_event_id)
) PARTITION BY RANGE (started_at);

-- Monthly partitions: time_entries_2026_05, time_entries_2026_06, ...
-- Created by pg_partman on a daily cron.

CREATE INDEX time_entries_user_started_idx
  ON time_entries (organization_id, user_id, started_at DESC);
CREATE INDEX time_entries_project_started_idx
  ON time_entries (organization_id, project_id, started_at DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX time_entries_running_idx
  ON time_entries (organization_id, user_id)
  WHERE ended_at IS NULL;
```

> **Why partitioned?** A 1000-org tenant generates ~50M time entry rows/year. Monthly partitions keep hot-month scans fast and let us drop old partitions cheaply for retention.

### 3.5 Capture: activity, apps, URLs, screenshots

```sql
-- 1-minute activity buckets, the granularity ScreenshotMonitor/Hubstaff use.
CREATE TABLE activity_samples (
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  device_id       uuid NOT NULL,
  time_entry_id   uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  bucket_minute   timestamptz NOT NULL,         -- truncated to minute
  keyboard_events smallint NOT NULL DEFAULT 0,
  mouse_events    smallint NOT NULL DEFAULT 0,
  active_seconds  smallint NOT NULL,            -- 0..60
  idle_seconds    smallint NOT NULL,
  activity_score  smallint NOT NULL,            -- 0..100
  PRIMARY KEY (organization_id, user_id, bucket_minute)
) PARTITION BY RANGE (bucket_minute);

CREATE INDEX activity_samples_entry_idx
  ON activity_samples (time_entry_id)
  WHERE time_entry_id IS NOT NULL;

CREATE TABLE app_usage (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  device_id       uuid NOT NULL,
  time_entry_id   uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  app_name        text NOT NULL,                -- "Visual Studio Code"
  app_bundle_id   text,                         -- "com.microsoft.VSCode"
  window_title    text,                         -- truncated to 256 chars, optional capture
  category        text,                         -- "development" | "communication" | ...
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz NOT NULL,
  duration_sec    integer GENERATED ALWAYS AS
                    (EXTRACT(EPOCH FROM (ended_at - started_at))::int) STORED,
  is_productive   boolean,
  created_at      timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (started_at);

CREATE INDEX app_usage_user_started_idx
  ON app_usage (organization_id, user_id, started_at DESC);

CREATE TABLE url_usage (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  device_id       uuid NOT NULL,
  time_entry_id   uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  browser         text NOT NULL,                -- "chrome" | "firefox" | ...
  domain          text NOT NULL,
  url             text,                         -- full URL, may be truncated/redacted
  page_title      text,
  category        text,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz NOT NULL,
  duration_sec    integer GENERATED ALWAYS AS
                    (EXTRACT(EPOCH FROM (ended_at - started_at))::int) STORED,
  is_productive   boolean,
  created_at      timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (started_at);

CREATE INDEX url_usage_domain_idx
  ON url_usage (organization_id, domain, started_at DESC);

CREATE TABLE screenshots (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  device_id       uuid NOT NULL,
  time_entry_id   uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  project_id      uuid REFERENCES projects(id),
  captured_at     timestamptz NOT NULL,
  monitor_index   smallint NOT NULL DEFAULT 0,  -- multi-monitor
  width           smallint,
  height          smallint,
  s3_key          text NOT NULL,                -- org/{org}/{yyyy}/{mm}/{dd}/{user}/{id}.webp
  s3_thumb_key    text,
  bytes           integer,
  thumbnail_bytes integer,
  is_blurred      boolean NOT NULL DEFAULT false,
  encryption_dek_id uuid,                       -- envelope encryption key ref
  activity_score  smallint,                     -- snapshot at capture time
  app_name        text,                         -- captured context
  window_title    text,
  status          text NOT NULL DEFAULT 'pending', -- pending | approved | rejected | deleted
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  rejection_reason text,
  client_event_id text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, client_event_id)
) PARTITION BY RANGE (captured_at);

CREATE INDEX screenshots_user_captured_idx
  ON screenshots (organization_id, user_id, captured_at DESC);
CREATE INDEX screenshots_entry_idx
  ON screenshots (time_entry_id) WHERE time_entry_id IS NOT NULL;
CREATE INDEX screenshots_status_idx
  ON screenshots (organization_id, status, captured_at DESC)
  WHERE status = 'pending';
```

### 3.6 Settings, notifications, audit

```sql
CREATE TABLE settings_scoped (
  organization_id uuid NOT NULL,
  scope_type      text NOT NULL,                -- 'org' | 'team' | 'project' | 'user'
  scope_id        uuid NOT NULL,                -- = organization_id for org scope
  key             text NOT NULL,                -- 'screenshots.per_hour'
  value           jsonb NOT NULL,
  is_locked       boolean NOT NULL DEFAULT false,
  updated_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, scope_type, scope_id, key)
);

CREATE TABLE notifications (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  type            text NOT NULL,                -- 'timesheet.approval_needed' | ...
  title           text NOT NULL,
  body            text,
  data            jsonb NOT NULL DEFAULT '{}',
  read_at         timestamptz,
  delivered_email_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_unread_idx
  ON notifications (organization_id, user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE TABLE audit_logs (
  id              uuid PRIMARY KEY,
  organization_id uuid,                         -- nullable for platform events
  actor_user_id   uuid,
  actor_type      text NOT NULL,                -- 'user' | 'system' | 'agent'
  action          text NOT NULL,                -- 'screenshot.delete'
  target_type     text,
  target_id       uuid,
  ip              inet,
  user_agent      text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE INDEX audit_logs_org_created_idx ON audit_logs (organization_id, created_at DESC);
```

### 3.7 Timesheets & approvals

```sql
CREATE TABLE timesheets (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  period_start    date NOT NULL,                -- Monday for weekly
  period_end      date NOT NULL,
  total_seconds   integer NOT NULL DEFAULT 0,
  billable_seconds integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'open', -- open | submitted | approved | rejected
  submitted_at    timestamptz,
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, period_start)
);
```

### 3.8 Reporting tables (rollups)

See [06-reporting.md](06-reporting.md). Short version:

```sql
CREATE TABLE reports_daily (
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  day             date NOT NULL,
  project_id      uuid,                         -- NULL = all-projects rollup
  tracked_seconds integer NOT NULL DEFAULT 0,
  active_seconds  integer NOT NULL DEFAULT 0,
  idle_seconds    integer NOT NULL DEFAULT 0,
  billable_seconds integer NOT NULL DEFAULT 0,
  screenshot_count integer NOT NULL DEFAULT 0,
  avg_activity_score smallint,
  PRIMARY KEY (organization_id, user_id, day, project_id)
) PARTITION BY RANGE (day);

CREATE TABLE reports_weekly LIKE reports_daily INCLUDING ALL;  -- analogous
CREATE TABLE reports_monthly LIKE reports_daily INCLUDING ALL;
```

---

## 4. Indexing Strategy

| Purpose                         | Index                                                       |
| ------------------------------- | ----------------------------------------------------------- |
| "My time entries today"         | `time_entries (org, user, started_at DESC)`                 |
| "Currently running timer"       | `time_entries (org, user) WHERE ended_at IS NULL`           |
| "Pending screenshots to review" | `screenshots (org, status, captured_at) WHERE status='pending'` |
| "Project rollup"                | `time_entries (org, project_id, started_at DESC)`           |
| "Audit search"                  | GIN on `audit_logs.metadata` for jsonb path queries         |
| "Membership lookup"             | `memberships (user_id) WHERE status='active'`               |

Avoid indexing `window_title` and `page_title` directly — use full-text search index (`tsvector`) only if/when the search feature ships (Phase 2).

---

## 5. Partitioning & Retention

| Table              | Partition       | Default retention      | Notes                                |
| ------------------ | --------------- | ---------------------- | ------------------------------------ |
| `time_entries`     | monthly         | 7 years (legal)        | Archive to S3 Parquet after 18 mo    |
| `activity_samples` | monthly         | 18 months              | Aggregated into `reports_daily`      |
| `app_usage`        | monthly         | 12 months              | Per-org override possible            |
| `url_usage`        | monthly         | 12 months              | Per-org override possible            |
| `screenshots`      | monthly         | 90 days (configurable) | S3 lifecycle does the real deletion  |
| `audit_logs`       | monthly         | 2 years                | Compliance-driven                    |
| `reports_*`        | yearly          | indefinite             | Small, queryable                     |

Retention is org-configurable within plan-defined bounds. A nightly worker enforces logical deletes + emits S3 deletion tombstones.

---

## 6. Drizzle Schema (excerpt — full version in `packages/db/src/schema/`)

```ts
// packages/db/src/schema/organizations.ts
import { pgTable, uuid, text, timestamp, citext } from 'drizzle-orm/pg-core';

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  name: text('name').notNull(),
  slug: citext('slug').notNull().unique(),
  plan: text('plan').notNull().default('free'),
  status: text('status').notNull().default('active'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  dataRegion: text('data_region').notNull().default('us-east-1'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// packages/db/src/schema/timeEntries.ts
import { pgTable, uuid, text, timestamp, integer, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';
import { projects } from './projects';

export const timeEntries = pgTable('time_entries', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  organizationId: uuid('organization_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id),
  taskId: uuid('task_id'),
  deviceId: uuid('device_id'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  source: text('source').notNull().default('desktop'),
  isManual: boolean('is_manual').notNull().default(false),
  isBillable: boolean('is_billable').notNull().default(true),
  description: text('description'),
  clientEventId: text('client_event_id').notNull(),
  approvalStatus: text('approval_status').notNull().default('pending'),
  approvedBy: uuid('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  orgUserStarted: index('time_entries_user_started_idx')
    .on(t.organizationId, t.userId, t.startedAt.desc()),
  orgProjectStarted: index('time_entries_project_started_idx')
    .on(t.organizationId, t.projectId, t.startedAt.desc()),
  running: index('time_entries_running_idx')
    .on(t.organizationId, t.userId)
    .where(sql`ended_at IS NULL`),
  clientEventUnique: uniqueIndex('time_entries_client_event_unique')
    .on(t.organizationId, t.clientEventId),
}));
```

The full Drizzle schema lives in `packages/db/src/schema/index.ts` and re-exports every table. Migrations are generated by `drizzle-kit generate` and applied via a one-shot `drizzle-kit migrate` job in CI/deploy.

---

## 7. Migration Workflow

1. `pnpm db:generate` — diff schema → SQL.
2. Review SQL — partitioning, indexes, RLS policies often need manual edits in the generated file.
3. Commit both `schema.ts` change and the generated SQL.
4. On deploy: `db:migrate` runs *before* the new API rolls out.
5. Backwards-incompatible changes are split into expand/contract: deploy 1 adds new columns; deploy 2 backfills; deploy 3 removes old columns.

---

## 8. RLS Policies (defense in depth)

```sql
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON time_entries
  FOR SELECT
  USING (organization_id = current_setting('app.organization_id', true)::uuid);

CREATE POLICY tenant_isolation_modify ON time_entries
  FOR ALL
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);
```

Service role connections (worker rollup jobs, retention) use a separate DB role with `BYPASSRLS` privilege. All app connections are RLS-bound.
