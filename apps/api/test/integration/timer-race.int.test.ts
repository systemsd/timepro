import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, buildTestApp, countOpenTimers, resetDb, seedOrg, seedUser } from './helpers';

/** Step-1 fix: concurrent timer/start must not open two timers for one user. */
describe('timer double-start race', () => {
  let app: FastifyInstance;
  let orgId: string;
  let userId: string;
  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await resetDb();
    orgId = await seedOrg('Org', 'org');
    userId = await seedUser(orgId, { name: 'Emp', role: 'employee' });
  });

  const start = (eventId: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/timer/start',
      headers: authHeaders(orgId, userId),
      payload: { client_event_id: eventId },
    });

  it('two concurrent starts (distinct event ids) yield exactly one open timer', async () => {
    const [a, b] = await Promise.all([start('evt-aaaaaaaa'), start('evt-bbbbbbbb')]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    // The advisory lock serializes them: the second returns the first's entry.
    expect(a.json().id).toBe(b.json().id);
    expect(await countOpenTimers(orgId, userId)).toBe(1);
  });
});
