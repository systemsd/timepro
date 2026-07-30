import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@timepro/db';
import { buildTestApp, resetDb, seedOrg, seedUser, authHeaders } from './helpers';

/**
 * Internal Products (Phase A) — the picker feed, the task dimension, and the two
 * invariants that must never regress:
 *   1. project XOR product, guarded in the route AND by a DB check constraint;
 *   2. product time is non-billable, decided server-side (never client-supplied).
 */

async function setOpsId(userId: string, opsId: string): Promise<void> {
  await getDb().update(schema.users).set({ opscoreEmployeeId: opsId }).where(eq(schema.users.id, userId));
}

async function seedProject(orgId: string, name: string, createdBy: string): Promise<string> {
  const [p] = await getDb()
    .insert(schema.projects)
    .values({ organizationId: orgId, name, status: 'active', createdBy })
    .returning({ id: schema.projects.id });
  return p!.id;
}

async function seedProduct(
  orgId: string,
  opts: { name: string; stage?: string; active?: boolean; members?: string[] },
): Promise<string> {
  const [p] = await getDb()
    .insert(schema.products)
    .values({
      organizationId: orgId,
      opscoreProductId: `ops-prod-${randomUUID()}`,
      name: opts.name,
      stage: opts.stage ?? 'BUILD',
      active: opts.active ?? true,
    })
    .returning({ id: schema.products.id });
  for (const userId of opts.members ?? []) {
    await getDb().insert(schema.productMembers).values({ productId: p!.id, userId });
  }
  return p!.id;
}

async function seedTask(
  orgId: string,
  opts: { name: string; projectId?: string | null; productId?: string | null; assignee?: string | null },
): Promise<string> {
  const [t] = await getDb()
    .insert(schema.tasks)
    .values({
      organizationId: orgId,
      opscoreTaskId: `ops-${randomUUID()}`,
      name: opts.name,
      status: 'TODO',
      priority: 'MEDIUM',
      projectId: opts.projectId ?? null,
      productId: opts.productId ?? null,
      assignedOpscoreEmployeeId: opts.assignee ?? null,
      collaboratorOpscoreEmployeeIds: [],
    })
    .returning({ id: schema.tasks.id });
  return t!.id;
}

