import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, gte, isNull, lt, or } from 'drizzle-orm';
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

// One editable activity = one time-entry row overlapping the day (real start/end,
// not clipped) — drives the "Edit Time" modal.
const Activity = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  description: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  seconds: z.number(),
  source: z.string(),
  is_manual: z.boolean(),
});

const TimelineResponse = z.object({
  user_id: z.string(),
  display_name: z.string(),
  date: z.string(),
  tracked_seconds: z.number(),
  activity_score: z.number().nullable(),
  // tracked tracker run/stop segments (clipped to the day) — the ruler "green bar"
  intervals: z.array(z.object({ start: z.string(), end: z.string() })),
  activities: z.array(Activity),
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
            id: schema.timeEntries.id,
            projectId: schema.timeEntries.projectId,
            projectName: schema.projects.name,
            description: schema.timeEntries.description,
            source: schema.timeEntries.source,
            isManual: schema.timeEntries.isManual,
            startedAt: schema.timeEntries.startedAt,
            endedAt: schema.timeEntries.endedAt,
          })
          .from(schema.timeEntries)
          .leftJoin(schema.projects, eq(schema.projects.id, schema.timeEntries.projectId))
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              eq(schema.timeEntries.userId, req.params.userId),
              isNull(schema.timeEntries.deletedAt),
              lt(schema.timeEntries.startedAt, dayEnd),
              gte(schema.timeEntries.startedAt, new Date(dayStartMs - 86_400_000)), // include overnight
            ),
          );

        let tracked = 0;
        const intervals: Array<{ start: string; end: string }> = [];
        const activities: Array<z.infer<typeof Activity>> = [];
        for (const e of entries) {
          const endMs = e.endedAt ? e.endedAt.getTime() : Date.now();
          const s = Math.max(e.startedAt.getTime(), dayStartMs);
          const en = Math.min(endMs, dayStartMs + 86_400_000);
          if (en > s) {
            tracked += Math.floor((en - s) / 1000);
            intervals.push({ start: new Date(s).toISOString(), end: new Date(en).toISOString() });
            // real (un-clipped) values — the modal edits the true entry times
            activities.push({
              id: e.id,
              project_id: e.projectId ?? null,
              project_name: e.projectName ?? null,
              description: e.description ?? null,
              started_at: e.startedAt.toISOString(),
              ended_at: e.endedAt ? e.endedAt.toISOString() : null,
              seconds: Math.floor((endMs - e.startedAt.getTime()) / 1000),
              source: e.source,
              is_manual: e.isManual,
            });
          }
        }
        intervals.sort((a, b) => (a.start < b.start ? -1 : 1));
        activities.sort((a, b) => (a.started_at < b.started_at ? -1 : 1));

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
          intervals,
          activities,
          slots,
        };
      });
    },
  );

  // Per-day tracked seconds for one user across a month — drives the calendar
  // strip's activity dots on the Timeline page.
  app.get(
    '/timeline/:userId/activity',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        querystring: z.object({
          month: z.string().regex(/^\d{4}-\d{2}$/),
          tzOffsetMinutes: z.coerce.number().default(0),
        }),
        response: {
          200: z.object({ days: z.array(z.object({ date: z.string(), seconds: z.number() })) }),
        },
        tags: ['timeline'],
      },
    },
    async (req) => {
      const visible = await visibleUsers(req);
      if (!canView(visible, req.params.userId)) forbid('Not allowed to view this timeline');

      const [yy, mm] = req.query.month.split('-').map(Number) as [number, number];
      const tz = req.query.tzOffsetMinutes;
      const lm = (y: number, m: number, d: number) => Date.UTC(y, m, d) + tz * 60_000;
      const monthStart = lm(yy, mm - 1, 1);
      const monthEnd = lm(yy, mm, 1);
      const now = Date.now();
      const windowEnd = Math.min(monthEnd, now);
      const toLocalDate = (ms: number) => {
        const s = new Date(ms - tz * 60_000);
        return `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}-${String(s.getUTCDate()).padStart(2, '0')}`;
      };

      return req.withTenantDb(async (tx) => {
        const entries = await tx
          .select({ startedAt: schema.timeEntries.startedAt, endedAt: schema.timeEntries.endedAt })
          .from(schema.timeEntries)
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              eq(schema.timeEntries.userId, req.params.userId),
              isNull(schema.timeEntries.deletedAt),
              lt(schema.timeEntries.startedAt, new Date(monthEnd)),
              or(
                isNull(schema.timeEntries.endedAt),
                gte(schema.timeEntries.endedAt, new Date(monthStart)),
              ),
            ),
          );

        const buckets = new Map<string, number>();
        for (const e of entries) {
          let cursor = Math.max(e.startedAt.getTime(), monthStart);
          const end = Math.min(e.endedAt ? e.endedAt.getTime() : now, windowEnd);
          while (cursor < end) {
            const day = toLocalDate(cursor);
            const [dy, dm, dd] = day.split('-').map(Number) as [number, number, number];
            const dayEnd = lm(dy, dm - 1, dd) + 86_400_000;
            const slice = Math.min(end, dayEnd) - cursor;
            if (slice > 0) buckets.set(day, (buckets.get(day) ?? 0) + Math.floor(slice / 1000));
            cursor = dayEnd;
          }
        }

        const days = Array.from(buckets.entries())
          .filter(([, s]) => s > 0)
          .map(([date, seconds]) => ({ date, seconds }))
          .sort((a, b) => (a.date < b.date ? -1 : 1));
        return { days };
      });
    },
  );

  // Apps + URLs used on a given day for one user — drives the Timeline
  // summary card's "Apps & URLs" panel. Aggregated by app name / domain.
  app.get(
    '/timeline/:userId/apps-urls',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        querystring: z.object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          tzOffsetMinutes: z.coerce.number().default(0),
        }),
        response: {
          200: z.object({
            apps: z.array(z.object({ name: z.string(), seconds: z.number() })),
            urls: z.array(z.object({ domain: z.string(), seconds: z.number() })),
            tasks: z.array(z.object({ description: z.string(), seconds: z.number() })),
          }),
        },
        tags: ['timeline'],
      },
    },
    async (req) => {
      const visible = await visibleUsers(req);
      if (!canView(visible, req.params.userId)) forbid('Not allowed to view this timeline');

      const [yy, mm, dd] = req.query.date.split('-').map(Number) as [number, number, number];
      const tz = req.query.tzOffsetMinutes;
      const dayStartMs = Date.UTC(yy, mm - 1, dd) + tz * 60_000;
      const dayStart = new Date(dayStartMs);
      const dayEnd = new Date(dayStartMs + 86_400_000);
      const overlap = (s: number, e: number) =>
        Math.max(0, Math.min(e, dayStartMs + 86_400_000) - Math.max(s, dayStartMs)) / 1000;

      return req.withTenantDb(async (tx) => {
        const appRows = await tx
          .select({
            key: schema.appUsage.appName,
            startedAt: schema.appUsage.startedAt,
            endedAt: schema.appUsage.endedAt,
          })
          .from(schema.appUsage)
          .where(
            and(
              eq(schema.appUsage.organizationId, req.organizationId!),
              eq(schema.appUsage.userId, req.params.userId),
              lt(schema.appUsage.startedAt, dayEnd),
              gte(schema.appUsage.endedAt, dayStart),
            ),
          );
        const urlRows = await tx
          .select({
            key: schema.urlUsage.domain,
            startedAt: schema.urlUsage.startedAt,
            endedAt: schema.urlUsage.endedAt,
          })
          .from(schema.urlUsage)
          .where(
            and(
              eq(schema.urlUsage.organizationId, req.organizationId!),
              eq(schema.urlUsage.userId, req.params.userId),
              lt(schema.urlUsage.startedAt, dayEnd),
              gte(schema.urlUsage.endedAt, dayStart),
            ),
          );
        const agg = (rows: Array<{ key: string; startedAt: Date; endedAt: Date }>) => {
          const m = new Map<string, number>();
          for (const r of rows) {
            const secs = Math.round(overlap(r.startedAt.getTime(), r.endedAt.getTime()));
            if (secs > 0) m.set(r.key, (m.get(r.key) ?? 0) + secs);
          }
          return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
        };

        // Tasks = the day's time entries grouped by their "What are you working
        // on?" description (entries without one are omitted). A running entry
        // (no endedAt) counts up to now.
        const taskRows = await tx
          .select({
            description: schema.timeEntries.description,
            startedAt: schema.timeEntries.startedAt,
            endedAt: schema.timeEntries.endedAt,
          })
          .from(schema.timeEntries)
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              eq(schema.timeEntries.userId, req.params.userId),
              isNull(schema.timeEntries.deletedAt),
              lt(schema.timeEntries.startedAt, dayEnd),
              or(isNull(schema.timeEntries.endedAt), gte(schema.timeEntries.endedAt, dayStart)),
            ),
          );
        const nowMs = Date.now();
        const taskMap = new Map<string, number>();
        for (const r of taskRows) {
          const desc = (r.description ?? '').trim();
          if (!desc) continue;
          const endMs = r.endedAt ? r.endedAt.getTime() : nowMs;
          const secs = Math.round(overlap(r.startedAt.getTime(), endMs));
          if (secs > 0) taskMap.set(desc, (taskMap.get(desc) ?? 0) + secs);
        }
        const tasks = Array.from(taskMap.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([description, seconds]) => ({ description, seconds }));

        return {
          apps: agg(appRows).map(([name, seconds]) => ({ name, seconds })),
          urls: agg(urlRows).map(([domain, seconds]) => ({ domain, seconds })),
          tasks,
        };
      });
    },
  );
};
