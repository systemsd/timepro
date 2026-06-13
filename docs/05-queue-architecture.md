# TrackFlow — Queue & Background Job Architecture

BullMQ 5.x on Redis 7. Workers are horizontally scaled per-queue. The `scheduler` is a leader-elected singleton that produces cron jobs.

## 1. Queue Inventory

| Queue                | Purpose                                                                  | Priority | Worker concurrency (per pod) |
| -------------------- | ------------------------------------------------------------------------ | -------- | ---------------------------- |
| `screenshot.process` | Validate, decrypt, scan, re-encrypt for archive, generate thumbnail if agent didn't | High | 16 |
| `ingest.fanout`      | Update derived state (project totals, presence) after ingest             | High     | 32                           |
| `rollup.daily`       | Compute `reports_daily` rows per user/project/day                        | Medium   | 8                            |
| `rollup.weekly`      | Aggregate daily → weekly                                                 | Medium   | 4                            |
| `rollup.monthly`     | Aggregate weekly → monthly                                               | Low      | 2                            |
| `notify.email`       | SES sends (digests, reports ready, idle alerts, approvals)               | Medium   | 8                            |
| `notify.push`        | In-app + WS fan-out                                                      | High     | 16                           |
| `export.timesheet`   | CSV/XLSX exports                                                         | Low      | 4                            |
| `export.screenshots` | ZIP exports                                                              | Low      | 2                            |
| `retention.sweep`    | Delete S3 objects + DB rows past retention                               | Low      | 2                            |
| `webhook.delivery`   | Outbound webhook calls with retries & signing                            | Medium   | 16                           |
| `billing.meter`      | (Phase 2) Stripe metered usage records                                   | Medium   | 4                            |
| `agent.maintenance`  | Force-stop, force-update, revoke commands → WS                           | High     | 8                            |
| `dlq.*`              | Per-queue dead-letter destinations                                       | n/a      | manual                       |

Each queue has its own connection so a backlog in one doesn't starve another.

---

## 2. Job Contracts

All jobs share a base shape:

```ts
type Job<T> = {
  id: string;                  // BullMQ-generated or idempotency key
  data: T & { organizationId: string };
  opts: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 1000, age: 86_400 },
    removeOnFail:     { count: 5000, age: 7 * 86_400 },
    jobId?: string,            // for dedupe
  };
};
```

### 2.1 `screenshot.process`

```ts
{
  screenshotId: string;
  s3Key: string;
  organizationId: string;
}
```

Worker steps:
1. Verify object exists in S3, fetch metadata.
2. Run AV scan (ClamAV sidecar or AWS GuardDuty Malware Protection).
3. If agent didn't generate a thumbnail, decrypt → resize → re-encrypt → upload `s3_thumb_key`.
4. Update `screenshots` row with `bytes`, `thumbnail_bytes`, `status='pending'`.
5. Emit `notify.push` for "new screenshot" if dashboard subscribers exist.
6. Emit `audit_logs` entry.

### 2.2 `rollup.daily`

```ts
{ organizationId: string; userId: string; day: string /* YYYY-MM-DD */ }
```

Idempotent. Computes from `time_entries` + `activity_samples` + `screenshots`, UPSERTs `reports_daily`. Triggered:

- After each `time_entry.stop` (debounced 60s per `(user, day)`).
- Nightly catch-up at 02:00 in the user's timezone.

### 2.3 `notify.email`

```ts
{
  organizationId: string;
  userId: string;
  template: 'weekly_report' | 'idle_warning' | 'approval_request' | ...;
  data: Record<string, unknown>;
}
```

Worker resolves the user's notification preferences, renders MJML template, hands to SES. SES bounces → `notify.email.dlq` with reason; we mark email as bounced after 2 bounces.

### 2.4 `export.timesheet`

```ts
{
  organizationId: string;
  requestedBy: string;
  exportId: string;
  format: 'csv' | 'xlsx';
  filters: { from: string; to: string; userIds?: string[]; projectIds?: string[] };
}
```

Worker streams rows from Postgres via a server cursor, writes to temp file, uploads to S3 with a 7-day lifecycle. Emails the requester a signed URL. Updates `exports` row to `complete` (or `failed` with reason).

---

