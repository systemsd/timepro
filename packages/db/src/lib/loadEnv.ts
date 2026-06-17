import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the repo-root `.env` file regardless of the script's cwd.
 *
 * Why this exists: pnpm 9 doesn't support `--env-file`, and `import "dotenv/config"`
 * is cwd-relative — when scripts run inside `packages/db`, it can't see the root
 * `.env`. We **walk up** to the workspace root from this file's location, which
 * stays correct whether we run from TS source (`src/lib`) or a bundled location
 * — unlike a fixed `../../../..`, which only matches one layout.
 *
 * If a `.env` later exists in the process's cwd, it overrides the root one
 * (standard dotenv behaviour).
 */
export function loadRootEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = findWorkspaceRoot(here);
  if (!root) return; // bundled outside the tree — rely on the process env
  config({ path: resolve(root, '.env'), override: false });
}

/**
 * Nearest ancestor holding `pnpm-workspace.yaml` (the monorepo root); falls back
 * to any ancestor that has a `.env`. Returns null if neither is found before the
 * filesystem root.
 */
function findWorkspaceRoot(from: string): string | null {
  const { root: fsRoot } = parse(from);
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    if (existsSync(resolve(dir, '.env'))) return dir;
    if (dir === fsRoot) return null;
  }
}
