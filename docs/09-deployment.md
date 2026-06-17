# TimePro — Deployment Architecture

> **Implementation status** — ✅ built · ⛔ planned.
>
> - ✅ `infra/compose/docker-compose.dev.yml` runs the local dev stack (Postgres, Redis, Minio, MailHog, OTel collector).
> - ⛔ Not yet built: per-service Dockerfiles, the production Nginx config, CI/CD pipelines, blue/green rollout, backups/DR, and the managed-infra topology. The Dockerfile and Nginx snippets below are illustrative targets, not files in the repo.

Docker for packaging. Ubuntu 22.04 LTS hosts. Nginx in front. Compose for staging; ECS/EKS/Nomad for production-at-scale (any of them work — choose by team familiarity).

## 1. Build Artifacts

| Service     | Image                                          | Base                        |
| ----------- | ---------------------------------------------- | --------------------------- |
| `api`       | `ghcr.io/timepro/api:<sha>`                  | `gcr.io/distroless/nodejs22`|
| `web`       | `ghcr.io/timepro/web:<sha>`                  | `gcr.io/distroless/nodejs22`|
| `worker`    | `ghcr.io/timepro/worker:<sha>`               | `gcr.io/distroless/nodejs22`|
| `scheduler` | `ghcr.io/timepro/scheduler:<sha>`            | `gcr.io/distroless/nodejs22`|
| `realtime`  | `ghcr.io/timepro/realtime:<sha>`             | `gcr.io/distroless/nodejs22`|
| `nginx`     | `ghcr.io/timepro/nginx:<sha>`                | `nginx:1.27-alpine`         |
| `migrate`   | `ghcr.io/timepro/migrate:<sha>` (one-shot)   | `node:22-alpine`            |

Multi-stage Dockerfiles. Final image excludes dev dependencies. Built reproducibly with pnpm via `pnpm deploy --filter <app>`. Image size targets: API/worker < 200 MB; web < 250 MB.

### 1.1 Example Dockerfile (`apps/api/Dockerfile`)

```dockerfile
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS prune
COPY . .
RUN pnpm dlx turbo prune --scope=@timepro/api --docker

FROM base AS install
COPY --from=prune /repo/out/json/ ./
COPY --from=prune /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
COPY --from=install /repo/ ./
COPY --from=prune /repo/out/full/ ./
RUN pnpm turbo run build --filter=@timepro/api

FROM base AS deploy
RUN pnpm deploy --filter=@timepro/api --prod /app
WORKDIR /app

FROM gcr.io/distroless/nodejs22-debian12:nonroot
USER nonroot
WORKDIR /app
COPY --from=deploy --chown=nonroot:nonroot /app /app
ENV NODE_ENV=production
EXPOSE 3001
CMD ["dist/server.js"]
```

---

## 2. Nginx Topology

Single Nginx in front of every service. TLS termination, routing by host + path, rate limiting.

> **This is the target multi-instance topology.** The live single-tenant config is
> [`infra/nginx/timepro.systemsd.co.conf`](../infra/nginx/timepro.systemsd.co.conf) (one API on `127.0.0.1:4001`,
> one web on `127.0.0.1:3005`). Ports below match those (API **4001**, web **3005**).

