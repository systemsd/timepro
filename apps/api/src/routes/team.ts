import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';

const MEMBER_SETTINGS_DEFAULTS = {
  screenshots: '3/hr, allow blur',
  activity_level_tracking: 'Track',
  app_url_tracking: 'Track',
  weekly_time_limit: '40 hours',
  auto_pause_after: '1 minutes',
  allow_offline_time: 'Disallow',
  notify_on_screenshot: 'Do not notify',
};

const MemberRow = z.object({
  user_id: z.string(),
  display_name: z.string(),
  email: z.string(),
  role: z.string(),
  status: z.string(),
  is_owner: z.boolean(),
});

const MemberDetail = MemberRow.extend({
  projects: z.array(
    z.object({ id: z.string(), name: z.string(), color: z.string(), enabled: z.boolean() }),
  ),
  effective_settings: z.object({
    screenshots: z.string(),
    activity_level_tracking: z.string(),
    app_url_tracking: z.string(),
    weekly_time_limit: z.string(),
    auto_pause_after: z.string(),
    allow_offline_time: z.string(),
    notify_on_screenshot: z.string(),
  }),
});

/** Look up the requesting user's role within their org. */
async function requesterRole(req: FastifyRequest): Promise<string> {
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

function forbid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 403, code: 'forbidden' });
}

