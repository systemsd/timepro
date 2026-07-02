import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Components use the automatic JSX runtime (no `import React`).
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    include: ['src/**/*.test.tsx'],
    environment: 'jsdom',
    globals: true,
  },
});