```nginx
# /etc/nginx/conf.d/timepro.conf

upstream tf_api      { least_conn; server api1:4001; server api2:4001; server api3:4001; }
upstream tf_web      { least_conn; server web1:3005; server web2:3005; }
upstream tf_realtime { ip_hash;    server rt1:3010; server rt2:3010; }

map $http_upgrade $connection_upgrade { default upgrade; '' close; }

limit_req_zone $binary_remote_addr zone=anon:10m  rate=10r/s;
limit_req_zone $http_authorization  zone=auth:10m rate=100r/s;

server {
  listen 443 ssl http2;
  server_name app.timepro.app;
  ssl_certificate     /etc/letsencrypt/live/app.timepro.app/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.timepro.app/privkey.pem;
  ssl_protocols TLSv1.3;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
  add_header X-Frame-Options DENY always;
  add_header X-Content-Type-Options nosniff always;

  client_max_body_size 25m;   # screenshot fallback path

  location /v1/ {
    limit_req zone=auth burst=200 nodelay;
    proxy_pass http://tf_api;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
  }

  location /v1/realtime {
    proxy_pass http://tf_realtime;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 1h;
  }

  location / {
    limit_req zone=anon burst=50 nodelay;
    proxy_pass http://tf_web;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

`api.timepro.app` is a separate vhost with stricter rate limits per-bucket as defined in [03-api-design.md](03-api-design.md). CloudFront sits in front of Nginx for static + agent updates.

---

## 3. Environments

| Env       | Purpose                | Hostnames                                   | Data                  |
| --------- | ---------------------- | ------------------------------------------- | --------------------- |
| `dev`     | Local                  | `localhost`                                 | docker-compose        |
| `preview` | PR-per-environment     | `pr-123.preview.timepro.app`              | Shared preview DB     |
| `staging` | Pre-prod, mirrors prod | `staging.timepro.app`                     | Scrubbed prod restore |
| `prod`    | Real users             | `app.timepro.app`, `api.timepro.app`    | Live                  |

Each env: own Postgres, Redis, S3 prefix, KMS key. Secrets per env in Secrets Manager.

---

## 4. CI/CD

GitHub Actions, single workflow per app:

```
on: push
jobs:
  lint-and-test       # turbo run lint test --filter ...
  type-check          # tsc --noEmit
  build               # turbo run build --filter ...
  docker              # docker buildx, push to GHCR
  deploy-staging      # on main branch
  smoke-staging       # synthetic checks
  deploy-prod         # manual approval
```

Deploy strategy:
- **API/worker/web**: rolling, with `min_healthy_percent=100, max_percent=200`.
- **DB migrations**: run `migrate` job before new images start. Migrations are expand-only — never break the running version.
- **Scheduler**: singleton, leader-elected via Redis lock; old leader drops lock on SIGTERM so new pod takes over without downtime.
- **Realtime**: drain connections (server sends `going_away` frame; clients reconnect).
- **Agent**: not deployed by us — released to update channel. Servers retain N-2 agent compatibility.

Rollback: image tags are immutable; redeploy previous SHA. Migrations are forward-only — if a forward fix is needed, write a new migration; never roll back the DB.

---

## 5. Compose for Staging (illustrative)

```yaml
version: "3.9"
services:
  nginx:
    image: ghcr.io/timepro/nginx:${SHA}
    ports: ["443:443"]
    depends_on: [api, web, realtime]
  api:
    image: ghcr.io/timepro/api:${SHA}
    deploy: { replicas: 3 }
    env_file: ./envs/api.env
    depends_on: [postgres, redis]
  web:
    image: ghcr.io/timepro/web:${SHA}
    deploy: { replicas: 2 }
    env_file: ./envs/web.env
  worker:
    image: ghcr.io/timepro/worker:${SHA}
    deploy: { replicas: 3 }
    env_file: ./envs/worker.env
  scheduler:
    image: ghcr.io/timepro/scheduler:${SHA}
    deploy: { replicas: 1, restart_policy: { condition: any } }
    env_file: ./envs/scheduler.env
  realtime:
    image: ghcr.io/timepro/realtime:${SHA}
    deploy: { replicas: 2 }
    env_file: ./envs/realtime.env
  postgres:
    image: postgres:16
    volumes: ["pgdata:/var/lib/postgresql/data"]
  redis:
    image: redis:7
    command: ["redis-server", "--maxmemory", "8gb", "--maxmemory-policy", "allkeys-lru"]

