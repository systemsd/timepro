import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, gte, sql } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { mondayWeekStartMs, resolveWeeklyLimitHours, weeklyTrackedSeconds } from '../lib/limits';

const TodayResponse = z.object({
  tracked_seconds: z.number(),
  is_running: z.boolean(),
  screenshot_count: z.number(),
  week_seconds: z.number(),
  weekly_limit_hours: z.number(), // effective limit; 0 = unlimited
  over_limit: z.boolean(),
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

        // weekly usage vs effective limit (B7)
        const now = Date.now();
        const weekStart = mondayWeekStartMs(0, now); // UTC week (matches /me/today's UTC day basis)
        const weekSeconds = await weeklyTrackedSeconds(tx, req.organizationId!, req.userId!, weekStart, now);
        const limits = await resolveWeeklyLimitHours(tx, req.organizationId!, [req.userId!]);
        const limitHours = limits.get(req.userId!) ?? 0;

        return {
          tracked_seconds: tracked,
          is_running: running,
          screenshot_count: counts[0]?.count ?? 0,
          week_seconds: weekSeconds,
          weekly_limit_hours: limitHours,
          over_limit: limitHours > 0 && weekSeconds > limitHours * 3600,
          entries: out,
        };
      });
    },
  );
};
