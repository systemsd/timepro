# syntax=docker/dockerfile:1
#
# Production image for @timepro/api (Fastify).
# Build from the REPO ROOT:  docker build -f apps/api/Dockerfile -t timepro-api .
#
# Strategy: turbo-prune the monorepo down to @timepro/api + its workspace deps,
# install, build (tsup bundles @timepro/db — see apps/api/tsup.config.ts), then
# carve a production-only bundle with `pnpm deploy` and run it on distroless.
# All runtime config comes from the environment (see infra compose env files) —
# nothing is baked into the image.

############################################
# Base — pnpm via corepack
############################################
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

############################################
# Prune — isolate @timepro/api's subgraph
############################################
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.9.16 prune @timepro/api --docker

############################################
# Install — full deps (build needs tsup/tsx)
############################################
FROM base AS install
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

############################################
# Build — compile to dist/, then deploy a prod bundle to /app
############################################
FROM base AS build
COPY --from=install /repo/ ./
COPY --from=prune /repo/out/full/ ./
RUN pnpm --filter @timepro/api build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @timepro/api deploy --prod /app
# Seed the screenshot dir so a mounted named volume inherits nonroot ownership
# (distroless has no shell/chown; Docker copies this dir's perms into the volume).
RUN mkdir -p /data/screenshots

############################################
# Runtime — distroless node
############################################
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runner
WORKDIR /app
ENV NODE_ENV=production
# API_PORT is supplied by the environment (prod = 4001). EXPOSE is documentation.
EXPOSE 4001
COPY --from=build --chown=nonroot:nonroot /app /app
# STORAGE_DIR defaults here; the named volume mounts onto /data/screenshots and
# inherits nonroot ownership from the seeded dir above.
COPY --from=build --chown=nonroot:nonroot /data /data
USER nonroot
CMD ["dist/server.js"]
