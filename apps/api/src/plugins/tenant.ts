import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withTenant, getDb } from '@trackflow/db';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authn` after JWT verification. Read by `withRequestTenant`. */
    organizationId?: string;
    userId?: string;
    /**
     * Helper that runs `fn` inside a tenant-bound DB transaction using the
     * org from this request. Throws 401 if no org is attached.
     */
    withTenantDb<T>(fn: Parameters<typeof withTenant>[1]): Promise<T>;
  }
}

/**
 * Decorates every request with `withTenantDb`. We do NOT pre-open a tx
 * here because most read paths are simple single-statement queries that
 * would be cheaper to inline-wrap. Domain services call `req.withTenantDb`
 * when they need a tx.
 */
export const tenantPlugin = fp(async (app) => {
  app.decorateRequest('organizationId', undefined);
  app.decorateRequest('userId', undefined);

  app.decorateRequest('withTenantDb', function (
    this: FastifyRequest,
    fn: Parameters<typeof withTenant>[1],
  ) {
    if (!this.organizationId) {
      const err = new Error('tenant context missing — auth middleware did not run');
      (err as { statusCode?: number }).statusCode = 401;
      (err as { code?: string }).code = 'unauthenticated';
      throw err;
    }
    return withTenant(this.organizationId, fn, getDb());
  });
});

/**
 * Convenience guard: throw 401 if the request is not authenticated.
 * Real auth flow attaches `req.userId` + `req.organizationId` from JWT.
 *
 * Placeholder dev shim: if `x-dev-org` + `x-dev-user` are set, accept them.
 * Replace once `@trackflow/auth` JWT plugin lands.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (req.organizationId && req.userId) return;

  const devOrg = req.headers['x-dev-org'] as string | undefined;
  const devUser = req.headers['x-dev-user'] as string | undefined;
  if (process.env.NODE_ENV !== 'production' && devOrg && devUser) {
    req.organizationId = devOrg;
    req.userId = devUser;
    return;
  }

  reply.code(401).type('application/problem+json').send({
    type: 'https://api.trackflow.app/errors/unauthenticated',
    title: 'Authentication required',
    status: 401,
    code: 'unauthenticated',
    request_id: req.id,
  });
}