## 3. Cron Schedule (`scheduler`)

Implemented with BullMQ `repeatable jobs`. Single producer; uses Redis lock for leader election (`SET nx px`).

| Cron                          | Job                              | Notes                                       |
| ----------------------------- | -------------------------------- | ------------------------------------------- |
| every minute                  | `presence.sweep`                 | Mark devices offline if no heartbeat 90s    |
| every 5 minutes               | `idle.alert`                     | Send notifications for prolonged idle        |
| `0 * * * *`                   | `rollup.hourly`                  | Cheap incremental rollup for live dashboard |
| `0 2 * * *` (per region)      | `rollup.daily.fan_out`           | Emits a `rollup.daily` job per active user  |
| `0 3 * * 1`                   | `rollup.weekly.fan_out`          | Mondays                                     |
| `0 4 1 * *`                   | `rollup.monthly.fan_out`         | First of month                              |
| `0 5 * * 1`                   | `report.weekly_digest`           | Email digest                                |
| `0 1 * * *`                   | `retention.sweep`                | Logical delete + S3 lifecycle nudges        |
| `*/10 * * * *`                | `device_tokens.refresh_sweep`    | Refresh near-expiry tokens proactively      |
| `*/15 * * * *`                | `metrics.flush`                  | Exports queue depth, lag                    |
| `0 0 * * *`                   | `partman.maintain`               | Create next month's partitions              |

Fan-outs split work into per-org jobs to bound transaction size.

---

## 4. Idempotency & Deduplication

- BullMQ `jobId` set to a deterministic key per job (`rollup.daily:${org}:${user}:${day}`) prevents duplicates.
- Worker handlers re-check DB state at top: rollups are upserts; notifications check `notifications.delivered_email_at` before sending.
- All ingest jobs key off `client_event_id` (unique constraint at the DB).

---

## 5. Retry & Dead-Letter Strategy

- 5 attempts with exponential backoff (30s → 8m).
- On final failure: job moves to `<queue>.dlq` with the original payload + last error.
- An ops dashboard surfaces DLQ size and per-error histograms.
- Manual replay button in admin UI for selected DLQ jobs (with audit trail).

### 5.1 Poison messages

If `attempts > 2` and the error class is `ValidationError`, route immediately to DLQ — no point retrying schema violations. The handler raises `NonRetryableError` which BullMQ honors.

---

## 6. Backpressure

- Per-org rate cap: each org has `concurrencyTokens` in Redis. A worker takes a token before processing; expired tokens reduce concurrency for that org if it's overwhelming the system.
- Worker pods watch their own queue depth: if depth > threshold for 5 minutes, autoscaler adds pods (HPA on `bullmq_queue_depth` exported via prometheus).
- API ingest writes `429` once Redis `LLEN` of `ingest.fanout` exceeds a hard cap — protects DB from runaway agents.

---

## 7. Observability of Jobs

- Each job emits a `started`, `completed`/`failed` log with `org_id`, `job_name`, `duration_ms`.
- `bull-board` exposed on an internal admin port for live inspection.
- Prometheus exporter (custom) for:
  - `bullmq_jobs_completed_total{queue,status}`
  - `bullmq_jobs_active{queue}`
  - `bullmq_jobs_waiting{queue}`
  - `bullmq_jobs_delayed{queue}`
  - `bullmq_job_duration_seconds_bucket{queue,le}`

Alerts:
- waiting > 10k for >5min — page on-call.
- failed rate > 5% over 15min — page.
- DLQ growth > 100/hour — warn.

---

## 8. Deployment Topology of Workers

- One Docker image, one binary: `node worker.js --queues=rollup.daily,rollup.weekly`.
- Each pod subscribes to a subset of queues per scaling needs.
- Workers are stateless. Restart-safe. Graceful shutdown drains active jobs (BullMQ `close` waits for in-flight).
- Recommended pod sizing (MVP, 100 orgs):
  - `worker-ingest`: 2 pods × (16 ingest + 8 screenshot concurrency)
  - `worker-rollup`: 1 pod × (4 daily + 2 weekly + 1 monthly)
  - `worker-misc`:   1 pod × (everything else)

Auto-scale at 1k orgs (see [10-scaling.md](10-scaling.md)).
