import { loadRootEnv } from './lib/loadEnv';
loadRootEnv();

import { runMigrations } from './migrator';

/**
 * `pnpm db:migrate` — apply pending migrations from the command line.
 *
 * The actual work lives in `migrator.ts`, which the API also runs at boot, so
 * both paths apply migrations identically. Reads `DATABASE_ADMIN_URL` /
 * `DATABASE_URL` from the root `.env` (loaded above; the process env wins) or
 * from an injected environment.
 */
async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  await runMigrations({ log: (msg) => console.log(`[migrate] ${msg}`) });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[migrate] failed', err);
  process.exit(1);
});
