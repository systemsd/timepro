import { existsSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Shared migration runner — used by the `db:migrate` CLI (`migrate.ts`) *and* by
 * the API at boot (`apps/api/src/server.ts`), so a deploy can never serve traffic
 * against an un-migrated schema.
 *
 * Why the API applies migrations itself: the deploy pipeline (ShipHub) runs
 * install → build → start and has no migrate step, so migration 0009 shipped
 * without ever being applied and `/v1/products` 500'd on a missing table. Putting
 * the guarantee in code rather than in a deploy-config field means it travels with
 * the app and is covered by review — a pipeline change can't silently drop it.
 *
 * Safe to call on every boot/restart:
 *  - **Idempotent** — Drizzle records applied migrations in
 *    `drizzle.__drizzle_migrations` and skips anything already applied, so a
 *    restart against an up-to-date database is one cheap round-trip.
 *  - **Fails closed** — it throws. The caller must let that propagate (the API's
 *    `main().catch` exits non-zero *before* `listen()`), so a failed migration
 *    means the new version never becomes healthy and the previous one keeps
 *    serving. Never a half-migrated live app.
 *
 * Note: Drizzle applies all pending migrations in ONE transaction and takes no
 * advisory lock, so two instances booting simultaneously could both attempt the
 * work. One transaction wins; the loser fails closed and restarts into a no-op.
 * Deployment is single-instance today — revisit if that changes.
 */

export interface RunMigrationsOptions {
  /** Overrides `DATABASE_ADMIN_URL` / `DATABASE_URL`. */
  url?: string;
  /** Overrides the auto-resolved `packages/db/migrations` folder. */
  migrationsFolder?: string;
  /** Progress sink; defaults to no logging. */
  log?: (message: string) => void;
}

/**
 * Locate `packages/db/migrations` from wherever this module ends up.
 *
 * Two very different layouts have to work, which is why this walks up instead of
 * using a fixed relative path:
 *   - TS source — `packages/db/src/` → the sibling `packages/db/migrations`.
 *   - Bundled — tsup inlines `@timepro/db` into `apps/api/dist/server.js`
 *     (`noExternal`), so `import.meta.url` points at `apps/api/dist/` and the
 *     folder is up at `<repo>/packages/db/migrations`.
 * We match on `meta/_journal.json` rather than a bare `migrations` directory so
 * an unrelated folder of that name can never be picked up.
 */
export function resolveMigrationsFolder(): string {
  const from = dirname(fileURLToPath(import.meta.url));
  const { root: fsRoot } = parse(from);
  const candidates: string[] = [];
  for (let dir = from; ; dir = dirname(dir)) {
    for (const rel of ['migrations', join('packages', 'db', 'migrations')]) {
      const candidate = resolve(dir, rel);
      candidates.push(candidate);
      if (existsSync(resolve(candidate, 'meta', '_journal.json'))) return candidate;
    }
    if (dir === fsRoot) break;
  }
  throw new Error(
    `could not locate the migrations folder (looked for meta/_journal.json in: ${candidates.join(', ')})`,
  );
}

/**
 * Apply every pending migration. Throws on any failure — callers must not
 * swallow it (see the fail-closed contract above).
 */
export async function runMigrations(options: RunMigrationsOptions = {}): Promise<void> {
  const url = options.url ?? process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required');

  const migrationsFolder = options.migrationsFolder ?? resolveMigrationsFolder();
  const log = options.log ?? (() => {});

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    await ensureExtensions(pool, log);
    log(`applying migrations from ${migrationsFolder}`);
    await migrate(drizzle(pool), { migrationsFolder });
    log('migrations up to date');
  } finally {
    // Always release the dedicated pool, including on failure — otherwise a
    // fail-closed boot would leave connections open until the process dies.
    await pool.end();
  }
}

/**
 * Bootstrap the extensions the schema depends on, before Drizzle parses any DDL.
 * `IF NOT EXISTS` short-circuits when the extension is already installed, so an
 * unprivileged app role is fine on an existing database (verified against
 * Postgres 16: a NOSUPERUSER role gets `NOTICE: extension already exists,
 * skipping` and success). Only a *first* install needs elevated rights, which is
 * why the error below spells that out.
 */
async function ensureExtensions(pool: pg.Pool, log: (message: string) => void): Promise<void> {
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
    log(`extensions ready: ${required.join(', ')}`);
  } finally {
    client.release();
  }
}
