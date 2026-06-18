import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the repo-root `.env` regardless of the script's cwd.
 *
 * Same pattern as `packages/db/src/lib/loadEnv.ts` — pnpm 9 has no
 * `--env-file` and `import "dotenv/config"` is cwd-relative.
 *
 * We **walk up** to the workspace root rather than counting `..` segments: a
 * fixed depth (`../../../..`) is correct for the TS source under `src/lib`, but
 * `tsup` bundles to `dist/server.js`, which sits one level shallower — so the
 * old math resolved to the *parent* of the repo and silently loaded nothing,
 * dropping production into config defaults (0.0.0.0:3001, NODE_ENV=development).
 *
 * When we add `@timepro/shared`, both copies move there.
 */
export function loadRootEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = findWorkspaceRoot(here);
  if (!root) return; // bundled outside the tree — rely on the process env
  config({ path: resolve(root, '.env'), override: false });
}

/**
 * Nearest ancestor holding `pnpm-workspace.yaml` (the monorepo root); falls back
 * to any ancestor that has a `.env`, so a plain `node dist/server.js` still
 * finds it. Returns null if neither is found before the filesystem root.
 */
function findWorkspaceRoot(from: string): string | null {
  const { root: fsRoot } = parse(from);
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    if (existsSync(resolve(dir, '.env'))) return dir;
    if (dir === fsRoot) return null;
  }
}
