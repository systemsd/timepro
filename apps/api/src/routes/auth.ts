import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { loadConfig } from '../config';
import { createHandoff, consumeHandoff } from '../lib/handoff';

const DevLoginBody = z.object({
  email: z.string().email(),
});

const DevLoginResponse = z.object({
  user_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  organization_name: z.string(),
  display_name: z.string(),
  role: z.string(),
});

/**
 * Dev-only login: takes an email, looks up the active membership, and
 * returns the IDs the desktop agent needs for the `x-dev-*` headers.
 *
 * This is a stand-in for real JWT auth — when `@timepro/auth` lands,
 * swap this for `/v1/auth/login` returning a signed access + refresh pair.
 */
export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/auth/dev-login',
    {
      schema: {
        body: DevLoginBody,
        response: { 200: DevLoginResponse },
        tags: ['auth'],
        summary: 'Dev-only email→ids lookup (no password). Replace with JWT.',
      },
    },
    async (req) => {
      const { email } = req.body;

      // Not tenant-scoped — we have to find the user before we know the org.
      // Production /auth/login would use a constant-time password check here.
      const db = getDb();
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);

      if (!user) {
        throw Object.assign(new Error(`No user found for email ${email}`), {
          statusCode: 401,
          code: 'invalid_credentials',
        });
      }

      // Pick the first active membership. Multi-org users will need an
      // explicit picker post-login — out of scope for MVP.
      const [membership] = await db
        .select({
          orgId: schema.memberships.organizationId,
          role: schema.memberships.role,
          orgName: schema.organizations.name,
        })
        .from(schema.memberships)
        .innerJoin(
          schema.organizations,
          eq(schema.memberships.organizationId, schema.organizations.id),
        )
        .where(
          and(
            eq(schema.memberships.userId, user.id),
            eq(schema.memberships.status, 'active'),
          ),
        )
        .limit(1);

      if (!membership) {
        throw Object.assign(new Error('User has no active organization membership'), {
          statusCode: 403,
          code: 'no_active_membership',
        });
      }

      return {
        user_id: user.id,
        organization_id: membership.orgId,
        organization_name: membership.orgName,
        display_name: user.displayName,
        role: membership.role,
      };
    },
  );

  // --- desktop → web auto-login handoff ---

  // 1. Desktop (authenticated) mints a one-time code and gets the URL to open.
  app.post(
    '/auth/handoff',
    {
      preHandler: [requireAuth],
      schema: {
        response: {
          200: z.object({ url: z.string(), expires_at: z.string() }),
        },
        tags: ['auth'],
        summary: 'Mint a one-time code for opening the web dashboard logged-in.',
      },
    },
    async (req) => {
      const { code, expiresAt } = createHandoff(req.userId!, req.organizationId!);
      const base = loadConfig().WEB_PUBLIC_URL.replace(/\/$/, '');
      return {
        url: `${base}/auth/handoff?code=${encodeURIComponent(code)}`,
        expires_at: new Date(expiresAt).toISOString(),
      };
    },
  );

  // 2. Web exchanges the code for the session identity (public — the code IS the proof).
  app.post(
    '/auth/handoff/exchange',
    {
      schema: {
        body: z.object({ code: z.string().min(8) }),
        response: { 200: DevLoginResponse },
        tags: ['auth'],
        summary: 'Exchange a one-time handoff code for a session.',
      },
    },
    async (req) => {
      const entry = consumeHandoff(req.body.code);
      if (!entry) {
        throw Object.assign(new Error('Handoff code is invalid or expired'), {
          statusCode: 401,
          code: 'handoff_invalid',
        });
      }

      const db = getDb();
      const [row] = await db
        .select({
          displayName: schema.users.displayName,
          role: schema.memberships.role,
          orgName: schema.organizations.name,
        })
        .from(schema.users)
        .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
        .innerJoin(
          schema.organizations,
          eq(schema.organizations.id, schema.memberships.organizationId),
        )
        .where(
          and(
            eq(schema.users.id, entry.userId),
            eq(schema.memberships.organizationId, entry.organizationId),
          ),
        )
        .limit(1);

      if (!row) {
        throw Object.assign(new Error('User/membership no longer exists'), {
          statusCode: 401,
          code: 'handoff_invalid',
        });
      }

      return {
        user_id: entry.userId,
        organization_id: entry.organizationId,
        organization_name: row.orgName,
        display_name: row.displayName,
        role: row.role,
      };
    },
  );
};
