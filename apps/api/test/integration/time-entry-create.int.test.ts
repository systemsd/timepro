import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@timepro/db';
import { sweepAbandonedTimers } from '../../src/lib/timer-sweep';
import { buildTestApp, resetDb, seedOrg, seedUser, seedTimeEntry, authHeaders } from './helpers';

/**
 * POST /v1/time-entries — create a manual entry (backfill for time the agent
 * never tracked). Locks: RBAC (no fabricating others' time), overlap rejection,
 * audit trail, and that a signal-less manual entry survives the abandoned-timer
 * sweep (the whole reason it's a distinct entry, not an edit of a tracked one).
 */
describe('POST /v1/time-entries (manual backfill)', () => {
  let app: FastifyInstance;
  let org: string, admin: string, emp: string, other: string;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    org = await seedOrg('Org', 'org');
    admin = await seedUser(org, { name: 'Boss', role: 'admin' });
    emp = await seedUser(org, { name: 'Emp', role: 'employee' });
    other = await seedUser(org, { name: 'Other', role: 'employee' });
  });

  const create = (actor: string, body: object) =>
    app.inject({
      method: 'POST',
      url: '/v1/time-entries',
      headers: { ...authHeaders(org, actor), 'content-type': 'application/json' },
      payload: body,
    });

  const START = '2026-07-17T09:40:21.000Z';
  const END = '2026-07-17T13:06:00.000Z';

  it('admin creates a manual entry for an employee — labeled, audited, sweep-durable', async () => {
    const res = await create(admin, { user_id: emp, started_at: START, ended_at: END, description: 'Backfill' });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b).toMatchObject({ user_id: emp, source: 'manual', is_manual: true, started_at: START, ended_at: END });

    // Written to the audit trail, attributed to the admin who added it.
    const audits = await getDb()
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.targetId, b.id), eq(schema.auditLogs.action, 'time_entry.create')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorUserId).toBe(admin);

    // No activity signal → the abandoned-timer sweep must leave it untouched.
    await sweepAbandonedTimers();
    const [row] = await getDb().select().from(schema.timeEntries).where(eq(schema.timeEntries.id, b.id));
    expect(row!.endedAt?.toISOString()).toBe(END);
  });

  it('an employee cannot create time for another user (403)', async () => {
    const res = await create(emp, { user_id: other, started_at: START, ended_at: END });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an entry that overlaps an existing one (409 entry_overlap)', async () => {
    await seedTimeEntry(org, emp, {
      startedAt: new Date('2026-07-17T12:00:00Z'),
      endedAt: new Date('2026-07-17T14:00:00Z'),
    });
    const res = await create(admin, { user_id: emp, started_at: START, ended_at: END });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('entry_overlap');
  });

  it('rejects start >= end (422)', async () => {
    const res = await create(admin, { user_id: emp, started_at: END, ended_at: START });
    expect(res.statusCode).toBe(422);
  });
});
