import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@timepro/db';
import { buildTestApp, resetDb, seedOrg, seedUser } from './helpers';
import type { OpsEmployee } from '../../src/lib/opscore';

const feed = vi.hoisted(() => ({ employees: [] as OpsEmployee[] }));
vi.mock('../../src/lib/opscore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/opscore')>();
  return {
    ...actual,
    opscoreApi: {
      ...actual.opscoreApi,
      employees: async () => ({ employees: feed.employees }),
      projects: async () => ({ projects: [] }),
      businessPartners: async () => ({ business_partners: [] }),
      tasks: async () => ({ tasks: [] }),
      productsOrNull: async () => null,
    },
  };
});

const { syncOrgFromOpsCore } = await import('../../src/lib/opscore-sync');

/** OpsCore `reporting_manager_id` → `memberships.reports_to_user_id`. */
describe('OpsCore reporting-line sync', () => {
  // Booting the app initializes the DB pool the sync uses.
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(resetDb);

  const emp = (id: string, managerId?: string | null): OpsEmployee => ({
    id,
    name: id,
    email: `${id}@acme.test`,
    company_email: null,
    status: 'ACTIVE',
    role: null,
    ...(managerId !== undefined ? { reporting_manager_id: managerId } : {}),
  });

  async function reportsToByOps(orgId: string): Promise<Map<string, string | null>> {
    const rows = await getDb()
      .select({
        ops: schema.users.opscoreEmployeeId,
        reportsTo: schema.memberships.reportsToUserId,
        userId: schema.users.id,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.organizationId, orgId));
    const opsByUser = new Map(rows.map((r) => [r.userId, r.ops]));
    return new Map(rows.map((r) => [r.ops ?? r.userId, r.reportsTo ? opsByUser.get(r.reportsTo) ?? null : null]));
  }

  it('mirrors the chain, including through a manager who left (not in the ACTIVE feed)', async () => {
    const org = await seedOrg('Acme', 'acme');
    const admin = await seedUser(org, { name: 'Admin', role: 'admin' });

    // first run: the soon-to-leave manager is still active
    feed.employees = [emp('ceo', null), emp('vp', 'ceo'), emp('lead', 'vp'), emp('dev', 'lead')];
    const r1 = await syncOrgFromOpsCore(org, admin);
    expect(r1.hierarchyFeedAvailable).toBe(true);
    expect(r1.reportingLinesChanged).toBe(3);
    let lines = await reportsToByOps(org);
    expect(lines.get('dev')).toBe('lead');
    expect(lines.get('lead')).toBe('vp');
    expect(lines.get('ceo')).toBeNull();

    // vp leaves: absent from the ACTIVE feed, but lead still points at vp upstream
    feed.employees = [emp('ceo', null), emp('lead', 'vp'), emp('dev', 'lead')];
    const r2 = await syncOrgFromOpsCore(org, admin);
    expect(r2.reportingLinesChanged).toBe(0); // nothing changed, no rewrites
    lines = await reportsToByOps(org);
    expect(lines.get('lead')).toBe('vp'); // resolved through the local user mirror
  });

  it('leaves existing lines untouched when the feed predates the field', async () => {
    const org = await seedOrg('Acme', 'acme');
    const admin = await seedUser(org, { name: 'Admin', role: 'admin' });
    feed.employees = [emp('ceo', null), emp('dev', 'ceo')];
    await syncOrgFromOpsCore(org, admin);

    feed.employees = [emp('ceo'), emp('dev')]; // old OpsCore: no reporting_manager_id key
    const r = await syncOrgFromOpsCore(org, admin);
    expect(r.hierarchyFeedAvailable).toBe(false);
    expect((await reportsToByOps(org)).get('dev')).toBe('ceo');
  });

  it('clears a line when OpsCore moves someone to the top', async () => {
    const org = await seedOrg('Acme', 'acme');
    const admin = await seedUser(org, { name: 'Admin', role: 'admin' });
    feed.employees = [emp('ceo', null), emp('dev', 'ceo')];
    await syncOrgFromOpsCore(org, admin);

    feed.employees = [emp('ceo', null), emp('dev', null)];
    await syncOrgFromOpsCore(org, admin);
    const [devMembership] = await getDb()
      .select({ reportsTo: schema.memberships.reportsToUserId })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(and(eq(schema.memberships.organizationId, org), eq(schema.users.opscoreEmployeeId, 'dev')));
    expect(devMembership!.reportsTo).toBeNull();
  });
});
