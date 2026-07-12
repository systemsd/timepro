import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';

const TaskRow = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.string(),
  priority: z.string(),
  project_id: z.string().uuid().nullable(),
});

const TasksResponse = z.object({ tasks: z.array(TaskRow) });

/**
 * Tasks mirrored read-only from OpsCore, scoped to the signed-in resource:
 * a user sees a task only when their OpsCore employee id (the handoff `sub`,
 * stored as `users.opscore_employee_id`) is the assignee OR a collaborator.
 *
 * The desktop picker calls this per selected project:
 *   `project_id=<uuid>` → that project's visible tasks
 *   `project_id=none`   → the "No project" bucket (project_id IS NULL)
 *   (omitted)           → all visible tasks
 */
export const taskRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/tasks',
    {
      preHandler: [requireAuth],
      schema: {
        querystring: z.object({
          project_id: z.union([z.string().uuid(), z.literal('none')]).optional(),
        }),
        response: { 200: TasksResponse },
        tags: ['tasks'],
      },
    },
    async (req) => {
      return req.withTenantDb(async (tx) => {
        const [me] = await tx
          .select({ opsId: schema.users.opscoreEmployeeId })
          .from(schema.users)
          .where(eq(schema.users.id, req.userId!))
          .limit(1);
        // Non-OpsCore users have no directory identity → no synced tasks.
        if (!me?.opsId) return { tasks: [] };

        const conds = [
          eq(schema.tasks.organizationId, req.organizationId!),
          eq(schema.tasks.active, true),
          // Completed work isn't offered for new tracking (CLOSED is already
          // dropped upstream by OpsCore; DONE we hide here). Historical entries
          // that reference a now-DONE task stay valid — this only filters the picker.
          ne(schema.tasks.status, 'DONE'),
          or(
            eq(schema.tasks.assignedOpscoreEmployeeId, me.opsId),
            sql`${me.opsId} = ANY(${schema.tasks.collaboratorOpscoreEmployeeIds})`,
          ),
        ];
        if (req.query.project_id === 'none') conds.push(isNull(schema.tasks.projectId));
        else if (req.query.project_id) conds.push(eq(schema.tasks.projectId, req.query.project_id));

        const rows = await tx
          .select({
            id: schema.tasks.id,
            name: schema.tasks.name,
            status: schema.tasks.status,
            priority: schema.tasks.priority,
            projectId: schema.tasks.projectId,
          })
          .from(schema.tasks)
          .where(and(...conds))
          .orderBy(asc(schema.tasks.name));

        return {
          tasks: rows.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            priority: r.priority,
            project_id: r.projectId ?? null,
          })),
        };
      });
    },
  );
};
