import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '@timepro/db';
import { mapOpsCoreRole, opscoreApi } from './opscore';
import { loadConfig } from '../config';

/**
 * OpsCore directory sync (C2/C3) — pull employees / projects / clients / tasks
 * from OpsCore and upsert them into one org. OpsCore is authoritative: identity,
 * roles, the project↔client link, project membership, and the task mirror all
 * come from OpsCore. TimePro never writes back.
 *
 * Extracted from the `POST /v1/admin/opscore/sync` handler so the same logic can
 * run on a schedule (see `runScheduledOpscoreSync`) — new OpsCore assignments then
 * flow in without a manual trigger. Uses explicit `organization_id` filters (no
 * tenant GUC), so it's safe to call outside a request context.
 *
 * `createdBy` is the user recorded as the creator of any *newly* inserted project
 * (`projects.created_by` is NOT NULL): the requesting admin for the route, or an
 * org owner/admin for the scheduled run.
 */
export interface OpscoreSyncResult {
  users: number;
  clients: number;
  projects: number;
  assignments: number;
  disabled: number;
  tasks: number;
  tasksDisabled: number;
}

/** OpsCore ProjectStatus → TimePro project status. */
export function mapProjectStatus(s: string): string {
  switch (s) {
    case 'COMPLETED':
      return 'archived';
    case 'PAUSED':
      return 'paused';
    default:
      return 'active'; // ONGOING | MAINTENANCE | unknown
  }
}

export async function syncOrgFromOpsCore(
  orgId: string,
  createdBy: string,
): Promise<OpscoreSyncResult> {
  const db = getDb();

  const [emp, proj, bp, tsk] = await Promise.all([
    opscoreApi.employees(),
    opscoreApi.projects(),
    opscoreApi.businessPartners(),
    opscoreApi.tasks(),
  ]);

  // 1) Clients (business partners) — match by opscore id, then by name
  // (adopt an existing local client of the same name), else insert.
  const clientByOps = new Map<string, string>();
  for (const b of bp.business_partners) {
    let [existing] = await db
      .select({ id: schema.clients.id })
      .from(schema.clients)
      .where(
        and(eq(schema.clients.organizationId, orgId), eq(schema.clients.opscoreBusinessPartnerId, b.id)),
      )
      .limit(1);
    if (!existing) {
      [existing] = await db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(and(eq(schema.clients.organizationId, orgId), eq(schema.clients.name, b.name)))
        .limit(1);
    }
    if (existing) {
      await db
        .update(schema.clients)
        .set({ name: b.name, opscoreBusinessPartnerId: b.id })
        .where(eq(schema.clients.id, existing.id));
      clientByOps.set(b.id, existing.id);
    } else {
      const [c] = await db
        .insert(schema.clients)
        .values({ organizationId: orgId, name: b.name, opscoreBusinessPartnerId: b.id })
        .returning();
      clientByOps.set(b.id, c!.id);
    }
  }

  // 2) Employees → users + memberships (mapped role; never demote owner).
  const userByOps = new Map<string, string>();
  for (const e of emp.employees) {
    let [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.opscoreEmployeeId, e.id))
      .limit(1);
    if (!user && e.email) {
      [user] = await db.select().from(schema.users).where(eq(schema.users.email, e.email)).limit(1);
    }
    if (!user) {
      [user] = await db
        .insert(schema.users)
        .values({
          email: e.email || `${e.id}@opscore.local`,
          displayName: e.name,
          opscoreEmployeeId: e.id,
        })
        .returning();
    } else {
      await db
        .update(schema.users)
        .set({ opscoreEmployeeId: e.id, displayName: e.name })
        .where(eq(schema.users.id, user.id));
    }
    userByOps.set(e.id, user!.id);

    const role = mapOpsCoreRole(e.role);
    const [m] = await db
      .select({ role: schema.memberships.role, status: schema.memberships.status })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, user!.id)))
      .limit(1);
    if (!m) {
      await db.insert(schema.memberships).values({
        organizationId: orgId,
        userId: user!.id,
        role,
        status: 'active',
        joinedAt: new Date(),
      });
    } else if (m.role !== 'owner') {
      // present in OpsCore → keep role in sync + re-activate if it had been
      // disabled by a prior sync (employee re-added to the directory).
      const patch: { role?: string; status?: string } = {};
      if (m.role !== role) patch.role = role;
      if (m.status !== 'active' && m.status !== 'invited') patch.status = 'active';
      if (Object.keys(patch).length > 0) {
        await db
          .update(schema.memberships)
          .set(patch)
          .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, user!.id)));
      }
    }
  }

  // 2b) Disable OpsCore-managed members no longer present in the directory.
  // Only touches users linked to OpsCore (have an `opscore_employee_id`);
  // local/owner accounts are never auto-disabled.
  const presentOps = new Set(emp.employees.map((e) => e.id));
  const opsMembers = await db
    .select({
      userId: schema.memberships.userId,
      opsId: schema.users.opscoreEmployeeId,
      status: schema.memberships.status,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.organizationId, orgId), isNotNull(schema.users.opscoreEmployeeId)));
  let disabled = 0;
  for (const m of opsMembers) {
    if (m.opsId && !presentOps.has(m.opsId) && m.role !== 'owner' && m.status === 'active') {
      await db
        .update(schema.memberships)
        .set({ status: 'suspended' })
        .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, m.userId)));
      disabled += 1;
    }
  }

  // 3) Projects (+ client link) and project membership (reconciled from OpsCore).
  let assignments = 0;
  const projectByOps = new Map<string, string>(); // OpsCore project id → local uuid
  for (const p of proj.projects) {
    const clientId = p.business_partner_id ? clientByOps.get(p.business_partner_id) ?? null : null;
    const status = mapProjectStatus(p.status);
    let [project] = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(eq(schema.projects.organizationId, orgId), eq(schema.projects.opscoreProjectId, p.id)))
      .limit(1);
    if (!project) {
      // adopt an existing local project with the same name
      [project] = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(and(eq(schema.projects.organizationId, orgId), eq(schema.projects.name, p.name)))
        .limit(1);
    }
    if (!project) {
      [project] = await db
        .insert(schema.projects)
        .values({ organizationId: orgId, name: p.name, status, clientId, opscoreProjectId: p.id, createdBy })
        .returning({ id: schema.projects.id });
    } else {
      await db
        .update(schema.projects)
        .set({ name: p.name, status, clientId, opscoreProjectId: p.id })
        .where(eq(schema.projects.id, project.id));
    }
    projectByOps.set(p.id, project!.id);

    // reconcile members from OpsCore team list
    const memberUserIds = p.member_ids.map((mid) => userByOps.get(mid)).filter((x): x is string => !!x);
    await db.delete(schema.projectMembers).where(eq(schema.projectMembers.projectId, project!.id));
    for (const uid of memberUserIds) {
      await db
        .insert(schema.projectMembers)
        .values({ projectId: project!.id, userId: uid })
        .onConflictDoNothing();
      assignments += 1;
    }
  }

  // 4) Tasks (read-only mirror). CLOSED/deleted tasks vanish from the feed →
  // deactivate locally (keep the row so historical time entries stay valid).
  const presentTaskOps = new Set<string>();
  for (const t of tsk.tasks) {
    presentTaskOps.add(t.id);
    // Resolve the OpsCore project id → local uuid; unknown/absent → null
    // ("No project" bucket), so assigned work is never silently dropped.
    const projectId = t.project_id ? projectByOps.get(t.project_id) ?? null : null;
    const values = {
      name: t.name,
      status: t.status,
      priority: t.priority,
      projectId,
      assignedOpscoreEmployeeId: t.assigned_employee_id,
      collaboratorOpscoreEmployeeIds: t.collaborator_ids ?? [],
      active: true,
      opscoreUpdatedAt: new Date(t.updated_at),
    };
    const [existing] = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.organizationId, orgId), eq(schema.tasks.opscoreTaskId, t.id)))
      .limit(1);
    if (existing) {
      await db.update(schema.tasks).set(values).where(eq(schema.tasks.id, existing.id));
    } else {
      await db.insert(schema.tasks).values({ organizationId: orgId, opscoreTaskId: t.id, ...values });
    }
  }
  // Deactivate any local task no longer in the feed (closed/deleted upstream).
  let tasksDisabled = 0;
  const localTasks = await db
    .select({ id: schema.tasks.id, opsId: schema.tasks.opscoreTaskId, active: schema.tasks.active })
    .from(schema.tasks)
    .where(eq(schema.tasks.organizationId, orgId));
  for (const lt of localTasks) {
    if (!presentTaskOps.has(lt.opsId) && lt.active) {
      await db.update(schema.tasks).set({ active: false }).where(eq(schema.tasks.id, lt.id));
      tasksDisabled += 1;
    }
  }

  return {
    users: emp.employees.length,
    clients: bp.business_partners.length,
    projects: proj.projects.length,
    assignments,
    disabled,
    tasks: tsk.tasks.length,
    tasksDisabled,
  };
}

