import { defineConfig } from 'tsup';

/**
 * Production build config.
 *
 * `noExternal` forces the workspace package `@timepro/db` (a *source-only* TS
 * package with no build step) to be **bundled** into `dist/server.js`. Without
 * this, tsup leaves `import … from '@timepro/db'` external and `node
 * dist/server.js` cannot resolve it at runtime (Node can't load the TS source),
 * so the production image would fail to boot. Dev (`tsx watch`) is unaffected.
 *
 * Real npm deps (fastify, drizzle-orm, pg, …) stay external and are provided by
 * the production `node_modules` in the Docker image.
 */
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  noExternal: [/^@timepro\//],
});
