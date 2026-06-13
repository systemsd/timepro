import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { getDb } from '@trackflow/db';

const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptime_sec: z.number(),
  checks: z.object({
    db: z.enum(['ok', 'failed']),
  }),
});

const STARTED_AT = Date.now();
const VERSION = process.env.APP_VERSION ?? '0.1.0-dev';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  // Liveness — no dependencies. Used by load balancers.
  app.get('/healthz', { logLevel: 'silent' }, async () => ({ ok: true }));

  // Readiness — touches the DB. Used by orchestrators before sending traffic.
  app.get(
    '/readyz',
    {
      schema: { response: { 200: HealthResponse, 503: HealthResponse } },
      logLevel: 'warn',
    },
    async (_req, reply) => {
      const checks = { db: 'ok' as 'ok' | 'failed' };
      try {
        await getDb().execute(sql`select 1`);
      } catch {
        checks.db = 'failed';
      }
      const status: 'ok' | 'degraded' = checks.db === 'ok' ? 'ok' : 'degraded';
      reply.code(status === 'ok' ? 200 : 503);
      return {
        status,
        version: VERSION,
        uptime_sec: Math.floor((Date.now() - STARTED_AT) / 1000),
        checks,
      };
    },
  );
};
