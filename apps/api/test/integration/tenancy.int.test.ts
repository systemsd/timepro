import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  authHeaders,
  buildTestApp,
  resetDb,
  seedOrg,
  seedTimeEntry,
  seedUser,
} from './helpers';

/**
 * The crown-jewel safety net: tenant isolation + RBAC scoping. There is no RLS
 * backstop today (isolation is app-layer WHERE clauses), so this is what proves
 * org A can't read org B and that employees only see themselves.
 */
describe('tenancy + RBAC scoping', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(resetDb);

  // A day safely in the past, so the report window (clipped to `now`) always
  // contains the seeded entries regardless of the time of day the suite runs.
  const day = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const at = (hour: number): Date => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);

  it('a report scoped to org A never includes org B data', async () => {
    const orgA = await seedOrg('Alpha', 'alpha');
    const adminA = await seedUser(orgA, { name: 'AdminA', role: 'admin' });
    const empA = await seedUser(orgA, { name: 'EmpA', role: 'employee' });
    await seedTimeEntry(orgA, empA, { startedAt: at(9), endedAt: at(10) }); // 1h

    const orgB = await seedOrg('Bravo', 'bravo');
    const empB = await seedUser(orgB, { name: 'EmpB', role: 'employee' });
    await seedTimeEntry(orgB, empB, { startedAt: at(9), endedAt: at(14) }); // 5h

    const from = day;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/reports/run',
      headers: authHeaders(orgA, adminA),
      payload: { type: 'summary', from, to: from, tzOffsetMinutes: 0, groupBy: ['employee'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const empIds = body.by_employee.map((r: { key: string }) => r.key);
    expect(empIds).toContain(empA);
    expect(empIds).not.toContain(empB); // org B is invisible
    expect(body.total_seconds).toBe(3600); // 1h only — not org B's 5h
  });

  it('roster for an admin lists only their own org; an employee sees only themselves', async () => {
    const orgA = await seedOrg('Alpha', 'alpha');
    const adminA = await seedUser(orgA, { name: 'AdminA', role: 'admin' });
    const empA1 = await seedUser(orgA, { name: 'EmpA1', role: 'employee' });
    const empA2 = await seedUser(orgA, { name: 'EmpA2', role: 'employee' });
    const orgB = await seedOrg('Bravo', 'bravo');
    const empB = await seedUser(orgB, { name: 'EmpB', role: 'employee' });

    const asAdmin = await app.inject({ method: 'GET', url: '/v1/roster', headers: authHeaders(orgA, adminA) });
    const adminIds = asAdmin.json().rows.map((r: { user_id: string }) => r.user_id);
    expect(new Set(adminIds)).toEqual(new Set([adminA, empA1, empA2])); // all of org A, none of B
    expect(adminIds).not.toContain(empB);

    const asEmp = await app.inject({ method: 'GET', url: '/v1/roster', headers: authHeaders(orgA, empA1) });
    const empIds = asEmp.json().rows.map((r: { user_id: string }) => r.user_id);
    expect(empIds).toEqual([empA1]); // employee sees only self
  });
});
