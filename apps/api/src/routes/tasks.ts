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
  product_id: z.string().uuid().nullable(),
});

const TasksResponse = z.object({ tasks: z.array(TaskRow) });

/**
 * Tasks mirrored read-only from OpsCore, scoped to the signed-in resource:
 * a user sees a task only when their OpsCore employee id (the handoff `sub`,
 * stored as `users.opscore_employee_id`) is the assignee OR a collaborator.
 *
 * The desktop picker calls this per selected tracking context:
 *   `project_id=<uuid>` → that project's visible tasks
 *   `product_id=<uuid>` → that internal product's visible tasks
 *   `project_id=none`   → the unattached bucket (NEITHER a project NOR a product)
 *   (omitted)           → all visible tasks
 *
 * ⚠️ `project_id=none` means *unattached*, not merely "no project". Internal-
 * product tasks have `project_id IS NULL` too, so without the product exclusion
 * they'd appear both under "No project" and under their product — and picking
 * them from the "No project" entry would silently track them with no attribution
 * at all. The product's own entry is the only place they're offered.
 */
export const taskRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/tasks',
    {
      preHandler: [requireAuth],
      schema: {
        querystring: z.object({
          project_id: z.union([z.string().uuid(), z.literal('none')]).optional(),
          product_id: z.string().uuid().optional(),
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
        // A product filter wins if both are sent (they're mutually exclusive
        // upstream, so this only ever resolves a confused client).
        if (req.query.product_id) {
          conds.push(eq(schema.tasks.productId, req.query.product_id));
        } else if (req.query.project_id === 'none') {
          conds.push(isNull(schema.tasks.projectId), isNull(schema.tasks.productId));
        } else if (req.query.project_id) {
          conds.push(eq(schema.tasks.projectId, req.query.project_id));
        }

        const rows = await tx
          .select({
            id: schema.tasks.id,
            name: schema.tasks.name,
            status: schema.tasks.status,
            priority: schema.tasks.priority,
            projectId: schema.tasks.projectId,
            productId: schema.tasks.productId,
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
            product_id: r.productId ?? null,
          })),
        };
      });
    },
  );
};
