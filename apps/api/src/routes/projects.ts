import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';

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
        const rows = await tx
          .select({
            id: schema.projects.id,
            name: schema.projects.name,
            color: schema.projects.color,
            status: schema.projects.status,
            isBillable: schema.projects.isBillable,
          })
          .from(schema.projects)
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
};