export const teamRoutes: FastifyPluginAsyncZod = async (app) => {
  // List all members of the org.
  app.get(
    '/team/members',
    {
      preHandler: [requireAuth],
      schema: { response: { 200: z.object({ members: z.array(MemberRow) }) }, tags: ['team'] },
    },
    async (req) => {
      const role = await requesterRole(req);
      if (!['owner', 'admin', 'manager'].includes(role)) forbid('Not allowed to view the team');

      return req.withTenantDb(async (tx) => {
        const rows = await tx
          .select({
            userId: schema.users.id,
            displayName: schema.users.displayName,
            email: schema.users.email,
            role: schema.memberships.role,
            status: schema.memberships.status,
            createdAt: schema.memberships.createdAt,
          })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(eq(schema.memberships.organizationId, req.organizationId!))
          .orderBy(asc(schema.memberships.createdAt));

        return {
          members: rows.map((r) => ({
            user_id: r.userId,
            display_name: r.displayName,
            email: r.email,
            role: r.role,
            status: r.status,
            is_owner: r.role === 'owner',
          })),
        };
      });
    },
  );

  // Member detail: role, project assignments, effective settings.
  app.get(
    '/team/members/:userId',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        response: { 200: MemberDetail },
        tags: ['team'],
      },
    },
    async (req) => {
      const role = await requesterRole(req);
      if (!['owner', 'admin', 'manager'].includes(role)) forbid('Not allowed to view the team');

      return req.withTenantDb(async (tx) => {
        const [member] = await tx
          .select({
            userId: schema.users.id,
            displayName: schema.users.displayName,
            email: schema.users.email,
            role: schema.memberships.role,
            status: schema.memberships.status,
            weeklyHourLimit: schema.memberships.weeklyHourLimit,
          })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(
            and(
              eq(schema.memberships.organizationId, req.organizationId!),
              eq(schema.memberships.userId, req.params.userId),
            ),
          )
          .limit(1);

        if (!member) {
          throw Object.assign(new Error('Member not found'), {
            statusCode: 404,
            code: 'not_found',
          });
        }

        const projects = await tx
          .select({
            id: schema.projects.id,
            name: schema.projects.name,
            color: schema.projects.color,
          })
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.organizationId, req.organizationId!),
              eq(schema.projects.status, 'active'),
            ),
          )
          .orderBy(asc(schema.projects.name));

        const assigned = await tx
          .select({ projectId: schema.projectMembers.projectId })
          .from(schema.projectMembers)
          .where(eq(schema.projectMembers.userId, req.params.userId));
        const assignedSet = new Set(assigned.map((a) => a.projectId));

        return {
          user_id: member.userId,
          display_name: member.displayName,
          email: member.email,
          role: member.role,
          status: member.status,
          is_owner: member.role === 'owner',
          projects: projects.map((p) => ({
            id: p.id,
            name: p.name,
            color: p.color,
            enabled: assignedSet.has(p.id),
          })),
          effective_settings: {
            ...MEMBER_SETTINGS_DEFAULTS,
            weekly_time_limit: member.weeklyHourLimit
              ? `${member.weeklyHourLimit} hours`
              : MEMBER_SETTINGS_DEFAULTS.weekly_time_limit,
          },
        };
      });
    },
  );

  // Update role and/or status (pause / archive / activate).
  app.patch(
    '/team/members/:userId',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        body: z.object({
          role: z.enum(['owner', 'admin', 'manager', 'employee']).optional(),
          status: z.enum(['active', 'suspended', 'archived']).optional(),
        }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['team'],
      },
    },
    async (req) => {
      const role = await requesterRole(req);
      if (!['owner', 'admin'].includes(role)) forbid('Only owners and admins can edit members');

      return req.withTenantDb(async (tx) => {
        // Don't let anyone demote/alter the owner via this path.
        const [target] = await tx
          .select({ role: schema.memberships.role })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.organizationId, req.organizationId!),
              eq(schema.memberships.userId, req.params.userId),
            ),
          )
          .limit(1);
        if (!target) {
          throw Object.assign(new Error('Member not found'), { statusCode: 404, code: 'not_found' });
        }
        if (target.role === 'owner') forbid('The owner cannot be modified here');

        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (req.body.role) patch.role = req.body.role;
        if (req.body.status) patch.status = req.body.status;

        await tx
          .update(schema.memberships)
          .set(patch)
          .where(
            and(
              eq(schema.memberships.organizationId, req.organizationId!),
              eq(schema.memberships.userId, req.params.userId),
            ),
          );
        return { ok: true };
      });
    },
  );

  // Set project assignments for a member.
  app.put(
    '/team/members/:userId/projects',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        body: z.object({
          assignments: z.array(
            z.object({ project_id: z.string().uuid(), enabled: z.boolean() }),
          ),
        }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['team'],
      },
    },
    async (req) => {
      const role = await requesterRole(req);
      if (!['owner', 'admin'].includes(role)) forbid('Only owners and admins can edit assignments');

      return req.withTenantDb(async (tx) => {
        const toEnable = req.body.assignments.filter((a) => a.enabled).map((a) => a.project_id);
        const toDisable = req.body.assignments.filter((a) => !a.enabled).map((a) => a.project_id);

        for (const projectId of toEnable) {
          await tx
            .insert(schema.projectMembers)
            .values({ projectId, userId: req.params.userId })
            .onConflictDoNothing();
        }
        if (toDisable.length > 0) {
          await tx
            .delete(schema.projectMembers)
            .where(
              and(
                eq(schema.projectMembers.userId, req.params.userId),
                inArray(schema.projectMembers.projectId, toDisable),
              ),
            );
        }
        return { ok: true };
      });
    },
  );

  // Invite a new employee by email (creates a pending membership).
  app.post(
    '/team/invite',
    {
      preHandler: [requireAuth],
      schema: {
        body: z.object({
          email: z.string().email(),
          role: z.enum(['admin', 'manager', 'employee']).default('employee'),
        }),
        response: { 200: z.object({ user_id: z.string(), status: z.string() }) },
        tags: ['team'],
      },
    },
    async (req) => {
      const role = await requesterRole(req);
      if (!['owner', 'admin'].includes(role)) forbid('Only owners and admins can invite');

      // User lookup is org-independent, so use the platform DB handle.
      const { getDb } = await import('@timepro/db');
      const db = getDb();
      let [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, req.body.email))
        .limit(1);

      if (!user) {
        [user] = await db
          .insert(schema.users)
          .values({
            email: req.body.email,
            displayName: req.body.email.split('@')[0]!,
          })
          .returning();
      }

      await req.withTenantDb(async (tx) => {
        await tx
          .insert(schema.memberships)
          .values({
            organizationId: req.organizationId!,
            userId: user!.id,
            role: req.body.role,
            status: 'invited',
            invitedAt: new Date(),
          })
          .onConflictDoNothing();
      });

      return { user_id: user!.id, status: 'invited' };
    },
  );

  // Remove a member from the org.
  app.delete(
    '/team/members/:userId',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['team'],
      },
    },
    async (req) => {
      const role = await requesterRole(req);
      if (!['owner', 'admin'].includes(role)) forbid('Only owners and admins can remove members');
      if (req.params.userId === req.userId) forbid('You cannot remove yourself');

      return req.withTenantDb(async (tx) => {
        const [target] = await tx
          .select({ role: schema.memberships.role })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.organizationId, req.organizationId!),
              eq(schema.memberships.userId, req.params.userId),
            ),
          )
          .limit(1);
        if (!target) {
          throw Object.assign(new Error('Member not found'), { statusCode: 404, code: 'not_found' });
        }
        if (target.role === 'owner') forbid('The owner cannot be removed');

        // Clean the user's project assignments within this org's projects.
        const orgProjects = await tx
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(eq(schema.projects.organizationId, req.organizationId!));
        const ids = orgProjects.map((p) => p.id);
        if (ids.length > 0) {
          await tx
            .delete(schema.projectMembers)
            .where(
              and(
                eq(schema.projectMembers.userId, req.params.userId),
                inArray(schema.projectMembers.projectId, ids),
              ),
            );
        }

        await tx
          .delete(schema.memberships)
          .where(
            and(
              eq(schema.memberships.organizationId, req.organizationId!),
              eq(schema.memberships.userId, req.params.userId),
            ),
          );
        return { ok: true };
      });
    },
  );
};
