# TimePro — Reporting Architecture

> **Implementation status** — ✅ built · ⛔ planned.
>
> - ✅ Computed **on the fly** (no rollups yet): `GET /v1/me/today` (today's tracked time/status/screenshots), `GET /v1/roster` (per-employee today/yesterday/week/month totals + last screenshot, viewer-tz), `GET /v1/timeline/:userId` (a day's screenshots/activity in 10-min slots + day total + average activity + `intervals[]` tracker run/stop segments for the ruler), `GET /v1/timeline/:userId/activity` (per-day tracked seconds for a month — the Timeline strip bars), `GET /v1/timeline/:userId/apps-urls` (a day's app + domain usage — the Timeline summary-card Apps/URLs panel).
> - 📐 **Reports Console** (§0) — UI/feature **spec'd** from the reference screenshots; **not built**. The "Reports ▾" nav tab is disabled today. This is the Phase 5 / **B7** deliverable.
> - ⛔ Still planned: `reports_hourly/daily/weekly/monthly` rollup tables, rollup jobs, materialized views, exports, caching, and the time-per-client report. No scheduled aggregation runs yet — on-the-fly compute is fine at current scale and moves to rollups in Phase 5.

Hot reads come from rollup tables, not from raw `time_entries`. Live dashboard reads from an "as-of-now" hourly rollup + a live tail.

---

## 0. Reports Console — UI & feature spec

> **Status: 5A + 5B + 5C built; 5D–5F pending.** Phase 5 / **B7** deliverable. The Reports nav tab is **live**.
> - ✅ **5A — query API**: `GET /v1/reports/filters` (RBAC-scoped employees + client/project catalogs) and `POST /v1/reports/run` (Summary/Detailed/Weekly, computed on-the-fly from `time_entries`, viewer-tz). See `apps/api/src/routes/reports.ts`.
> - ✅ **5B — console UI**: `apps/web/src/app/reports/page.tsx` — filter bar, Summary/Detailed/Weekly/Saved dropdown, daily-totals chart (red weekends), result tabs, expand/collapse group tables.
> - ✅ **5C — saved reports + exports**: `saved_reports` table (migration `0004`, per-user + `is_shared` org-visible), CRUD at `/v1/reports/saved`; "Saved Report" dropdown lists/loads/deletes; **Excel** = client-side CSV, **PDF** = browser print (`@media print`). **Shareable public links deferred** (use `is_shared` for org-visibility).
> - ✅ **5E — realtime presence (B10)**: websocket `GET /v1/realtime/presence` (snapshot + live `update` frames from the in-process presence pub/sub); web `useRealtimePresence` (shared socket, role-gated) overlays live dots on the dashboard roster + Timeline nav, replacing the 30s presence poll (totals poll now 60s). `apps/api/src/routes/realtime.ts`, `lib/presence.ts`.
> - ✅ **Weekly-limit enforcement**: effective `limits.weekly_hours` (org default ← per-user override) vs current-week tracked time (`apps/api/src/lib/limits.ts`). Enforced at **timer start** (409 `weekly_limit_reached` at/over the cap); surfaced on the manager roster (`week / limit ⚠`) and My Home (week stat + over-limit banner). `0` = unlimited.
> - ⛔ **Dropped/cut:** **5D** rollups + scheduler (scale optimization — on-the-fly is fine at current scale; revisit on latency) · **absence model** (only needed for the optional "Include absences" toggle). **Phase 5 / B7 is otherwise complete.**
>
> Open questions are flagged inline with **⚠️**.

The Reports console is one page: a **filter/builder bar** up top, a **report-type dropdown**, and a
**result area** (daily-totals chart + tabbed tables). The flow: pick a report type → set filters →
**Show report** → results render below, exportable (Excel/PDF) and saveable.

### 0.1 Report-type dropdown

The top-level selector. Four entries:

| Type | Default group-by | Result table | Extra control |
| ---- | ---------------- | ------------ | ------------- |
| **Summary** | employee + project | grouped, expand/collapse (`± Employee / ± Project` → Duration) | — |
| **Detailed** | none (flat) | one row per time entry: Date · Employee · Project · Note · From · To · Duration | — |
| **Weekly Report** | employee | flat employee → Duration (per ISO week) | ☐ **Include absences** |
| **Saved Report** | (loads a saved config) | re-runs a previously **Saved report** | picks from the saved list |

⚠️ The reference UI also shows quick-link presets — *Summary by project · Summary by client · Summary by
employee · Daily by employee · Detailed · Apps & URLs*. **Decision needed:** are these (a) shortcuts that
just set the dropdown + group-by, or (b) a row kept alongside the dropdown? Assumed **(a)** — presets over
Summary/Detailed.

### 0.2 Filter / builder bar (shared by all report types)

- **Date range** — `DD/MM/YY ▶ DD/MM/YY` picker + presets: Today, Yesterday, This Week, **Last Week**, This Month, Last Month, This Year, Last Year.
- **Report timezone** — "Report times are UTC+5 ▾" selector. ⚠️ Ties to **C6** (viewer/org tz): defaults to the org/viewer tz and drives every day/week boundary + From/To label.
- **Select employees and groups** — multi-select, **RBAC-scoped** (admin/owner = all; manager = own team; employee = self) via `lib/access.ts` / `visibleUsers`.
- **Select clients** — multi-select (clients = OpsCore business partners).
- **Select projects** — multi-select.
- **Note contains text** — free-text filter on time-entry notes.
- **Group by** — multi-select chips (`Group by employee`, `Group by project`, …); defaults per report type (0.1). ⚠️ Confirm the full option set (employee, project, client, date?).
- **Toggles** — ☐ Only offline activities · ☐ Exclude archived · ☐ Include absences *(Weekly only)*.

### 0.3 Actions

- **Show report** (primary green button) — runs the query.
- **Excel** / **PDF** — export the current report (ties to §6 export pipeline). ⚠️ Large ranges go async per §8's >90-day rule; small ranges may export synchronously — confirm the UI threshold.
- **Share report** — shareable snapshot/link. ⚠️ Auth + scope of shared links TBD.
- **Save report** — persists the current type+filter config as a named **Saved Report**, surfaced under the dropdown's "Saved Report" entry. ⚠️ Needs a `saved_reports` table; per-user vs per-org/shared visibility TBD.

### 0.4 Result area

- **Daily-totals bar chart** — one bar per day in range with a value label (e.g. `9h 47m`) and the grand total to the left (e.g. **53h 34m**); **weekends rendered in red**. Shown on the Timeline tab.
- **Result tabs** — Timeline · Employees · Projects · Clients · Notes · Apps & URLs. Each re-pivots the same filtered dataset:
  - *Timeline* — the chart + the grouped/detailed table for the chosen report type.
  - *Employees / Projects / Clients* — totals pivoted by that dimension.
  - *Notes* — entries that carry a note.
  - *Apps & URLs* — ✅ live: aggregates `app_usage` + `url_usage` by user+range into top apps / top domains. Apps populate from the desktop agent now; URLs populate once the browser extension reports to `/v1/ingest/url-usage`.
- Grouped tables support expand/collapse (the `±` / `⊞` affordance on each group row).

### 0.5 Data sources

Reads come from the rollup layer below: `reports_daily` for week/month windows, `reports_hourly` + live tail
for today; **Detailed** reads raw `time_entries` joined to projects/notes; **Apps & URLs** from
`app_usage` / `url_usage`. Time-per-client uses `project.client_id` (C3, OpsCore-owned). Ranges > 90 days
require an export (§8).

### 0.6 Open questions (resolve before building)

1. **Report tz basis** — C6 (org/viewer vs employee vs UTC); must match My Home/Timeline.
2. **Saved & shared reports** — storage table, visibility (per-user/org), share-link auth.
3. **Absence source** — Weekly's "Include absences" needs a leave/absence model that **does not exist yet**.
4. **Quick-links vs dropdown** — presets or a parallel control (0.1).
5. **Group-by option set** — exact dimensions, and which combinations are valid per type.
6. **Export sync-vs-async threshold** surfaced in the UI.

---

## 1. Layered Model

```
raw events (time_entries, activity_samples, app_usage, url_usage, screenshots)
     │  near-realtime: hourly rollup (BullMQ)
     ▼
reports_hourly                  ← live dashboard, current day
     │  nightly: daily rollup
     ▼
reports_daily                   ← weekly/monthly views, exports
     │  weekly + monthly rollups
     ▼
reports_weekly, reports_monthly ← exec dashboards, payroll
```

Reads always hit the *narrowest* table that satisfies the query window.

---

## 2. Rollup Tables

### 2.1 `reports_hourly`

```sql
CREATE TABLE reports_hourly (
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  project_id      uuid,                  -- NULL = "all"
  hour            timestamptz NOT NULL,  -- truncated to hour
  tracked_seconds integer NOT NULL DEFAULT 0,
  active_seconds  integer NOT NULL DEFAULT 0,
  idle_seconds    integer NOT NULL DEFAULT 0,
  billable_seconds integer NOT NULL DEFAULT 0,
  screenshot_count integer NOT NULL DEFAULT 0,
  avg_activity_score smallint,
  PRIMARY KEY (organization_id, user_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), hour)
) PARTITION BY RANGE (hour);
```

Updated every minute by a small job (`rollup.hourly.live`) that recomputes the **current and previous hour** for any user whose `time_entries` changed in the last 90s. Cheap because it touches at most a few rows.

### 2.2 `reports_daily`, `reports_weekly`, `reports_monthly`

Same shape with `day`, `week_start`, `month_start`. Filled by the nightly + scheduled rollups.

---

## 3. Rollup SQL (daily example)

```sql
INSERT INTO reports_daily (organization_id, user_id, project_id, day,
                           tracked_seconds, active_seconds, idle_seconds,
                           billable_seconds, screenshot_count, avg_activity_score)
SELECT
  $1::uuid AS organization_id,
  te.user_id,
  te.project_id,
  ($2::date) AS day,
  COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(te.ended_at, $2::date + 1) -
                                   GREATEST(te.started_at, $2::date)))::int), 0),
  COALESCE(SUM(a.active_seconds), 0),
  COALESCE(SUM(a.idle_seconds), 0),
  COALESCE(SUM(CASE WHEN te.is_billable THEN
              EXTRACT(EPOCH FROM (LEAST(te.ended_at, $2::date + 1) -
                                  GREATEST(te.started_at, $2::date)))::int
            END), 0),
  (SELECT COUNT(*) FROM screenshots s
   WHERE s.organization_id = te.organization_id
     AND s.user_id = te.user_id
     AND s.captured_at >= $2::date
     AND s.captured_at < $2::date + 1),
  ROUND(AVG(a.activity_score))::smallint
FROM time_entries te
LEFT JOIN activity_samples a
  ON a.organization_id = te.organization_id
 AND a.user_id = te.user_id
 AND a.bucket_minute >= $2::date
 AND a.bucket_minute < $2::date + 1
WHERE te.organization_id = $1::uuid
  AND te.user_id = $3::uuid
  AND te.started_at < $2::date + 1
  AND COALESCE(te.ended_at, now()) >= $2::date
GROUP BY te.user_id, te.project_id
ON CONFLICT (organization_id, user_id, day, project_id) DO UPDATE
SET tracked_seconds = EXCLUDED.tracked_seconds,
    active_seconds  = EXCLUDED.active_seconds,
    idle_seconds    = EXCLUDED.idle_seconds,
    billable_seconds = EXCLUDED.billable_seconds,
    screenshot_count = EXCLUDED.screenshot_count,
    avg_activity_score = EXCLUDED.avg_activity_score;
```

Notes:
- Time-entry portion is **clipped to the day boundary** so an overnight session is split correctly.
- A separate "all projects" row is computed with `project_id IS NULL` by aggregating the per-project rows.

---

## 4. Materialized Views

For exec dashboards that span 90+ days, we use materialized views refreshed on the monthly rollup completion:

```sql
CREATE MATERIALIZED VIEW mv_org_top_apps_30d AS
SELECT
  organization_id,
  app_name,
  SUM(duration_sec) AS total_seconds,
  COUNT(DISTINCT user_id) AS user_count
FROM app_usage
WHERE started_at >= now() - interval '30 days'
GROUP BY organization_id, app_name;

CREATE INDEX ON mv_org_top_apps_30d (organization_id, total_seconds DESC);
```

Refreshed concurrently in `rollup.weekly.fan_out`. Stale-up-to-1-week is acceptable for these views.

---

## 5. Live Dashboard Path

```
GET /v1/dashboard/today
  → query reports_hourly for today + completed hours
  + live tail: any open time_entries (running timers)
  + presence (devices.last_seen_at > now() - 90s)
Cache: per-(org, user_set) in Redis for 15s.
```

The "active employees right now" widget is computed entirely from Redis presence keys (`presence:org:<id>:user:<id>` with TTL 90s, refreshed by heartbeats) — never hits Postgres.

---

## 6. Export Pipeline

1. `POST /v1/exports` enqueues an `export.timesheet` or `export.screenshots` job.
2. Worker streams via Postgres cursor (no `OFFSET`, no full materialization).
3. For CSV: write directly to a temp file with `csv-stringify` in stream mode.
4. For XLSX: `exceljs` with the streaming writer.
5. Upload to `s3://timepro-exports/{org}/{export_id}.csv` with `expires` tag → 7-day S3 lifecycle.
6. Email user a signed URL (60-minute TTL on the link itself; lifecycle handles eventual deletion).

A typical 6-month export of 50 users × ~150 entries/month: ~45k rows, ~5 MB CSV — completes in ~6 seconds end-to-end.

---

## 7. Caching

| Cache key                                  | TTL  | Invalidation                              |
| ------------------------------------------ | ---- | ----------------------------------------- |
| `dashboard:today:org:<id>:user:<id>`       | 15s  | Implicit via TTL                          |
| `report:weekly:org:<id>:user:<id>:<week>`  | 5m   | On `time_entries` write for that range    |
| `settings:effective:user:<id>`             | 60s  | Push on settings update                   |
| `presence:org:<id>:user:<id>`              | 90s  | Implicit via TTL (refreshed by heartbeat) |

We do **not** cache responses that contain screenshots — those always require fresh signed URLs.

---

## 8. Tenant Cost Controls

- Reports for ranges > 90 days require an **export** rather than a synchronous read. The API rejects synchronous range > 90 days with `413 Payload Too Large` and a hint to use exports.
- Per-org daily quota of exports (default 50; enterprise: unlimited).
- A "compute budget" per org: heavy report queries are tracked in Redis; orgs over budget get longer queues.

---

## 9. When to Move to ClickHouse (Phase 2/3)

Trigger conditions:
- `app_usage` + `url_usage` exceed ~1 B rows.
- 95p report query latency on `reports_*` exceeds 800 ms.
- Need ad-hoc slice/dice (e.g., "show me top URLs in finance dept across all orgs").

Migration plan:
- Stream `app_usage`, `url_usage`, `activity_samples` into ClickHouse via a CDC pipeline (Debezium → Kafka → ClickHouse).
- Keep Postgres as the source of truth for `time_entries`, `screenshots`, identity.
- Read path for analytics routes through ClickHouse. OLTP unchanged.
