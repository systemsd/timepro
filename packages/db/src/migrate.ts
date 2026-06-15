import { loadRootEnv } from './lib/loadEnv';
loadRootEnv();

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

async function main() {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required');

  const pool = new pg.Pool({ connectionString: url, max: 2 });

  // Ensure required Postgres extensions exist before drizzle parses any DDL.
  // Idempotent — safe to run on every migrate.
  await ensureExtensions(pool);

  const db = drizzle(pool);

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(__dirname, '..', 'migrations');

  // eslint-disable-next-line no-console
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  // eslint-disable-next-line no-console
  console.log('[migrate] done');

  await pool.end();
}

async function ensureExtensions(pool: pg.Pool): Promise<void> {
  const required = ['citext', 'pgcrypto'];
  const client = await pool.connect();
  try {
    for (const ext of required) {
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to create extension "${ext}" — your DB user needs SUPERUSER or the extension must be pre-installed by an admin. Original: ${msg}`,
        );
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[migrate] extensions ready: ${required.join(', ')}`);
  } finally {
    client.release();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[migrate] failed', err);
  process.exit(1);
});
