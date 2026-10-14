import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import {
  forbid,
  isAdmin,
  reportingSubtree,
  requesterRole,
  seesOthers,
  visibleUsers,
} from '../lib/access';
import { recordAudit } from '../lib/audit';

const Person = z.object({ user_id: z.string(), display_name: z.string() });

const MemberVisibility = z.object({
  // OpsCore reporting manager (read-only here; edited in OpsCore).
  reports_to: Person.nullable(),
  // Everyone below this member in the reporting chain — visible automatically.
  subordinate_count: z.number(),
  // Members an admin granted this member view access to, beyond the chain.
  grants: z.array(Person),
});

const notFound = () =>
  Object.assign(new Error('Member not found'), { statusCode: 404, code: 'not_found' });

/**
 * Activity visibility (hierarchy + admin view grants).
 *
 * Who-can-see-whom is resolved in `lib/access.ts`; these endpoints let the web
 * app learn the requester's scope and let admins manage per-member view grants.
 */
export const visibilityRoutes: FastifyPluginAsyncZod = async (app) => {
  /** What the requester can see/do — drives which home and nav the web shows. */
  app.get(
    '/me/access',
    {
      preHandler: [requireAuth],
      schema: {
        response: {
          200: z.object({
            role: z.string(),
            // Can view at least one member besides themselves (team view).
            can_view_others: z.boolean(),
            // Owner/admin/manager — team management surfaces (Team page).
            can_manage_team: z.boolean(),
          }),
        },
        tags: ['me'],
      },
    },
    async (req) => {
      const visible = await visibleUsers(req);
      return {
        role: visible.role,
        can_view_others: seesOthers(visible, req.userId!),
        can_manage_team: isAdmin(visible.role) || visible.role === 'manager',
      };
    },
  );

  /** A member's reporting line + granted view access (admin only). */
  app.get(
    '/team/members/:userId/visibility',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        response: { 200: MemberVisibility },
        tags: ['team'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can manage visibility');
      const orgId = req.organizationId!;
      const target = req.params.userId;

      return req.withTenantDb(async (tx) => {
        const [member] = await tx
          .select({ reportsTo: schema.memberships.reportsToUserId })
          .from(schema.memberships)
          .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, target)))
          .limit(1);
        if (!member) throw notFound();

        let reportsTo: z.infer<typeof Person> | null = null;
        if (member.reportsTo) {
          const [u] = await tx
            .select({ id: schema.users.id, name: schema.users.displayName })
            .from(schema.users)
            .where(eq(schema.users.id, member.reportsTo))
            .limit(1);
          if (u) reportsTo = { user_id: u.id, display_name: u.name };
        }

        const grants = await tx
          .select({ id: schema.users.id, name: schema.users.displayName })
          .from(schema.activityViewGrants)
          .innerJoin(schema.users, eq(schema.users.id, schema.activityViewGrants.subjectUserId))
          .where(
            and(
              eq(schema.activityViewGrants.organizationId, orgId),
              eq(schema.activityViewGrants.viewerUserId, target),
            ),
          )
          .orderBy(asc(schema.users.displayName));

        return {
          reports_to: reportsTo,
          subordinate_count: (await reportingSubtree(tx, orgId, target)).length,
          grants: grants.map((g) => ({ user_id: g.id, display_name: g.name })),
        };
      });
    },
  );

  /** Replace the set of members this member may view (admin only, audited). */
  app.put(
    '/team/members/:userId/visibility',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        body: z.object({ subject_user_ids: z.array(z.string().uuid()).max(1000) }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['team'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can manage visibility');
      const orgId = req.organizationId!;
      const viewer = req.params.userId;
      // Viewing yourself is implicit — never stored as a grant.
      const wanted = [...new Set(req.body.subject_user_ids)].filter((id) => id !== viewer);

      return req.withTenantDb(async (tx) => {
        const memberIds = await tx
          .select({ userId: schema.memberships.userId })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.organizationId, orgId),
              inArray(schema.memberships.userId, [viewer, ...wanted]),
            ),
          );
        const inOrg = new Set(memberIds.map((m) => m.userId));
        if (!inOrg.has(viewer)) throw notFound();
        const outsiders = wanted.filter((id) => !inOrg.has(id));
        if (outsiders.length > 0) {
          throw Object.assign(new Error('Some selected users are not members of this organization'), {
            statusCode: 400,
            code: 'invalid_subjects',
          });
        }

        const existing = await tx
          .select({ subject: schema.activityViewGrants.subjectUserId })
          .from(schema.activityViewGrants)
          .where(
            and(
              eq(schema.activityViewGrants.organizationId, orgId),
              eq(schema.activityViewGrants.viewerUserId, viewer),
            ),
          );
        const before = new Set(existing.map((e) => e.subject));
        const after = new Set(wanted);
        const added = wanted.filter((id) => !before.has(id));
        const removed = [...before].filter((id) => !after.has(id));
        if (added.length === 0 && removed.length === 0) return { ok: true };

        if (removed.length > 0) {
          await tx
            .delete(schema.activityViewGrants)
            .where(
              and(
                eq(schema.activityViewGrants.organizationId, orgId),
                eq(schema.activityViewGrants.viewerUserId, viewer),
                inArray(schema.activityViewGrants.subjectUserId, removed),
              ),
            );
        }
        if (added.length > 0) {
          await tx.insert(schema.activityViewGrants).values(
            added.map((subjectUserId) => ({
              organizationId: orgId,
              viewerUserId: viewer,
              subjectUserId,
              grantedByUserId: req.userId!,
            })),
          );
        }
        await recordAudit(tx, {
          organizationId: orgId,
          actorUserId: req.userId!,
          action: 'activity_view_grant.update',
          targetType: 'user',
          targetId: viewer,
          metadata: { added, removed },
        });
        return { ok: true };
      });
    },
  );
};
