import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@timepro/db';
import {
  authHeaders,
  buildTestApp,
  resetDb,
  seedOrg,
  seedScreenshot,
  seedTimeEntry,
  seedUser,
} from './helpers';

/**
 * Hierarchy-scoped visibility: a member sees everyone below them in the OpsCore
 * reporting chain, plus members an admin grants them — read-only. Writes stay
 * with admins and team managers (`manageableUsers`).
 */
describe('activity visibility (reporting chain + view grants)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(resetDb);

  const day = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const at = (hour: number): Date => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);

  async function reportsTo(orgId: string, userId: string, managerId: string | null): Promise<void> {
    await getDb()
      .update(schema.memberships)
      .set({ reportsToUserId: managerId })
      .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, userId)));
  }

  async function rosterIds(orgId: string, viewer: string): Promise<string[]> {
    const res = await app.inject({ method: 'GET', url: '/v1/roster', headers: authHeaders(orgId, viewer) });
    expect(res.statusCode).toBe(200);
    return res.json().rows.map((r: { user_id: string }) => r.user_id);
  }

  /** CEO → Lead → Dev, all `employee` role (the hierarchy alone grants visibility). */
  async function seedChain() {
    const org = await seedOrg('Acme', 'acme');
    const admin = await seedUser(org, { name: 'Admin', role: 'admin' });
    const ceo = await seedUser(org, { name: 'Ceo', role: 'employee' });
    const lead = await seedUser(org, { name: 'Lead', role: 'employee' });
    const dev = await seedUser(org, { name: 'Dev', role: 'employee' });
    const peer = await seedUser(org, { name: 'Peer', role: 'employee' });
    await reportsTo(org, lead, ceo);
    await reportsTo(org, dev, lead);
    return { org, admin, ceo, lead, dev, peer };
  }

  it('a member sees the whole chain below them, never above or sideways', async () => {
    const { org, ceo, lead, dev, peer } = await seedChain();

    expect(new Set(await rosterIds(org, ceo))).toEqual(new Set([ceo, lead, dev]));
    expect(new Set(await rosterIds(org, lead))).toEqual(new Set([lead, dev]));
    expect(await rosterIds(org, dev)).toEqual([dev]);
    expect(await rosterIds(org, peer)).toEqual([peer]);

    // skip-level timeline read is allowed; upward is not
    const down = await app.inject({
      method: 'GET',
      url: `/v1/timeline/${dev}?date=${day}`,
      headers: authHeaders(org, ceo),
    });
    expect(down.statusCode).toBe(200);
    expect(down.json().can_manage).toBe(false); // view-only

    const up = await app.inject({
      method: 'GET',
      url: `/v1/timeline/${ceo}?date=${day}`,
      headers: authHeaders(org, dev),
    });
    expect(up.statusCode).toBe(403);
  });

  it('reports are scoped to the chain', async () => {
    const { org, ceo, lead, dev, peer } = await seedChain();
    await seedTimeEntry(org, dev, { startedAt: at(9), endedAt: at(10) });
    await seedTimeEntry(org, peer, { startedAt: at(9), endedAt: at(13) });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/reports/run',
      headers: authHeaders(org, lead),
      payload: { type: 'summary', from: day, to: day, tzOffsetMinutes: 0, groupBy: ['employee'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total_seconds).toBe(3600); // dev's hour, not peer's four
    void ceo;
  });

  it('hierarchy access is view-only: no editing or deleting a report’s data', async () => {
    const { org, lead, dev } = await seedChain();
    const entry = await seedTimeEntry(org, dev, { startedAt: at(9), endedAt: at(10) });
    const shot = await seedScreenshot(org, dev, at(9));

    const edit = await app.inject({
      method: 'PATCH',
      url: `/v1/time-entries/${entry}`,
      headers: authHeaders(org, lead),
      payload: { description: 'changed by my lead' },
    });
    expect(edit.statusCode).toBe(403);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/screenshots/${shot}`,
      headers: authHeaders(org, lead),
    });
    expect(del.statusCode).toBe(403);

    const add = await app.inject({
      method: 'POST',
      url: '/v1/time-entries',
      headers: authHeaders(org, lead),
      payload: { user_id: dev, started_at: at(11).toISOString(), ended_at: at(12).toISOString() },
    });
    expect(add.statusCode).toBe(403);
  });

  it('a reporting cycle upstream does not hang the scope query', async () => {
    const org = await seedOrg('Loop', 'loop');
    const a = await seedUser(org, { name: 'A', role: 'employee' });
    const b = await seedUser(org, { name: 'B', role: 'employee' });
    await reportsTo(org, a, b);
    await reportsTo(org, b, a);
    expect(new Set(await rosterIds(org, a))).toEqual(new Set([a, b]));
  });

  it('admin view grants add read-only visibility, are audited, and can be revoked', async () => {
    const { org, admin, peer, dev } = await seedChain();
    const url = `/v1/team/members/${peer}/visibility`;

    const grant = await app.inject({
      method: 'PUT',
      url,
      headers: authHeaders(org, admin),
      payload: { subject_user_ids: [dev, peer] }, // self is dropped silently
    });
    expect(grant.statusCode).toBe(200);
    expect(new Set(await rosterIds(org, peer))).toEqual(new Set([peer, dev]));

    const read = await app.inject({ method: 'GET', url, headers: authHeaders(org, admin) });
    expect(read.json().grants.map((g: { user_id: string }) => g.user_id)).toEqual([dev]);

    const audit = await getDb()
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, org));
    expect(audit.map((a) => a.action)).toContain('activity_view_grant.update');

    // still read-only
    const entry = await seedTimeEntry(org, dev, { startedAt: at(9), endedAt: at(10) });
    const edit = await app.inject({
      method: 'PATCH',
      url: `/v1/time-entries/${entry}`,
      headers: authHeaders(org, peer),
      payload: { description: 'nope' },
    });
    expect(edit.statusCode).toBe(403);

    const revoke = await app.inject({
      method: 'PUT',
      url,
      headers: authHeaders(org, admin),
      payload: { subject_user_ids: [] },
    });
    expect(revoke.statusCode).toBe(200);
    expect(await rosterIds(org, peer)).toEqual([peer]);
  });

  it('a manager granted someone outside their team can view but not edit them', async () => {
    const org = await seedOrg('Mgr', 'mgr');
    const admin = await seedUser(org, { name: 'Admin', role: 'admin' });
    const mgr = await seedUser(org, { name: 'Mgr', role: 'manager' });
    const other = await seedUser(org, { name: 'Other', role: 'employee' });
    await app.inject({
      method: 'PUT',
      url: `/v1/team/members/${mgr}/visibility`,
      headers: authHeaders(org, admin),
      payload: { subject_user_ids: [other] },
    });
    const entry = await seedTimeEntry(org, other, { startedAt: at(9), endedAt: at(10) });

    const view = await app.inject({
      method: 'GET',
      url: `/v1/timeline/${other}?date=${day}`,
      headers: authHeaders(org, mgr),
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().can_manage).toBe(false);

    const edit = await app.inject({
      method: 'PATCH',
      url: `/v1/time-entries/${entry}`,
      headers: authHeaders(org, mgr),
      payload: { description: 'nope' },
    });
    expect(edit.statusCode).toBe(403);
  });

  it('only admins manage grants, and only for members of their own org', async () => {
    const { org, admin, ceo, peer } = await seedChain();
    const outsiderOrg = await seedOrg('Other', 'other');
    const outsider = await seedUser(outsiderOrg, { name: 'Outsider', role: 'employee' });

    const byEmployee = await app.inject({
      method: 'PUT',
      url: `/v1/team/members/${peer}/visibility`,
      headers: authHeaders(org, ceo),
      payload: { subject_user_ids: [] },
    });
    expect(byEmployee.statusCode).toBe(403);

    const crossOrg = await app.inject({
      method: 'PUT',
      url: `/v1/team/members/${peer}/visibility`,
      headers: authHeaders(org, admin),
      payload: { subject_user_ids: [outsider] },
    });
    expect(crossOrg.statusCode).toBe(400);
  });

  it('/me/access and the team list reflect who can see others', async () => {
    const { org, lead, dev, peer, admin, ceo } = await seedChain();

    const access = async (u: string) =>
      (await app.inject({ method: 'GET', url: '/v1/me/access', headers: authHeaders(org, u) })).json();
    expect(await access(lead)).toMatchObject({ can_view_others: true, can_manage_team: false });
    expect(await access(peer)).toMatchObject({ can_view_others: false, can_manage_team: false });
    expect(await access(admin)).toMatchObject({ can_view_others: true, can_manage_team: true });

    const asLead = await app.inject({ method: 'GET', url: '/v1/team/members', headers: authHeaders(org, lead) });
    expect(asLead.statusCode).toBe(200);
    expect(new Set(asLead.json().members.map((m: { user_id: string }) => m.user_id))).toEqual(
      new Set([lead, dev]),
    );
    const asPeer = await app.inject({ method: 'GET', url: '/v1/team/members', headers: authHeaders(org, peer) });
    expect(asPeer.statusCode).toBe(403);

    const vis = await app.inject({
      method: 'GET',
      url: `/v1/team/members/${lead}/visibility`,
      headers: authHeaders(org, admin),
    });
    expect(vis.json()).toMatchObject({ reports_to: { user_id: ceo }, subordinate_count: 1, grants: [] });
  });
});
