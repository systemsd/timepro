import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { canView, forbid, visibleUsers } from '../lib/access';

/**
 * Employee daily timeline (S3): a day's tracked total + screenshots grouped
 * into time slots. Activity strip/% comes later (needs activity tracking).
 *
 * `date` is the local calendar date (YYYY-MM-DD) in the viewer tz; the client
 * passes `tzOffsetMinutes` so the day boundary matches what the admin sees (C6).
 */
const Slot = z.object({
  start: z.string(),
  end: z.string(),
  project_id: z.string().nullable(),
  screenshots: z.array(z.object({ id: z.string(), captured_at: z.string() })),
});

const TimelineResponse = z.object({
  user_id: z.string(),
  display_name: z.string(),
  date: z.string(),
  tracked_seconds: z.number(),
  slots: z.array(Slot),
});

const SLOT_MS = 10 * 60_000; // 10-minute slots (Scrnio convention)

export const timelineRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/timeline/:userId',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        querystring: z.object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          tzOffsetMinutes: z.coerce.number().default(0),
        }),
        response: { 200: TimelineResponse },
        tags: ['timeline'],
      },
    },
    async (req) => {
      const visible = await visibleUsers(req);
      // an employee may view their own timeline; managers their team; admins all
      if (!canView(visible, req.params.userId)) forbid('Not allowed to view this timeline');

      const [yy, mm, dd] = req.query.date.split('-').map(Number) as [number, number, number];
      const tz = req.query.tzOffsetMinutes;
      const dayStartMs = Date.UTC(yy, mm - 1, dd) + tz * 60_000; // local midnight → real UTC
      const dayStart = new Date(dayStartMs);
      const dayEnd = new Date(dayStartMs + 86_400_000);

      return req.withTenantDb(async (tx) => {
        const [user] = await tx
          .select({ displayName: schema.users.displayName })
          .from(schema.users)
          .where(eq(schema.users.id, req.params.userId))
          .limit(1);
        if (!user) {
          throw Object.assign(new Error('user not found'), { statusCode: 404, code: 'not_found' });
        }

        const entries = await tx
          .select({
            startedAt: schema.timeEntries.startedAt,
            endedAt: schema.timeEntries.endedAt,
          })
          .from(schema.timeEntries)
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              eq(schema.timeEntries.userId, req.params.userId),
              lt(schema.timeEntries.startedAt, dayEnd),
              gte(schema.timeEntries.startedAt, new Date(dayStartMs - 86_400_000)), // include overnight
            ),
          );

        let tracked = 0;
        for (const e of entries) {
          const s = Math.max(e.startedAt.getTime(), dayStartMs);
          const en = Math.min(e.endedAt ? e.endedAt.getTime() : Date.now(), dayStartMs + 86_400_000);
          if (en > s) tracked += Math.floor((en - s) / 1000);
        }

        const shots = await tx
          .select({
            id: schema.screenshots.id,
            capturedAt: schema.screenshots.capturedAt,
            projectId: schema.screenshots.projectId,
          })
          .from(schema.screenshots)
          .where(
            and(
              eq(schema.screenshots.organizationId, req.organizationId!),
              eq(schema.screenshots.userId, req.params.userId),
              gte(schema.screenshots.capturedAt, dayStart),
              lt(schema.screenshots.capturedAt, dayEnd),
            ),
          )
          .orderBy(asc(schema.screenshots.capturedAt));

        // group into 10-min slots
        const slotMap = new Map<number, { projectId: string | null; shots: typeof shots }>();
        for (const s of shots) {
          const slotIdx = Math.floor((s.capturedAt.getTime() - dayStartMs) / SLOT_MS);
          const cur = slotMap.get(slotIdx);
          if (cur) cur.shots.push(s);
          else slotMap.set(slotIdx, { projectId: s.projectId, shots: [s] });
        }

        const slots = Array.from(slotMap.entries())
          .sort((a, c) => a[0] - c[0])
          .map(([idx, v]) => ({
            start: new Date(dayStartMs + idx * SLOT_MS).toISOString(),
            end: new Date(dayStartMs + (idx + 1) * SLOT_MS).toISOString(),
            project_id: v.projectId,
            screenshots: v.shots.map((s) => ({ id: s.id, captured_at: s.capturedAt.toISOString() })),
          }));

        return {
          user_id: req.params.userId,
          display_name: user.displayName,
          date: req.query.date,
          tracked_seconds: tracked,
          slots,
        };
      });
    },
  );
};
