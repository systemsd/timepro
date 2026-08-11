import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@timepro/db';
import { sweepAbandonedTimers } from '../../src/lib/timer-sweep';
import { buildTestApp, resetDb, seedOrg, seedUser, ZERO_DEVICE } from './helpers';

/** A closed entry longer than the 30-min suspect threshold, with a single activity
 *  signal near the start — so it has a long "dead tail" the sweep would clamp. */
async function seedLongEntryWithEarlyActivity(
  orgId: string,
  userId: string,
  isManual: boolean,
): Promise<{ id: string; endedAt: Date }> {
  const now = Date.now();
  const startedAt = new Date(now - 2 * 60 * 60_000); // 2h ago
  const endedAt = new Date(now - 5 * 60_000); // ended 5 min ago (~115 min long)
  const [e] = await getDb()
    .insert(schema.timeEntries)
    .values({
      organizationId: orgId,
      userId,
      startedAt,
      endedAt,
      clientEventId: `evt-${randomUUID()}`,
      source: isManual ? 'web' : 'desktop',
      isManual,
    })
    .returning({ id: schema.timeEntries.id });
  // One screenshot 5 min in → last activity ~110 min before the end = a dead tail.
  await getDb().insert(schema.screenshots).values({
    organizationId: orgId,
    userId,
    deviceId: ZERO_DEVICE,
    timeEntryId: e!.id,
    capturedAt: new Date(startedAt.getTime() + 5 * 60_000),
    s3Key: `test/${randomUUID()}.png`,
    clientEventId: `shot-${randomUUID()}`,
  });
  return { id: e!.id, endedAt };
}

const endedAtOf = async (id: string): Promise<Date | null> => {
  const [row] = await getDb()
    .select({ endedAt: schema.timeEntries.endedAt })
    .from(schema.timeEntries)
    .where(eq(schema.timeEntries.id, id));
  return row!.endedAt;
};

describe('abandoned-timer sweep — leaves human-set (manual) entries alone', () => {
  let app: FastifyInstance;
  let org: string;
  let user: string;
  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await resetDb();
    org = await seedOrg('Org', 'org');
    user = await seedUser(org, { name: 'Emp', role: 'employee' });
  });

  it('does NOT trim a manual entry, but DOES trim an identical agent entry', async () => {
    const manual = await seedLongEntryWithEarlyActivity(org, user, true);
    const agent = await seedLongEntryWithEarlyActivity(org, user, false);

    await sweepAbandonedTimers();

    // Manual entry: end time untouched (the sweep must never revert a human edit).
    expect((await endedAtOf(manual.id))!.getTime()).toBe(manual.endedAt.getTime());
    // Agent entry (control): clamped back toward the last activity → shorter.
    expect((await endedAtOf(agent.id))!.getTime()).toBeLessThan(agent.endedAt.getTime());
  });
});
