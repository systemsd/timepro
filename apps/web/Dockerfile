# syntax=docker/dockerfile:1
#
# Production image for @timepro/web (Next.js 14, standalone output).
# Build from the REPO ROOT, passing the public URLs as build args (Next inlines
# NEXT_PUBLIC_* at BUILD time, so they cannot be set at runtime):
#
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.timepro.systemsd.co \
#     --build-arg NEXT_PUBLIC_OPSCORE_URL=https://opscore.systemsd.co \
#     -t timepro-web .

############################################
# Base — pnpm via corepack
############################################
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

############################################
# Prune — isolate @timepro/web's subgraph
############################################
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.9.16 prune @timepro/web --docker

############################################
# Install — deps for the build
############################################
FROM base AS install
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

############################################
# Build — next build → .next/standalone (+ .next/static)
############################################
FROM base AS build
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_OPSCORE_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_OPSCORE_URL=$NEXT_PUBLIC_OPSCORE_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=install /repo/ ./
COPY --from=prune /repo/out/full/ ./
RUN pnpm --filter @timepro/web build

############################################
# Runtime — distroless node, standalone server
############################################
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Next standalone server honours PORT/HOSTNAME at runtime.
ENV PORT=3005
ENV HOSTNAME=0.0.0.0
# Monorepo standalone output nests the app under apps/web/. The traced
# node_modules land at the standalone root. .next/static is NOT included in
# standalone and must be copied alongside. (No apps/web/public dir exists.)
COPY --from=build --chown=nonroot:nonroot /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nonroot:nonroot /repo/apps/web/.next/static ./apps/web/.next/static
USER nonroot
EXPOSE 3005
CMD ["apps/web/server.js"]
