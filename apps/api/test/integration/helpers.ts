// Fill in the non-DB required config with test defaults BEFORE anything reads it,
// so integration runs only need DATABASE_URL provided. (loadConfig is called at
// runtime in buildTestApp, not at import, so setting these here is sufficient.)
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'fatal';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_SIGNING_KEY_PRIMARY ??= 'test-jwt-signing-key-0123456789-abcdefgh';
process.env.AUTH_INTERNAL_SHARED_SECRET ??= 'test-internal-shared-secret';

import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@timepro/db';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';

export const ZERO_DEVICE = '00000000-0000-0000-0000-000000000000';

export async function buildTestApp(): Promise<FastifyInstance> {
  return buildApp(loadConfig());
}

/** Auth headers for a given org+user (the dev-header shim, accepted when NODE_ENV≠production). */
export function authHeaders(orgId: string, userId: string): Record<string, string> {
  return { 'x-dev-org': orgId, 'x-dev-user': userId };
}

/** Truncate every tenant table between tests for isolation. */
export async function resetDb(): Promise<void> {
  const db = getDb();
  const res = await db.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'`,
  );
  const rows = (res as unknown as { rows: { tablename: string }[] }).rows;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
}

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;

// ---- fixtures (direct writes; no RLS today, so org id is set explicitly) ----

export async function seedOrg(name = 'Org', slug = `org-${uniq()}`): Promise<string> {
  const [o] = await getDb()
    .insert(schema.organizations)
    .values({ name, slug })
    .returning({ id: schema.organizations.id });
  return o!.id;
}

export async function seedUser(
  orgId: string,
  opts: { name: string; email?: string; role: 'owner' | 'admin' | 'manager' | 'employee' },
): Promise<string> {
  const [u] = await getDb()
    .insert(schema.users)
    .values({ displayName: opts.name, email: opts.email ?? `${opts.name.toLowerCase()}-${uniq()}@test.dev` })
    .returning({ id: schema.users.id });
  await getDb()
    .insert(schema.memberships)
    .values({ organizationId: orgId, userId: u!.id, role: opts.role });
  return u!.id;
}

export async function seedTimeEntry(
  orgId: string,
  userId: string,
  opts: { startedAt: Date; endedAt: Date | null },
): Promise<string> {
  const [e] = await getDb()
    .insert(schema.timeEntries)
    .values({
      organizationId: orgId,
      userId,
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      clientEventId: `evt-${uniq()}`,
      source: 'desktop',
    })
    .returning({ id: schema.timeEntries.id });
  return e!.id;
}

export async function seedScreenshot(orgId: string, userId: string, capturedAt: Date): Promise<string> {
  const [s] = await getDb()
    .insert(schema.screenshots)
    .values({
      organizationId: orgId,
      userId,
      deviceId: ZERO_DEVICE,
      capturedAt,
      s3Key: `test/${uniq()}.png`,
      clientEventId: `shot-${uniq()}`,
    })
    .returning({ id: schema.screenshots.id });
  return s!.id;
}

/** Count app_usage rows for a user (idempotency assertions). */
export async function countAppUsage(orgId: string, userId: string): Promise<number> {
  const res = await getDb().execute(
    sql`SELECT count(*)::int AS n FROM app_usage WHERE organization_id = ${orgId} AND user_id = ${userId}`,
  );
  return (res as unknown as { rows: { n: number }[] }).rows[0]!.n;
}

/** Count OPEN time entries for a user (timer-race assertions). */
export async function countOpenTimers(orgId: string, userId: string): Promise<number> {
  const res = await getDb().execute(
    sql`SELECT count(*)::int AS n FROM time_entries WHERE organization_id = ${orgId} AND user_id = ${userId} AND ended_at IS NULL`,
  );
  return (res as unknown as { rows: { n: number }[] }).rows[0]!.n;
}