volumes: { pgdata: {} }
```

Production uses managed Postgres (RDS / Cloud SQL / Crunchy) and managed Redis (ElastiCache / Upstash) — Compose is for local + small staging.

---

## 6. Backups & DR

| Asset        | Strategy                                                              | RPO   | RTO   |
| ------------ | --------------------------------------------------------------------- | ----- | ----- |
| Postgres     | Continuous WAL archiving to S3 + nightly base backups, cross-region   | 5 min | 1 h   |
| Redis        | RDB snapshot every 1 h + AOF; ephemeral — caches/queues rebuildable   | 1 h   | 15 m  |
| S3           | Versioning enabled on buckets; cross-region replication for primary   | 0     | n/a   |
| KMS          | Multi-region keys with replica in DR region                           | 0     | n/a   |
| Configs/IaC  | Git, signed tags                                                      | —     | —     |

Quarterly DR drill: restore last backup to a clean account, run smoke tests, document timing.

---

## 7. Observability Stack

- **OpenTelemetry collector** deployed as a DaemonSet (or sidecar in Compose).
- **Tempo** for traces, **Loki** for logs, **Prometheus** for metrics, **Grafana** for dashboards.
- **Alertmanager → PagerDuty** for SEV1/2.
- **Sentry** for app errors.

Sample dashboards:
- API: RED metrics per route, error rate by status, p99 latency, top slow queries.
- Queues: depth, throughput, failure rate, DLQ count.
- DB: connections, slow queries, replication lag, bloat.
- S3: PUTs, GETs, bytes, lifecycle transitions.
- Agents: online count, average sync lag, version distribution.

---

## 8. Configuration

12-factor. Every service config is env vars (no `config.json` files baked into images).

Examples (api):
```
DATABASE_URL=postgres://...
REDIS_URL=redis://...
S3_BUCKET_SCREENSHOTS=timepro-screenshots
S3_BUCKET_EXPORTS=timepro-exports
S3_REGION=us-east-1
KMS_KEY_ID=arn:aws:kms:us-east-1:...
JWT_SIGNING_KEY_PRIMARY=...
JWT_SIGNING_KEY_NEXT=...               # for overlap during rotation
SES_REGION=us-east-1
SES_FROM=noreply@timepro.app
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
SENTRY_DSN=...
PORT=3001
LOG_LEVEL=info
```

Per-env values live in Secrets Manager and are pulled at boot. No secrets in the repo.

---

## 9. Capacity Sizing (MVP, 100 orgs ≈ 5,000 active users)

| Component       | Sizing                                       |
| --------------- | -------------------------------------------- |
| `api`           | 3 pods × 1 vCPU / 1 GB                       |
| `web`           | 2 pods × 1 vCPU / 1 GB                       |
| `worker`        | 4 pods × 2 vCPU / 2 GB                       |
| `scheduler`     | 1 pod × 0.5 vCPU / 512 MB                    |
| `realtime`      | 2 pods × 1 vCPU / 1 GB                       |
| Postgres        | db.r6g.xlarge (4 vCPU / 32 GB) + 1 replica   |
| Redis           | cache.r6g.large (2 vCPU / 13 GB)             |
| Nginx           | 2 × 1 vCPU                                   |
| S3              | n/a                                          |

Estimated monthly infra ~ $2,500–3,000 (AWS retail). With reserved instances and S3 IA lifecycle: ~$1,500.

See [10-scaling.md](10-scaling.md) for 1k and 10k org tiers.

---

## 10. Operational Playbooks

| Scenario                       | Playbook                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------ |
| API p99 spike                  | Check slow query log → roll EXPLAIN → if missing index, hotfix; otherwise scale|
| Queue depth growth             | Identify queue → scale worker → if poison job, drain to DLQ                    |
| Postgres replica lag           | Verify WAL throughput, network, vacuum, autovacuum cost limits                 |
| S3 PUT errors                  | Check IAM, region health; agent retries handle transient                       |
| Agent reports failed to sync   | Inspect dead-letter, classify (validation vs server) → fix and replay         |
| Tenant data leak suspected     | Freeze writes for affected org, snapshot, run query trace, post-mortem         |

Each playbook lives in the repo as Markdown and is linked from the on-call rotation.
