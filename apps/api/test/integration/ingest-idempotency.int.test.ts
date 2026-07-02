import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, buildTestApp, countAppUsage, resetDb, seedOrg, seedUser } from './helpers';

/** Step-1 fix: a retried app-usage batch must not double-insert intervals. */
describe('ingest idempotency (app-usage)', () => {
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

  const batch = {
    events: [
      { app_name: 'Code', started_at: '2026-01-15T09:00:00.000Z', ended_at: '2026-01-15T09:05:00.000Z' },
      { app_name: 'Chrome', started_at: '2026-01-15T09:05:00.000Z', ended_at: '2026-01-15T09:10:00.000Z' },
    ],
  };

  const post = () =>
    app.inject({ method: 'POST', url: '/v1/ingest/app-usage', headers: authHeaders(orgId, userId), payload: batch });

  it('inserts each interval once even when the batch is retried', async () => {
    await post();
    await post();
    await post();
    expect(await countAppUsage(orgId, userId)).toBe(2); // not 6
  });

  it('collapses duplicates within a single batch', async () => {
    const dupBatch = { events: [batch.events[0], batch.events[0], batch.events[1]] };
    const res = await app.inject({
      method: 'POST', url: '/v1/ingest/app-usage', headers: authHeaders(orgId, userId), payload: dupBatch,
    });
    expect(res.statusCode).toBe(200);
    expect(await countAppUsage(orgId, userId)).toBe(2);
  });
});
