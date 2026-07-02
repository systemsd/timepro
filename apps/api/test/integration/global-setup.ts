import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Vitest globalSetup — migrate the integration test database once before the
 * suite. Requires DATABASE_URL to point at a DEDICATED test DB (never prod);
 * the harness truncates tables between tests. CI provides a Postgres service.
 */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Integration tests require DATABASE_URL pointing at a dedicated test database ' +
        '(e.g. postgres://postgres:postgres@localhost:5432/timepro_test).',
    );
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  try {
    for (const ext of ['citext', 'pgcrypto']) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
    }
  } finally {
    client.release();
  }
  const db = drizzle(pool);
  const migrationsFolder = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/db/migrations',
  );
  await migrate(db, { migrationsFolder });
  await pool.end();
}
