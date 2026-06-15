import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../plugins/tenant';
import { recordHeartbeat } from '../lib/presence';

/**
 * Agent heartbeat (B3). The desktop posts this every ~45s while running, with
 * `is_tracking` reflecting whether a timer is active. Drives the presence dots.
 */
export const presenceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/agent/heartbeat',
    {
      preHandler: [requireAuth],
      schema: {
        body: z.object({ is_tracking: z.boolean().default(false) }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['agent'],
      },
    },
    async (req) => {
      recordHeartbeat(req.organizationId!, req.userId!, req.body.is_tracking);
      return { ok: true };
    },
  );
};
