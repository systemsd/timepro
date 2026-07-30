import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, ne } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { canView, forbid, visibleUsers } from '../lib/access';

const ProductRow = z.object({
  id: z.string().uuid(),
  name: z.string(),
  color: z.string(),
  stage: z.string(),
  // Always false: internal-product time is never billable. Returned so the
  // shape mirrors `/v1/projects` and clients don't special-case the two lists.
  is_billable: z.boolean(),
});

const ProductsResponse = z.object({
  products: z.array(ProductRow),
});

/**
 * Internal Products the caller may track against — the peer of `/v1/projects`
 * (same member-scoped shape), not a nested resource under it.
 *
 * Deliberately additive: `/v1/projects` is untouched, so an agent that predates
 * products keeps working and simply never calls this.
 */
export const productRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/products',
    {
      preHandler: [requireAuth],
      schema: {
        // Optional `userId` lists another user's trackable products, mirroring
        // `/v1/projects`. Defaults to self; requires view access.
        querystring: z.object({ userId: z.string().uuid().optional() }),
        response: { 200: ProductsResponse },
        tags: ['products'],
      },
    },
    async (req) => {
      let targetUserId = req.userId!;
      if (req.query.userId && req.query.userId !== req.userId) {
        const visible = await visibleUsers(req);
        if (!canView(visible, req.query.userId)) forbid('Not allowed to view this user’s products');
        targetUserId = req.query.userId;
      }
      return req.withTenantDb(async (tx) => {
        // Only products the target user is a member of (owner ∪ ProductMember,
        // reconciled by the OpsCore sync) — this is the tracking picker.
        //
        // The picker filter lives here, not in the mirror: ARCHIVED products and
        // products that vanished from the feed (`active=false`) are not offered
        // for NEW tracking, while their rows stay so existing time still resolves
        // a name. Every other stage (incl. PAUSED/SUNSET) is shown.
        const rows = await tx
          .select({
            id: schema.products.id,
            name: schema.products.name,
            color: schema.products.color,
            stage: schema.products.stage,
          })
          .from(schema.products)
          .innerJoin(
            schema.productMembers,
            and(
              eq(schema.productMembers.productId, schema.products.id),
              eq(schema.productMembers.userId, targetUserId),
            ),
          )
          .where(
            and(
              eq(schema.products.organizationId, req.organizationId!),
              eq(schema.products.active, true),
              ne(schema.products.stage, 'ARCHIVED'),
            ),
          )
          .orderBy(asc(schema.products.name));

        return {
          products: rows.map((r) => ({
            id: r.id,
            name: r.name,
            color: r.color,
            stage: r.stage,
            is_billable: false,
          })),
        };
      });
    },
  );
};
