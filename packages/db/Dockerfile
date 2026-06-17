# syntax=docker/dockerfile:1
#
# One-shot migration image for @timepro/db.
# Build from the REPO ROOT:  docker build -f packages/db/Dockerfile -t timepro-migrate .
#
# Run once before bringing up the API (compose runs it as a one-shot service):
#   docker run --rm --env DATABASE_URL=postgres://... timepro-migrate
#
# `db:migrate` (tsx src/migrate.ts) first bootstraps the citext + pgcrypto
# extensions, then applies the drizzle migrations. It reads DATABASE_ADMIN_URL
# (falling back to DATABASE_URL) from the environment. Dev deps are kept on
# purpose — the migration runs through tsx, so this is NOT a --prod install.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.9.16 prune @timepro/db --docker

FROM base AS install
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS runner
ENV NODE_ENV=production
COPY --from=install /repo/ ./
COPY --from=prune /repo/out/full/ ./
WORKDIR /repo/packages/db
CMD ["pnpm", "db:migrate"]
