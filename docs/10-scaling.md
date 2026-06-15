# TimePro — Scaling Strategy

> **Implementation status:** ⛔ **Forward-looking planning only.** Nothing here is built — the
> system currently runs as a single dev instance. The capacity model, tier architectures, and cost
> estimates are projections to guide future infrastructure decisions, not a description of what exists.

## 1. Capacity Tiers

Assumed workload per active user (knee-of-the-curve):
- 8 working hours/day, 22 days/month.
- 60 screenshots/hour with default settings (most orgs set 4–12).
- 480 activity_samples per workday (one per minute).
- ~200 app_usage rows per workday.
- ~150 url_usage rows per workday.

We assume 50 active users per org on average.

| Tier        | Orgs   | Active users | Screenshots/mo | Capture rows/mo (raw) |
| ----------- | ------ | ------------ | -------------- | --------------------- |
| Pilot       | 10     | 500          | ~5.3M          | ~9.3M                 |
| Small       | 100    | 5,000        | ~53M           | ~93M                  |
| Mid         | 1,000  | 50,000       | ~530M          | ~930M                 |
| Large       | 10,000 | 500,000      | ~5.3B          | ~9.3B                 |

> "Most orgs use 4–12 screenshots/hour" — defaults often shift the real number 5–10× lower; the table above is the **conservative upper bound** to size hardware safely.

---

## 2. Storage Growth

### 2.1 Screenshots (the dominant cost)

Average 80 KB full WebP + 12 KB thumb = ~92 KB combined.

| Tier   | New storage/month       | Steady-state (after lifecycle) |
| ------ | ----------------------- | ------------------------------ |
| Pilot  | 0.5 TB                  | 1.5 TB                         |
| Small  | 4.9 TB                  | ~15 TB                         |
| Mid    | 49 TB                   | ~145 TB                        |
| Large  | 490 TB                  | ~1.4 PB                        |

Steady-state assumes 30 days Standard, 60 days Standard-IA, 270 days Glacier Instant, then delete (typical for a customer that uses default 1-year retention).

### 2.2 Postgres rows

| Table              | Rows/active user/year | Mid tier (50k users) | Large tier (500k) |
| ------------------ | --------------------- | --------------------- | ----------------- |
| time_entries       | ~2,000                | 100M                  | 1.0B              |
| activity_samples   | ~120,000              | 6.0B                  | 60B               |
| app_usage          | ~50,000               | 2.5B                  | 25B               |
| url_usage          | ~38,000               | 1.9B                  | 19B               |
| screenshots        | ~120,000              | 6.0B                  | 60B               |

Each row averages: time_entries ~250 B, activity_samples ~80 B, app_usage ~250 B, url_usage ~350 B, screenshots ~400 B.

**At the Mid tier, raw capture rows alone are ~3.8 TB Postgres before indexes.** This is why partitioning + rollups are mandatory and ClickHouse becomes attractive around 1 B rows in app/url tables.

---

## 3. Per-Tier Architecture

### 3.1 Pilot (10 orgs)

- Single Postgres instance, single Redis, single worker, two API.
- Compose-on-EC2 is fine. No replicas needed.
- All capture tables unpartitioned — too small to bother.
- Monthly bill: ~$700.

### 3.2 Small (100 orgs)

- Sizing as documented in [09-deployment.md](09-deployment.md). 1 read replica.
- Begin partitioning for `time_entries`, `screenshots`, `activity_samples`.
- Enable lifecycle rules.
- Monthly bill: ~$2,500–3,000.

### 3.3 Mid (1,000 orgs)

- 3 read replicas; reads (reports, dashboard) routed to replicas via PgBouncer pool selection.
- API: 8 pods. Worker: 12 pods split across queue families. Realtime: 4 pods.
- Redis Cluster (3 shards, 1 replica each).
- ClickHouse begins to make sense for `app_usage` + `url_usage` analytical queries.
- Per-tenant compute budgets enforced.
- Monthly bill: ~$18k–22k.

### 3.4 Large (10,000 orgs)

- Multi-region Postgres (regional clusters keyed by `data_region`).
- Sharded `time_entries` by `org_id` hash (Citus-style) — first sharding tier.
- ClickHouse mandatory; CDC pipeline (Debezium → Kafka → ClickHouse).
- S3 traffic dominates — consider R2 for egress cost savings on agent updates and gallery.
- Dedicated KMS CMKs per enterprise org.
- Monthly bill: ~$140k–180k.

---

## 4. Read Scaling Patterns

| Read                       | Path                                                          |
| -------------------------- | ------------------------------------------------------------- |
| Live dashboard "today"     | Redis presence + `reports_hourly` (replica)                   |
| Weekly report              | `reports_weekly` (replica)                                    |
| Time entries list (recent) | Primary (Hot path, recent partition only — small)             |
| Time entries (90+ days)    | Replica — usually report-bound, not user-typed                |
| Screenshot gallery         | Primary (writes recent) for status; thumbs from CDN          |
| Search (full text)         | Materialized GIN index OR ClickHouse (Phase 2+)              |

PgBouncer in transaction mode with route awareness: `tag=read` connections steer to replicas.

