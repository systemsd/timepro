# TrackFlow — Reporting Architecture

Hot reads come from rollup tables, not from raw `time_entries`. Live dashboard reads from an "as-of-now" hourly rollup + a live tail.

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
5. Upload to `s3://trackflow-exports/{org}/{export_id}.csv` with `expires` tag → 7-day S3 lifecycle.
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
