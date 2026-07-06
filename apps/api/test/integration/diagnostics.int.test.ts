import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@timepro/db';
import { authHeaders, buildTestApp, resetDb, seedOrg, seedTimeEntry, seedUser } from './helpers';

/** The diagnostics endpoints that let an allowlisted dev trace a field issue. */
describe('admin diagnostics (users + user-activity)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(resetDb);

  it('user search finds the right person among similar names', async () => {
    const org = await seedOrg('Org', 'org');
    const admin = await seedUser(org, { name: 'Admin', role: 'admin' });
    const usama = await seedUser(org, { name: 'Muhammad Usama', role: 'employee' });
    const sharif = await seedUser(org, { name: 'Muhammad Usama Sharif', role: 'employee' });

    const res = await app.inject({ method: 'GET', url: '/v1/admin/users?q=usama', headers: authHeaders(org, admin) });
    expect(res.statusCode).toBe(200);
    const byName = Object.fromEntries(res.json().users.map((u: { display_name: string; id: string }) => [u.display_name, u.id]));
    expect(byName['Muhammad Usama']).toBe(usama);
    expect(byName['Muhammad Usama Sharif']).toBe(sharif);
    expect(byName['Muhammad Usama']).not.toBe(byName['Muhammad Usama Sharif']); // distinct
  });

  it('user-activity surfaces the entry + the auto_closed trim', async () => {
    const org = await seedOrg('Org', 'org');
    const admin = await seedUser(org, { name: 'Admin', role: 'admin' });
    const usama = await seedUser(org, { name: 'Muhammad Usama', role: 'employee' });

    // A post-sweep entry: shows 4h, source=system; the sweep trimmed it from 7h40m.
    const entryId = await seedTimeEntry(org, usama, {
      startedAt: new Date('2026-07-03T09:00:00Z'),
      endedAt: new Date('2026-07-03T13:00:00Z'), // 4h remaining
    });
    await getDb().update(schema.timeEntries).set({ source: 'system' }).where(eq(schema.timeEntries.id, entryId));
    await getDb().insert(schema.auditLogs).values({
      organizationId: org,
      actorType: 'system',
      action: 'time_entry.auto_closed',
      targetType: 'time_entry',
      targetId: entryId,
      metadata: {
        was_open: false,
        old_ended_at: '2026-07-03T16:40:00.000Z', // the real 7h40m end
        new_ended_at: '2026-07-03T13:00:00.000Z',
        trimmed_seconds: 13200, // 3h40m
        reason: 'no activity (machine asleep / agent stopped)',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/user-activity?userId=${usama}&date=2026-07-03&tzOffsetMinutes=0`,
      headers: authHeaders(org, admin),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].tracked_seconds).toBe(4 * 3600);
    expect(body.entries[0].source).toBe('system');
    expect(body.auto_closed).toHaveLength(1);
    expect(body.auto_closed[0].was_open).toBe(false);
    expect(body.auto_closed[0].trimmed_seconds).toBe(13200);
    expect(body.auto_closed[0].old_ended_at).toBe('2026-07-03T16:40:00.000Z');
  });

  it('a non-allowlisted employee is forbidden', async () => {
    const org = await seedOrg('Org', 'org');
    const emp = await seedUser(org, { name: 'Emp', role: 'employee' });
    const res = await app.inject({ method: 'GET', url: '/v1/admin/users?q=x', headers: authHeaders(org, emp) });
    expect(res.statusCode).toBe(403);
  });
});
