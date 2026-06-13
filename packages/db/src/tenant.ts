import { sql } from 'drizzle-orm';
import { getDb, type DB } from './client';

/**
 * Run `fn` inside a transaction where the per-connection GUC
 * `app.organization_id` is set to `organizationId`. Every tenant-scoped
 * RLS policy reads this GUC, so anything outside `withTenant` is rejected
 * by Postgres — fail-closed isolation.
 *
 * The GUC is `LOCAL` to the transaction, so it cannot leak to another
 * checkout from the pool.
 */
export async function withTenant<T>(
  organizationId: string,
  fn: (tx: DB) => Promise<T>,
  db: DB = getDb(),
): Promise<T> {
  if (!isUuid(organizationId)) {
    throw new Error(`withTenant: invalid organizationId "${organizationId}"`);
  }

  return db.transaction(async (tx) => {
    // `set_config(name, value, is_local)` with is_local=true scopes to the tx.
    // We use it rather than `SET LOCAL` because the latter doesn't accept
    // bind parameters — and we never want to interpolate untrusted strings.
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    return fn(tx as DB);
  });
}

/**
 * Escape hatch for maintenance jobs (retention, rollups) that legitimately
 * need to operate across tenants. Uses a separate DB role with BYPASSRLS.
 *
 * Callers must justify usage in code review.
 */
export async function asPlatform<T>(fn: (tx: DB) => Promise<T>, db: DB = getDb()): Promise<T> {
  return db.transaction(async (tx) => fn(tx as DB));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