/**
 * Scheduled directory sync (server.ts). OpsCore serves read-only feeds and never
 * pushes, so without this a newly-assigned task/project/employee only reaches
 * TimePro when an admin manually POSTs the sync. Runs against the configured
 * OpsCore org (slug `OPSCORE_ORG_SLUG`); a no-op when OpsCore isn't configured.
 * Returns null if there's nothing to sync (unconfigured / org or creator absent).
 */
export async function runScheduledOpscoreSync(): Promise<
  { orgId: string; result: OpscoreSyncResult } | null
> {
  const cfg = loadConfig();
  if (!cfg.OPSCORE_API_URL || !cfg.OPSCORE_API_KEY) return null;
  const db = getDb();

  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, cfg.OPSCORE_ORG_SLUG))
    .limit(1);
  if (!org) return null;

  // A creator for any newly-inserted project: prefer an owner/admin, else any member.
  const [creator] = await db
    .select({ userId: schema.memberships.userId, role: schema.memberships.role })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, org.id),
        inArray(schema.memberships.role, ['owner', 'admin']),
      ),
    )
    .limit(1);
  const creatorId =
    creator?.userId ??
    (
      await db
        .select({ userId: schema.memberships.userId })
        .from(schema.memberships)
        .where(eq(schema.memberships.organizationId, org.id))
        .limit(1)
    )[0]?.userId;
  if (!creatorId) return null;

  const result = await syncOrgFromOpsCore(org.id, creatorId);
  return { orgId: org.id, result };
}
