import type { FastifyRequest } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type DB } from '@timepro/db';

/** A set of users the requester may act on. 'all' for owner/admin (avoids huge IN lists). */
export type VisibleUsers = { role: string; userIds: string[] | 'all' };

/** Resolve the requester's role within their org. */
export async function requesterRole(req: FastifyRequest): Promise<string> {
  return req.withTenantDb(async (tx) => {
    const [m] = await tx
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.organizationId, req.organizationId!),
          eq(schema.memberships.userId, req.userId!),
        ),
      )
      .limit(1);
    return m?.role ?? 'employee';
  });
}

/** Self plus the members of every team the user manages. */
async function managedTeamScope(tx: DB, orgId: string, userId: string): Promise<Set<string>> {
  const managed = await tx
    .select({ id: schema.teams.id })
    .from(schema.teams)
    .where(and(eq(schema.teams.organizationId, orgId), eq(schema.teams.managerUserId, userId)));
  const set = new Set<string>([userId]);
  const teamIds = managed.map((t) => t.id);
  if (teamIds.length > 0) {
    const members = await tx
      .select({ userId: schema.teamMembers.userId })
      .from(schema.teamMembers)
      .where(inArray(schema.teamMembers.teamId, teamIds));
    members.forEach((m) => set.add(m.userId));
  }
  return set;
}

/**
 * Everyone below `userId` in the OpsCore reporting chain (direct reports, their
 * reports, …), excluding `userId`. Mirrors OpsCore's `getReportingSubtreeIds`.
 * UNION (not UNION ALL) de-duplicates each level, so a cycle introduced upstream
 * terminates instead of recursing forever.
 */
export async function reportingSubtree(tx: DB, orgId: string, userId: string): Promise<string[]> {
  const res = await tx.execute(sql`
    WITH RECURSIVE below(user_id) AS (
      SELECT m.user_id FROM memberships m
      WHERE m.organization_id = ${orgId} AND m.reports_to_user_id = ${userId}
      UNION
      SELECT m.user_id FROM memberships m
      JOIN below b ON m.reports_to_user_id = b.user_id
      WHERE m.organization_id = ${orgId}
    )
    SELECT user_id FROM below WHERE user_id <> ${userId}
  `);
  return (res as unknown as { rows: { user_id: string }[] }).rows.map((r) => r.user_id);
}

/** Members an admin has explicitly granted `viewerId` view access to. */
export async function grantedSubjects(tx: DB, orgId: string, viewerId: string): Promise<string[]> {
  const rows = await tx
    .select({ subject: schema.activityViewGrants.subjectUserId })
    .from(schema.activityViewGrants)
    .where(
      and(
        eq(schema.activityViewGrants.organizationId, orgId),
        eq(schema.activityViewGrants.viewerUserId, viewerId),
      ),
    );
  return rows.map((r) => r.subject);
}

/**
 * Whose data the requester may CHANGE (edit/split/delete time, delete screenshots):
 *   owner/admin → all org members ('all')
 *   manager     → members of teams they manage, plus self
 *   employee    → self only (further gated by the self-service settings)
 * Deliberately excludes the reporting chain and view grants — those are read-only.
 */
export async function manageableUsers(req: FastifyRequest): Promise<VisibleUsers> {
  const role = await requesterRole(req);
  if (role === 'owner' || role === 'admin') return { role, userIds: 'all' };
  if (role === 'manager') {
    const set = await req.withTenantDb((tx) => managedTeamScope(tx, req.organizationId!, req.userId!));
    return { role, userIds: Array.from(set) };
  }
  return { role, userIds: [req.userId!] };
}

/**
 * Whose activity a member may VIEW (C1 + hierarchy):
 *   owner/admin → all org members ('all')
 *   otherwise   → self, members of teams they manage (managers), everyone below
 *                 them in the OpsCore reporting chain, and members an admin has
 *                 granted them view access to.
 * Reads only; writes go through `manageableUsers`. Takes a raw tenant tx so
 * non-request callers (the realtime socket) resolve the same scope.
 */
export async function resolveVisibleUserIds(
  tx: DB,
  orgId: string,
  userId: string,
  role: string,
): Promise<string[] | 'all'> {
  if (isAdmin(role)) return 'all';
  const set = role === 'manager' ? await managedTeamScope(tx, orgId, userId) : new Set<string>([userId]);
  for (const id of await reportingSubtree(tx, orgId, userId)) set.add(id);
  for (const id of await grantedSubjects(tx, orgId, userId)) set.add(id);
  return Array.from(set);
}

/** `resolveVisibleUserIds` for the current request. */
export async function visibleUsers(req: FastifyRequest): Promise<VisibleUsers> {
  const role = await requesterRole(req);
  const userIds = await req.withTenantDb((tx) =>
    resolveVisibleUserIds(tx, req.organizationId!, req.userId!, role),
  );
  return { role, userIds };
}

/** True if the set includes the given user. */
export function canView(v: VisibleUsers, userId: string): boolean {
  return v.userIds === 'all' || v.userIds.includes(userId);
}

/** True when the set reaches beyond the requester themselves. */
export function seesOthers(v: VisibleUsers, selfId: string): boolean {
  return v.userIds === 'all' || v.userIds.some((id) => id !== selfId);
}

/** Roles allowed to manage team/projects/settings. Owner = super-admin. */
export function isAdmin(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/** Throw a 403. */
export function forbid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 403, code: 'forbidden' });
}
