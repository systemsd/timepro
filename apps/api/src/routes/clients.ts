import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { forbid, isAdmin, requesterRole } from '../lib/access';

/**
 * Clients (= OpsCore "business partners"). Phase-0 interim allows local
 * create; once OpsCore sync lands the catalog becomes read-only (C2) and the
 * project↔client mapping syncs from OpsCore (C3).
 */
const ClientRow = z.object({
  id: z.string(),
  name: z.string(),
  project_count: z.number(),
});

export const clientRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/clients',
    {
      preHandler: [requireAuth],
      schema: { response: { 200: z.object({ clients: z.array(ClientRow) }) }, tags: ['clients'] },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can view clients');
      return req.withTenantDb(async (tx) => {
        const rows = await tx
          .select({
            id: schema.clients.id,
            name: schema.clients.name,
            count: sql<number>`count(${schema.projects.id})::int`,
          })
          .from(schema.clients)
          .leftJoin(schema.projects, eq(schema.projects.clientId, schema.clients.id))
          .where(
            and(
              eq(schema.clients.organizationId, req.organizationId!),
              isNull(schema.clients.deletedAt),
            ),
          )
          .groupBy(schema.clients.id)
          .orderBy(asc(schema.clients.name));

        return {
          clients: rows.map((r) => ({ id: r.id, name: r.name, project_count: r.count ?? 0 })),
        };
      });
    },
  );

  // Interim local create (removed once OpsCore is the source of truth).
  app.post(
    '/clients',
    {
      preHandler: [requireAuth],
      schema: {
        body: z.object({ name: z.string().min(1).max(120) }),
        response: { 200: z.object({ id: z.string(), name: z.string() }) },
        tags: ['clients'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can create clients');
      return req.withTenantDb(async (tx) => {
        const [c] = await tx
          .insert(schema.clients)
          .values({ organizationId: req.organizationId!, name: req.body.name.trim() })
          .returning();
        return { id: c!.id, name: c!.name };
      });
    },
  );
};
