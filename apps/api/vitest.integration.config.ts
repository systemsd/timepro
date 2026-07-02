import { defineConfig } from 'vitest/config';

/**
 * Integration tier — boots the real Fastify app (`buildApp`) against a Postgres
 * and drives it with `app.inject`. Requires a reachable test database
 * (DATABASE_URL). `globalSetup` migrates it once; tests reset state per-file.
 * Single-threaded so DB-mutating tests don't race each other.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    globals: true,
    globalSetup: ['./test/integration/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
