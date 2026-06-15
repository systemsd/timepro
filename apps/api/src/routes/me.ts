import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, gte, sql } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';

const TodayResponse = z.object({
  tracked_seconds: z.number(),
  is_running: z.boolean(),
  screenshot_count: z.number(),
  entries: z.array(
    z.object({
      id: z.string(),
      project_id: z.string().nullable(),
      description: z.string().nullable(),
      started_at: z.string(),
      ended_at: z.string().nullable(),
      duration_seconds: z.number(),
    }),
  ),
});

/** Start of the current UTC day. MVP keeps it simple; Phase 2 honors user tz. */
function startOfUtcDay(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/me/today',
    {
      preHandler: [requireAuth],
      schema: { response: { 200: TodayResponse }, tags: ['me'] },
    },
    async (req) => {
      const dayStart = startOfUtcDay();
      return req.withTenantDb(async (tx) => {
        const entries = await tx
          .select()
          .from(schema.timeEntries)
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              eq(schema.timeEntries.userId, req.userId!),
              gte(schema.timeEntries.startedAt, dayStart),
            ),
          )
          .orderBy(sql`started_at desc`);

        let tracked = 0;
        let running = false;
        const out = entries.map((e) => {
          const start = e.startedAt.getTime();
          const end = e.endedAt ? e.endedAt.getTime() : Date.now();
          if (!e.endedAt) running = true;
          const dur = Math.max(0, Math.floor((end - start) / 1000));
          tracked += dur;
          return {
            id: e.id,
            project_id: e.projectId ?? null,
            description: e.description ?? null,
            started_at: e.startedAt.toISOString(),
            ended_at: e.endedAt ? e.endedAt.toISOString() : null,
            duration_seconds: dur,
          };
        });

        const counts = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.screenshots)
          .where(
            and(
              eq(schema.screenshots.organizationId, req.organizationId!),
              eq(schema.screenshots.userId, req.userId!),
              gte(schema.screenshots.capturedAt, dayStart),
            ),
          );

        return {
          tracked_seconds: tracked,
          is_running: running,
          screenshot_count: counts[0]?.count ?? 0,
          entries: out,
        };
      });
    },
  );
};
