import type { FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@timepro/db';

/** The set of users a requester may view. 'all' for owner/admin (avoids huge IN lists). */
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

/**
 * Which users this requester can see (C1):
 *   owner/admin → all org members ('all')
 *   manager     → members of teams they manage, plus self
 *   employee    → self only
 */
export async function visibleUsers(req: FastifyRequest): Promise<VisibleUsers> {
  const role = await requesterRole(req);
  if (role === 'owner' || role === 'admin') return { role, userIds: 'all' };
  if (role === 'manager') {
    const ids = await req.withTenantDb(async (tx) => {
      const managed = await tx
        .select({ id: schema.teams.id })
        .from(schema.teams)
        .where(
          and(
            eq(schema.teams.organizationId, req.organizationId!),
            eq(schema.teams.managerUserId, req.userId!),
          ),
        );
      const teamIds = managed.map((t) => t.id);
      const set = new Set<string>([req.userId!]);
      if (teamIds.length > 0) {
        const members = await tx
          .select({ userId: schema.teamMembers.userId })
          .from(schema.teamMembers)
          .where(inArray(schema.teamMembers.teamId, teamIds));
        members.forEach((m) => set.add(m.userId));
      }
      return Array.from(set);
    });
    return { role, userIds: ids };
  }
  return { role, userIds: [req.userId!] };
}

/** True if the requester may view the given user. */
export function canView(v: VisibleUsers, userId: string): boolean {
  return v.userIds === 'all' || v.userIds.includes(userId);
}

/** Roles allowed to manage team/projects/settings. Owner = super-admin. */
export function isAdmin(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/** Throw a 403. */
export function forbid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 403, code: 'forbidden' });
}
