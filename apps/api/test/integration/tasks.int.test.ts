import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@timepro/db';
import { buildTestApp, resetDb, seedOrg, seedUser, authHeaders } from './helpers';
import { setOrgDefault } from '../../src/lib/settings';

/** Give a seeded user an OpsCore directory identity (tasks scope on this id). */
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

async function seedTask(
  orgId: string,
  opts: {
    name: string;
    status?: string;
    priority?: string;
    projectId?: string | null;
    assignee?: string | null;
    collaborators?: string[];
    active?: boolean;
  },
): Promise<string> {
  const [t] = await getDb()
    .insert(schema.tasks)
    .values({
      organizationId: orgId,
      opscoreTaskId: `ops-${randomUUID()}`,
      name: opts.name,
      status: opts.status ?? 'TODO',
      priority: opts.priority ?? 'MEDIUM',
      projectId: opts.projectId ?? null,
      assignedOpscoreEmployeeId: opts.assignee ?? null,
      collaboratorOpscoreEmployeeIds: opts.collaborators ?? [],
      active: opts.active ?? true,
    })
    .returning({ id: schema.tasks.id });
  return t!.id;
}

describe('OpsCore task sync — picker scoping + timer enforcement', () => {
  let app: FastifyInstance;
  let org: string;
  let alice: string; // assignee (ops id OPS_A)
  let bob: string; // outsider, no tasks
  let carol: string; // collaborator (ops id OPS_C)
  const OPS_A = 'ops-emp-alice';
  const OPS_C = 'ops-emp-carol';

  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });

  beforeEach(async () => {
    await resetDb();
    org = await seedOrg('Org', 'org');
    alice = await seedUser(org, { name: 'Alice', role: 'employee' });
    bob = await seedUser(org, { name: 'Bob', role: 'employee' });
    carol = await seedUser(org, { name: 'Carol', role: 'employee' });
    await setOpsId(alice, OPS_A);
    await setOpsId(carol, OPS_C);
    // Bob intentionally has no OpsCore identity.
  });

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

  it('scopes tasks to the assignee OR a collaborator; hides them from everyone else', async () => {
    await seedTask(org, { name: 'A-owned', assignee: OPS_A });
    await seedTask(org, { name: 'Shared', assignee: OPS_A, collaborators: [OPS_C] });
    await seedTask(org, { name: 'Someone-else', assignee: 'ops-emp-dan' });

    const a = (await listTasks(alice)).json().tasks.map((t: { name: string }) => t.name).sort();
    expect(a).toEqual(['A-owned', 'Shared']); // assignee sees both of theirs

    const c = (await listTasks(carol)).json().tasks.map((t: { name: string }) => t.name);
    expect(c).toEqual(['Shared']); // collaborator sees only the shared one

    const b = (await listTasks(bob)).json().tasks;
    expect(b).toEqual([]); // no OpsCore identity → no tasks (no leak)
  });

  it('hides DONE and inactive tasks from the picker', async () => {
    await seedTask(org, { name: 'Open', assignee: OPS_A, status: 'IN_PROGRESS' });
    await seedTask(org, { name: 'Finished', assignee: OPS_A, status: 'DONE' });
    await seedTask(org, { name: 'Gone', assignee: OPS_A, active: false });

    const names = (await listTasks(alice)).json().tasks.map((t: { name: string }) => t.name);
    expect(names).toEqual(['Open']);
  });

  it('filters by project and the No-project bucket', async () => {
    const proj = await seedProject(org, 'Website', alice);
    await seedTask(org, { name: 'On-project', assignee: OPS_A, projectId: proj });
    await seedTask(org, { name: 'No-project', assignee: OPS_A, projectId: null });

    const onProj = (await listTasks(alice, `?project_id=${proj}`)).json().tasks.map((t: { name: string }) => t.name);
    expect(onProj).toEqual(['On-project']);

    const none = (await listTasks(alice, '?project_id=none')).json().tasks.map((t: { name: string }) => t.name);
    expect(none).toEqual(['No-project']);
  });

  it('lets a user track their own task, rejects someone else’s (no IDOR), and allows no task', async () => {
    const task = await seedTask(org, { name: 'A-owned', assignee: OPS_A });

    // Alice can track against her task.
    const ok = await startTimer(alice, { task_id: task });
    expect(ok.statusCode).toBe(200);
    // …and it persists on the entry.
    const [entry] = await getDb()
      .select({ taskId: schema.timeEntries.taskId })
      .from(schema.timeEntries)
      .where(eq(schema.timeEntries.id, ok.json().id));
    expect(entry!.taskId).toBe(task);

    // Bob cannot track against Alice's task.
    const denied = await startTimer(bob, { task_id: task });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().code).toBe('task_not_trackable');

    // No task_id still works (backward compatible for old agents).
    const noTask = await startTimer(carol, {});
    expect(noTask.statusCode).toBe(200);
  });

  it('enforces tracking.require_task: a no-task start is blocked only when the setting is on', async () => {
    const task = await seedTask(org, { name: 'A-owned', assignee: OPS_A });

    // Default (off) → a no-task start is allowed.
    expect((await startTimer(alice, {})).statusCode).toBe(200);
    await stopTimer(alice);

    // Turn it on at the org level.
    await setOrgDefault(getDb(), org, 'tracking.require_task', true, alice);

    // Now a no-task start is rejected…
    const blocked = await startTimer(alice, {});
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().code).toBe('task_required');

    // …but starting with an assigned task still works.
    expect((await startTimer(alice, { task_id: task })).statusCode).toBe(200);
  });
});
