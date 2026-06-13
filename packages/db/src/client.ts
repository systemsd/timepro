import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type DB = NodePgDatabase<typeof schema>;

let _pool: pg.Pool | null = null;
let _db: DB | null = null;

export interface CreateDbOptions {
  /** Postgres connection string. Falls back to DATABASE_URL env. */
  url?: string;
  /** Max pool connections. Defaults to 20 per process. */
  max?: number;
  /** Statement timeout in ms. Defaults to 30s. */
  statementTimeoutMs?: number;
  /** Idle timeout. Defaults to 60s. */
  idleTimeoutMs?: number;
}

/**
 * Create the singleton DB instance. Safe to call multiple times — subsequent
 * calls return the same instance unless `reset()` is called first.
 */
export function createDb(opts: CreateDbOptions = {}): DB {
  if (_db) return _db;

  const url = opts.url ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  _pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 20,
    idleTimeoutMillis: opts.idleTimeoutMs ?? 60_000,
    statement_timeout: opts.statementTimeoutMs ?? 30_000,
    // Surface low-level errors instead of silently dying.
    allowExitOnIdle: false,
  });

  _pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[db] unexpected pool error', err);
  });

  _db = drizzle(_pool, { schema, casing: 'snake_case' });
  return _db;
}

export function getDb(): DB {
  if (!_db) throw new Error('Database not initialized — call createDb() first');
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_pool) await _pool.end();
  _pool = null;
  _db = null;
}
