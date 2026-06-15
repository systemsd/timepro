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
  activity_score: z.number().nullable(),
  app_name: z.string().nullable(),
  screenshots: z.array(z.object({ id: z.string(), captured_at: z.string() })),
});

const TimelineResponse = z.object({
  user_id: z.string(),
  display_name: z.string(),
  date: z.string(),
  tracked_seconds: z.number(),
  activity_score: z.number().nullable(),
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

        // activity samples for the day (B4)
        const samples = await tx
          .select({
            bucketMinute: schema.activitySamples.bucketMinute,
            activityScore: schema.activitySamples.activityScore,
          })
          .from(schema.activitySamples)
          .where(
            and(
              eq(schema.activitySamples.organizationId, req.organizationId!),
              eq(schema.activitySamples.userId, req.params.userId),
              gte(schema.activitySamples.bucketMinute, dayStart),
              lt(schema.activitySamples.bucketMinute, dayEnd),
            ),
          );

        // app usage for the day (B5)
        const apps = await tx
          .select({
            appName: schema.appUsage.appName,
            startedAt: schema.appUsage.startedAt,
            endedAt: schema.appUsage.endedAt,
          })
          .from(schema.appUsage)
          .where(
            and(
              eq(schema.appUsage.organizationId, req.organizationId!),
              eq(schema.appUsage.userId, req.params.userId),
              gte(schema.appUsage.startedAt, dayStart),
              lt(schema.appUsage.startedAt, dayEnd),
            ),
          );

        type SlotAcc = {
          projectId: string | null;
          shots: typeof shots;
          scoreSum: number;
          scoreN: number;
          appSecs: Map<string, number>;
        };
        const slotMap = new Map<number, SlotAcc>();
        const ensure = (idx: number, projectId: string | null): SlotAcc => {
          let v = slotMap.get(idx);
          if (!v) {
            v = { projectId, shots: [] as typeof shots, scoreSum: 0, scoreN: 0, appSecs: new Map() };
            slotMap.set(idx, v);
          }
          return v;
        };

        for (const s of shots) {
          const idx = Math.floor((s.capturedAt.getTime() - dayStartMs) / SLOT_MS);
          ensure(idx, s.projectId).shots.push(s);
        }
        for (const sm of samples) {
          const idx = Math.floor((sm.bucketMinute.getTime() - dayStartMs) / SLOT_MS);
          const v = ensure(idx, null);
          v.scoreSum += sm.activityScore;
          v.scoreN += 1;
        }
        for (const a of apps) {
          const idx = Math.floor((a.startedAt.getTime() - dayStartMs) / SLOT_MS);
          const v = ensure(idx, null);
          const secs = Math.max(1, Math.floor((a.endedAt.getTime() - a.startedAt.getTime()) / 1000));
          v.appSecs.set(a.appName, (v.appSecs.get(a.appName) ?? 0) + secs);
        }

        const slots = Array.from(slotMap.entries())
          .sort((a, c) => a[0] - c[0])
          .map(([idx, v]) => {
            let topApp: string | null = null;
            let topSecs = 0;
            for (const [name, secs] of v.appSecs) if (secs > topSecs) { topSecs = secs; topApp = name; }
            return {
              start: new Date(dayStartMs + idx * SLOT_MS).toISOString(),
              end: new Date(dayStartMs + (idx + 1) * SLOT_MS).toISOString(),
              project_id: v.projectId,
              activity_score: v.scoreN > 0 ? Math.round(v.scoreSum / v.scoreN) : null,
              app_name: topApp,
              screenshots: v.shots.map((s) => ({ id: s.id, captured_at: s.capturedAt.toISOString() })),
            };
          });

        const dayScore =
          samples.length > 0
            ? Math.round(samples.reduce((n, s) => n + s.activityScore, 0) / samples.length)
            : null;

        return {
          user_id: req.params.userId,
          display_name: user.displayName,
          date: req.query.date,
          tracked_seconds: tracked,
          activity_score: dayScore,
          slots,
        };
      });
    },
  );
};