describe('Internal Products — picker scoping, task dimension, XOR + billable invariants', () => {
  let app: FastifyInstance;
  let org: string;
  let alice: string; // product member (ops id OPS_A)
  let bob: string; // not a member of anything
  const OPS_A = 'ops-emp-alice';

  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });

  beforeEach(async () => {
    await resetDb();
    org = await seedOrg('Org', 'org');
    alice = await seedUser(org, { name: 'Alice', role: 'employee' });
    bob = await seedUser(org, { name: 'Bob', role: 'employee' });
    await setOpsId(alice, OPS_A);
  });

  const listProducts = (userId: string, query = '') =>
    app.inject({ method: 'GET', url: `/v1/products${query}`, headers: authHeaders(org, userId) });

  const listTasks = (userId: string, query = '') =>
    app.inject({ method: 'GET', url: `/v1/tasks${query}`, headers: authHeaders(org, userId) });

  const startTimer = (userId: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/timer/start',
      headers: authHeaders(org, userId),
      payload: { client_event_id: randomUUID(), ...body },
    });

  const stopTimer = (userId: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/timer/stop',
      headers: authHeaders(org, userId),
      payload: { client_event_id: randomUUID() },
    });

  const entryOf = async (id: string) => {
    const [row] = await getDb()
      .select({
        projectId: schema.timeEntries.projectId,
        productId: schema.timeEntries.productId,
        isBillable: schema.timeEntries.isBillable,
      })
      .from(schema.timeEntries)
      .where(eq(schema.timeEntries.id, id));
    return row!;
  };

  // ---- GET /v1/products ----

  it('lists only the caller’s products; hides ARCHIVED and feed-absent ones', async () => {
    await seedProduct(org, { name: 'TimePro', members: [alice] });
    await seedProduct(org, { name: 'Paused-but-visible', stage: 'PAUSED', members: [alice] });
    await seedProduct(org, { name: 'Archived', stage: 'ARCHIVED', members: [alice] });
    await seedProduct(org, { name: 'Deleted-upstream', active: false, members: [alice] });
    await seedProduct(org, { name: 'Someone-else’s', members: [bob] });

    const mine = (await listProducts(alice)).json().products.map((p: { name: string }) => p.name).sort();
    expect(mine).toEqual(['Paused-but-visible', 'TimePro']);

    // Non-member sees only their own; no cross-member leak.
    const theirs = (await listProducts(bob)).json().products.map((p: { name: string }) => p.name);
    expect(theirs).toEqual(['Someone-else’s']);
  });

  it('always reports products as non-billable', async () => {
    await seedProduct(org, { name: 'TimePro', members: [alice] });
    const rows = (await listProducts(alice)).json().products;
    expect(rows).toHaveLength(1);
    expect(rows[0].is_billable).toBe(false);
  });

  // ---- GET /v1/tasks product dimension ----

  it('filters tasks by product, and keeps product tasks OUT of the No-project bucket', async () => {
    const proj = await seedProject(org, 'Website', alice);
    const prod = await seedProduct(org, { name: 'TimePro', members: [alice] });
    await seedTask(org, { name: 'On-project', projectId: proj, assignee: OPS_A });
    await seedTask(org, { name: 'On-product', productId: prod, assignee: OPS_A });
    await seedTask(org, { name: 'Unattached', assignee: OPS_A });

    const byProduct = (await listTasks(alice, `?product_id=${prod}`)).json().tasks;
    expect(byProduct.map((t: { name: string }) => t.name)).toEqual(['On-product']);
    expect(byProduct[0].product_id).toBe(prod);

    const byProject = (await listTasks(alice, `?project_id=${proj}`)).json().tasks.map((t: { name: string }) => t.name);
    expect(byProject).toEqual(['On-project']);

    // The bucket means *unattached* — a product task must not double-list here,
    // where picking it would track with no attribution at all.
    const none = (await listTasks(alice, '?project_id=none')).json().tasks.map((t: { name: string }) => t.name);
    expect(none).toEqual(['Unattached']);
  });

  // ---- POST /v1/timer/start ----

  it('tracks against a product, persists product_id, and forces is_billable=false', async () => {
    const prod = await seedProduct(org, { name: 'TimePro', members: [alice] });

    // is_billable=true is not even accepted from the client — the field isn't in
    // the schema, so a client that tries it is silently ignored.
    const res = await startTimer(alice, { product_id: prod, is_billable: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().product_id).toBe(prod);
    expect(res.json().project_id).toBeNull();

    const entry = await entryOf(res.json().id);
    expect(entry.productId).toBe(prod);
    expect(entry.projectId).toBeNull();
    expect(entry.isBillable).toBe(false);
  });

  it('leaves project time billable (control for the product rule)', async () => {
    const proj = await seedProject(org, 'Website', alice);
    const res = await startTimer(alice, { project_id: proj });
    expect(res.statusCode).toBe(200);

    const entry = await entryOf(res.json().id);
    expect(entry.projectId).toBe(proj);
    expect(entry.productId).toBeNull();
    expect(entry.isBillable).toBe(true);
  });

  it('rejects a start that names both a project and a product', async () => {
    const proj = await seedProject(org, 'Website', alice);
    const prod = await seedProduct(org, { name: 'TimePro', members: [alice] });

    const res = await startTimer(alice, { project_id: proj, product_id: prod });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('project_product_exclusive');

    // Nothing was written.
    const open = await getDb()
      .select({ id: schema.timeEntries.id })
      .from(schema.timeEntries)
      .where(eq(schema.timeEntries.organizationId, org));
    expect(open).toEqual([]);
  });

  it('refuses a product the caller isn’t on, or one that isn’t trackable', async () => {
    const notMine = await seedProduct(org, { name: 'Theirs', members: [bob] });
    const archived = await seedProduct(org, { name: 'Archived', stage: 'ARCHIVED', members: [alice] });
    const gone = await seedProduct(org, { name: 'Deleted-upstream', active: false, members: [alice] });

    for (const productId of [notMine, archived, gone]) {
      const res = await startTimer(alice, { product_id: productId });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('product_not_trackable');
    }
  });

  it('stays backward compatible: a start with neither project nor product still works', async () => {
    const res = await startTimer(alice, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().product_id).toBeNull();
    await stopTimer(alice);
  });

  it('re-assigning product time to a project drops the product link instead of tripping the check', async () => {
    const prod = await seedProduct(org, { name: 'TimePro', members: [alice] });
    const proj = await seedProject(org, 'Website', alice);
    // The edit endpoint requires the entry's user to be assigned to the project.
    await getDb().insert(schema.projectMembers).values({ projectId: proj, userId: alice });

    const started = await startTimer(alice, { product_id: prod });
    expect(started.statusCode).toBe(200);
    await stopTimer(alice);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/time-entries/${started.json().id}`,
      headers: authHeaders(org, alice),
      payload: { project_id: proj },
    });
    expect(patched.statusCode).toBe(200);

    const entry = await entryOf(started.json().id);
    expect(entry.projectId).toBe(proj);
    expect(entry.productId).toBeNull();
    // Moving an entry is not a re-billing decision — it stays non-billable.
    expect(entry.isBillable).toBe(false);
  });

  // ---- DB-level guard (defence in depth behind the route check) ----

  it('the DB check constraint rejects a time entry with both a project and a product', async () => {
    const proj = await seedProject(org, 'Website', alice);
    const prod = await seedProduct(org, { name: 'TimePro', members: [alice] });

    await expect(
      getDb().insert(schema.timeEntries).values({
        organizationId: org,
        userId: alice,
        projectId: proj,
        productId: prod,
        startedAt: new Date(),
        clientEventId: `evt-${randomUUID()}`,
        source: 'desktop',
      }),
    ).rejects.toThrow(/time_entries_project_xor_product/);
  });

  it('the DB check constraint rejects a task with both a project and a product', async () => {
    const proj = await seedProject(org, 'Website', alice);
    const prod = await seedProduct(org, { name: 'TimePro', members: [alice] });

    await expect(
      seedTask(org, { name: 'Confused', projectId: proj, productId: prod }),
    ).rejects.toThrow(/tasks_project_xor_product/);
  });
});
