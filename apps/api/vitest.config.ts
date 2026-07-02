import { defineConfig } from 'vitest/config';

/**
 * Unit tier — pure logic, no DB, no network. Runs everywhere (local + CI) with
 * zero infra. Integration tests live under `test/integration/` and run via
 * `vitest.integration.config.ts` (they need a Postgres).
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
});
