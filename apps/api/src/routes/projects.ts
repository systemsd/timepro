import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { forbid, isAdmin, requesterRole } from '../lib/access';

const ProjectRow = z.object({
  id: z.string().uuid(),
  name: z.string(),
  color: z.string(),
  status: z.string(),
  is_billable: z.boolean(),
});

const ProjectsResponse = z.object({
  projects: z.array(ProjectRow),
});

export const projectRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/projects',
    {
      preHandler: [requireAuth],
      schema: {
        response: { 200: ProjectsResponse },
        tags: ['projects'],
      },
    },
    async (req) => {
      return req.withTenantDb(async (tx) => {
        // Only projects the logged-in user is assigned to (project_members) —
        // this is the tracking picker, so you can only track projects you're on.
        const rows = await tx
          .select({
            id: schema.projects.id,
            name: schema.projects.name,
            color: schema.projects.color,
            status: schema.projects.status,
            isBillable: schema.projects.isBillable,
          })
          .from(schema.projects)
          .innerJoin(
            schema.projectMembers,
            and(
              eq(schema.projectMembers.projectId, schema.projects.id),
              eq(schema.projectMembers.userId, req.userId!),
            ),
          )
          .where(
            and(
              eq(schema.projects.organizationId, req.organizationId!),
              eq(schema.projects.status, 'active'),
            ),
          )
          .orderBy(asc(schema.projects.name));

        return {
          projects: rows.map((r) => ({
            id: r.id,
            name: r.name,
            color: r.color,
            status: r.status,
            is_billable: r.isBillable,
          })),
        };
      });
    },
  );

  // --- Projects management page (admin/owner) ---

  // List projects with assigned-member counts + total active members.
  app.get(
    '/projects/manage',
    {
      preHandler: [requireAuth],
      schema: {
        response: {
          200: z.object({
            total_members: z.number(),
            projects: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                color: z.string(),
                status: z.string(),
                member_count: z.number(),
              }),
            ),
          }),
        },
        tags: ['projects'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can manage projects');
      return req.withTenantDb(async (tx) => {
        const rows = await tx
          .select({
            id: schema.projects.id,
            name: schema.projects.name,
            color: schema.projects.color,
            status: schema.projects.status,
            count: sql<number>`count(${schema.projectMembers.userId})::int`,
          })
          .from(schema.projects)
          .leftJoin(schema.projectMembers, eq(schema.projectMembers.projectId, schema.projects.id))
          .where(
            and(
              eq(schema.projects.organizationId, req.organizationId!),
              eq(schema.projects.status, 'active'),
            ),
          )
          .groupBy(schema.projects.id)
          .orderBy(asc(schema.projects.name));

        const totals = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.organizationId, req.organizationId!),
              eq(schema.memberships.status, 'active'),
            ),
          );

        return {
          total_members: totals[0]?.total ?? 0,
          projects: rows.map((r) => ({
            id: r.id,
            name: r.name,
            color: r.color,
            status: r.status,
            member_count: r.count ?? 0,
          })),
        };
      });
    },
  );

  // Members of a project: every active employee + whether assigned.
  app.get(
    '/projects/:id/members',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            members: z.array(
              z.object({ user_id: z.string(), display_name: z.string(), enabled: z.boolean() }),
            ),
          }),
        },
        tags: ['projects'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can manage projects');
      return req.withTenantDb(async (tx) => {
        const employees = await tx
          .select({ userId: schema.users.id, displayName: schema.users.displayName })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(
            and(
              eq(schema.memberships.organizationId, req.organizationId!),
              eq(schema.memberships.status, 'active'),
            ),
          )
          .orderBy(asc(schema.users.displayName));

        const assigned = await tx
          .select({ userId: schema.projectMembers.userId })
          .from(schema.projectMembers)
          .where(eq(schema.projectMembers.projectId, req.params.id));
        const set = new Set(assigned.map((a) => a.userId));

        return {
          members: employees.map((e) => ({
            user_id: e.userId,
            display_name: e.displayName,
            enabled: set.has(e.userId),
          })),
        };
      });
    },
  );

  // Set project assignments.
  app.put(
    '/projects/:id/members',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          assignments: z.array(z.object({ user_id: z.string().uuid(), enabled: z.boolean() })),
        }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['projects'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can manage projects');
      return req.withTenantDb(async (tx) => {
        const enable = req.body.assignments.filter((a) => a.enabled).map((a) => a.user_id);
        const disable = req.body.assignments.filter((a) => !a.enabled).map((a) => a.user_id);
        for (const userId of enable) {
          await tx
            .insert(schema.projectMembers)
            .values({ projectId: req.params.id, userId })
            .onConflictDoNothing();
        }
        if (disable.length > 0) {
          await tx
            .delete(schema.projectMembers)
            .where(
              and(
                eq(schema.projectMembers.projectId, req.params.id),
                inArray(schema.projectMembers.userId, disable),
              ),
            );
        }
        return { ok: true };
      });
    },
  );
};