---

## 5. Write Scaling Patterns

- **Ingest** is the highest-volume write path. Insert-only, batched, partitioned. Postgres handles 100k inserts/sec on adequately sized hardware; well within budget at Mid tier.
- **Screenshots** insert is single-row with a UUID PK — trivially scalable.
- **Activity samples** are the hot table. Strategy:
  - Agent batches per minute (one row per bucket).
  - Server `COPY`-style ingest with `pg-copy-streams` for bulk inserts.
  - Per-partition write fan-out: current month's partition gets ~95% of writes; pre-create next month's partition a week ahead.
- **Audit logs** are append-only and can be moved to a write-optimized store (Elasticsearch or ClickHouse) at Mid tier.

---

## 6. Queue Scaling

| Tier   | Worker pods   | Redis                                |
| ------ | ------------- | ------------------------------------ |
| Pilot  | 1             | Single Redis                         |
| Small  | 4             | Single Redis with persistence        |
| Mid    | 12 (per-queue split) | Redis Cluster 3×2             |
| Large  | 40+ (HPA-driven) | Redis Cluster 6×2 + dedicated DLQ shard |

BullMQ scales by adding workers per queue; the per-org concurrency cap protects shared infra from a runaway tenant.

---

## 7. Bandwidth

| Source                            | Pilot    | Small    | Mid      | Large    |
| --------------------------------- | -------- | -------- | -------- | -------- |
| Agent → API (events)              | ~5 GB/mo | ~50 GB   | ~500 GB  | ~5 TB    |
| Agent → S3 (screenshots, direct)  | ~50 GB   | ~500 GB  | ~5 TB    | ~50 TB   |
| Web ← API + CDN                   | ~20 GB   | ~200 GB  | ~2 TB    | ~20 TB   |
| Reports / exports                 | ~5 GB    | ~50 GB   | ~500 GB  | ~5 TB    |

Egress fees dominate at the Large tier. Mitigations:
- CloudFront with origin shield reduces S3 GETs.
- Aggressive lifecycle to Glacier IR for fulls (no egress charge on Glacier IR retrievals if accessed < 1×/quarter).
- Consider R2 (no egress) for agent updates and gallery thumbnails.

---

## 8. Cost Estimates (AWS retail, USD/month)

| Component            | Pilot | Small | Mid     | Large    |
| -------------------- | ----- | ----- | ------- | -------- |
| Compute              | $200  | $700  | $4,500  | $35,000  |
| Postgres             | $250  | $700  | $4,000  | $35,000  |
| Redis                | $50   | $200  | $1,500  | $8,000   |
| S3 storage           | $35   | $400  | $4,200  | $40,000  |
| S3 requests          | $25   | $250  | $2,500  | $25,000  |
| CloudFront egress    | $15   | $150  | $1,500  | $18,000  |
| KMS                  | $10   | $50   | $400    | $4,000   |
| SES, misc            | $20   | $100  | $400    | $2,500   |
| Observability        | $50   | $250  | $1,500  | $10,000  |
| **Total (retail)**   | **~$650** | **~$2,800** | **~$20k** | **~$175k** |

Discounts: reserved instances (-30%), savings plans (-25% compute), S3 IA + Glacier tiering (-50% on >90d data). Real-world bill ~50–60% of retail at Mid+ tiers.

---

## 9. Performance Targets vs Tier

| SLO                         | Pilot | Small | Mid    | Large  |
| --------------------------- | ----- | ----- | ------ | ------ |
| API p99 read                | 200ms | 250ms | 300ms  | 400ms  |
| API p99 ingest              | 300ms | 400ms | 500ms  | 600ms  |
| Dashboard render            | 1.5s  | 1.5s  | 2.0s   | 2.5s   |
| Rollup pipeline lag (live)  | 30s   | 60s   | 90s    | 180s   |
| Agent reconnect after blip  | 10s   | 15s   | 20s    | 30s    |

These widen with scale because of replica lag, network hops, and shard routing. They remain within "snappy enough" for a productivity tool.

---

## 10. When to Hit Each Architecture Lever

| Trigger                                         | Lever to pull                                              |
| ----------------------------------------------- | ---------------------------------------------------------- |
| Postgres CPU sustained > 70%                    | Add read replica; route reports to it                      |
| Replication lag > 30s                           | Reduce write fan-out; investigate vacuum/autovacuum         |
| `time_entries` partition > 100 GB               | Reduce partition window (monthly → weekly)                 |
| `app_usage` query p99 > 2s                      | Move to ClickHouse                                         |
| Redis memory > 70%                              | Cluster; or shard BullMQ across multiple Redis instances   |
| S3 PUT 5xx                                      | Spread prefixes (already date-partitioned, low risk)       |
| Agent failed-sync rate > 0.1%                   | Investigate region/network; add CDN POPs                   |
| Egress > 50 TB/mo                               | Evaluate R2 for fulls; renegotiate CloudFront discount     |
| 1k+ orgs                                        | Begin per-region clustering; add Citus for `time_entries`  |

The order matters: **read replicas → caching → partition windowing → CDN → ClickHouse → sharding**. Sharding last; it's the most expensive change.
