import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, buildTestApp, resetDb, seedOrg, seedScreenshot, seedUser } from './helpers';

/** Step-1 fix: roster returns the latest screenshot per user (DISTINCT ON). */
describe('roster latest-screenshot-per-user', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(resetDb);

  it('reports each user’s newest screenshot id', async () => {
    const orgId = await seedOrg('Org', 'org');
    const admin = await seedUser(orgId, { name: 'Admin', role: 'admin' });
    const emp = await seedUser(orgId, { name: 'Emp', role: 'employee' });

    await seedScreenshot(orgId, emp, new Date('2026-01-15T08:00:00.000Z'));
    await seedScreenshot(orgId, emp, new Date('2026-01-15T09:00:00.000Z'));
    const newest = await seedScreenshot(orgId, emp, new Date('2026-01-15T10:00:00.000Z'));

    const res = await app.inject({ method: 'GET', url: '/v1/roster', headers: authHeaders(orgId, admin) });
    expect(res.statusCode).toBe(200);
    const empRow = res.json().rows.find((r: { user_id: string }) => r.user_id === emp);
    expect(empRow.last_screenshot_id).toBe(newest); // the latest, not an older one
  });
});
