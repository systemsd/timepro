import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the repo-root `.env` file regardless of the script's cwd.
 *
 * Why this exists: pnpm 9 doesn't support `--env-file`, and `import "dotenv/config"`
 * is cwd-relative — when scripts run inside `packages/db`, it can't see the root
 * `.env`. We resolve up from this file's location instead, which is stable.
 *
 * If a `.env` later exists in the process's cwd, it overrides the root one
 * (standard dotenv behaviour).
 */
export function loadRootEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // .../packages/db/src/lib → repo root is 4 levels up
  const rootEnv = resolve(here, '..', '..', '..', '..', '.env');
  config({ path: rootEnv, override: false });
}
