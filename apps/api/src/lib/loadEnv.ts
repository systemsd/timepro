import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the repo-root `.env` regardless of the script's cwd.
 *
 * Same pattern as `packages/db/src/lib/loadEnv.ts` — pnpm 9 has no
 * `--env-file` and `import "dotenv/config"` is cwd-relative.
 *
 * When we add `@timepro/shared`, both copies move there.
 */
export function loadRootEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // .../apps/api/src/lib → repo root is 4 levels up
  const rootEnv = resolve(here, '..', '..', '..', '..', '.env');
  config({ path: rootEnv, override: false });
}
