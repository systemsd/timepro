import { defineConfig } from 'vitest/config';

/** Unit tests for pure client-side libs (no DOM / React). */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
});
