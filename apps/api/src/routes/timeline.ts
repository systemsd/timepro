import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, gte, isNull, lt, or } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { canView, forbid, visibleUsers } from '../lib/access';
import { DAY_MS, bucketSecondsByDay, localDateToUtcMs } from '../lib/time';
import { listForUserDay } from '../repositories/screenshots';
import { signImageToken } from '../lib/signed-url';

/**
 * Employee daily timeline (S3): a day's tracked total + the day's activities
 * (time entries), each with its screenshots grouped underneath.
 *
 * `date` is the local calendar date (YYYY-MM-DD) in the viewer tz; the client
 * passes `tzOffsetMinutes` so the day boundary matches what the admin sees (C6).
 */
// A screenshot belonging to an activity (app + activity level resolved per shot).
const Shot = z.object({
  id: z.string(),
  captured_at: z.string(),
  app_name: z.string().nullable(),
  activity_score: z.number().nullable(),
});

// One activity = one time-entry row overlapping the day (real start/end, not
// clipped). Its screenshots are grouped under it; clicking the header opens the
// "Edit Time" modal.
const Activity = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  task_id: z.string().nullable(),
  task_name: z.string().nullable(),
  description: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  seconds: z.number(),
  activity_score: z.number().nullable(),
  source: z.string(),
  is_manual: z.boolean(),
  screenshots: z.array(Shot),
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
  // Signed token for this user's screenshot image URLs (thumb/raw), ~1h TTL.
  image_token: z.string(),
});

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

      const tz = req.query.tzOffsetMinutes;
      const dayStartMs = localDateToUtcMs(req.query.date, tz); // local midnight → real UTC
      const dayEndMs = dayStartMs + DAY_MS;
      const dayStart = new Date(dayStartMs);
      const dayEnd = new Date(dayEndMs);

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
            taskId: schema.timeEntries.taskId,
            taskName: schema.tasks.name,
            description: schema.timeEntries.description,
            source: schema.timeEntries.source,
            isManual: schema.timeEntries.isManual,
            startedAt: schema.timeEntries.startedAt,
            endedAt: schema.timeEntries.endedAt,
          })
          .from(schema.timeEntries)
          .leftJoin(schema.projects, eq(schema.projects.id, schema.timeEntries.projectId))
          .leftJoin(schema.tasks, eq(schema.tasks.id, schema.timeEntries.taskId))
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              eq(schema.timeEntries.userId, req.params.userId),
              isNull(schema.timeEntries.deletedAt),
              // Every entry that OVERLAPS the day — including a long-running/overnight
              // one that started earlier — so its screenshots have an activity to
              // group under (matches the Tasks query below). Filtering on `startedAt`
              // alone stranded such screenshots, which `actAt` then misfiled.
              lt(schema.timeEntries.startedAt, dayEnd),
              or(isNull(schema.timeEntries.endedAt), gte(schema.timeEntries.endedAt, dayStart)),
            ),
          );

        // Accumulator per activity — screenshots + activity score get grouped in below.
        type ActAcc = {
          resp: z.infer<typeof Activity>;
          startMs: number;
          endMs: number; // real end (now, for a running entry)
          scoreSum: number;
          scoreN: number;
        };
        let tracked = 0;
        const intervals: Array<{ start: string; end: string }> = [];
        const acts: ActAcc[] = [];
        for (const e of entries) {
          const endMs = e.endedAt ? e.endedAt.getTime() : Date.now();
          const s = Math.max(e.startedAt.getTime(), dayStartMs);
          const en = Math.min(endMs, dayEndMs);
          if (en > s) {
            tracked += Math.floor((en - s) / 1000);
            intervals.push({ start: new Date(s).toISOString(), end: new Date(en).toISOString() });
            // real (un-clipped) values — the modal edits the true entry times
            acts.push({
              startMs: e.startedAt.getTime(),
              endMs,
              scoreSum: 0,
              scoreN: 0,
              resp: {
                id: e.id,
                project_id: e.projectId ?? null,
                project_name: e.projectName ?? null,
                task_id: e.taskId ?? null,
                task_name: e.taskName ?? null,
                description: e.description ?? null,
                started_at: e.startedAt.toISOString(),
                ended_at: e.endedAt ? e.endedAt.toISOString() : null,
                seconds: Math.floor((endMs - e.startedAt.getTime()) / 1000),
                activity_score: null,
                source: e.source,
                is_manual: e.isManual,
                screenshots: [],
              },
            });
          }
        }
        intervals.sort((a, b) => (a.start < b.start ? -1 : 1));
        acts.sort((a, b) => a.startMs - b.startMs);

        // The activity a capture/sample belongs to: the one whose [start, end]
        // range contains it (a small grace past the end catches a capture that
        // lands just after a stop). Pick the latest-starting match when ranges
        // touch. A capture with no owning activity is an orphan → return null so
        // it's dropped, never misfiled onto an unrelated activity (which is why a
        // 6am screenshot was showing under a noon entry).
        const ACT_GRACE_MS = 90_000;
        const actAt = (ms: number): ActAcc | null => {
          let best: ActAcc | null = null;
          for (const a of acts) {
            if (a.startMs <= ms && ms <= a.endMs + ACT_GRACE_MS && (!best || a.startMs > best.startMs)) {
              best = a;
            }
          }
          return best;
        };

        const shots = await listForUserDay(tx, req.organizationId!, req.params.userId, dayStart, dayEnd);

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

        // app usage for the day (B5) — used to label each screenshot's app.
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
        const appAt = (ms: number): string | null => {
          for (const a of apps) if (a.startedAt.getTime() <= ms && ms <= a.endedAt.getTime()) return a.appName;
          return null;
        };

        // Group screenshots under their activity; label each with its app + score.
        for (const sh of shots) {
          const a = actAt(sh.capturedAt.getTime());
          if (!a) continue;
          a.resp.screenshots.push({
            id: sh.id,
            captured_at: sh.capturedAt.toISOString(),
            app_name: sh.appName ?? appAt(sh.capturedAt.getTime()),
            activity_score: sh.activityScore ?? null,
          });
        }
        // Activity-level score = mean of the activity samples that fall in it.
        for (const sm of samples) {
          const a = actAt(sm.bucketMinute.getTime());
          if (a) { a.scoreSum += sm.activityScore; a.scoreN += 1; }
        }

        const activities = acts.map((a) => ({
          ...a.resp,
          activity_score: a.scoreN > 0 ? Math.round(a.scoreSum / a.scoreN) : null,
        }));

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
          image_token: signImageToken(req.organizationId!, req.params.userId),
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
          const start = Math.max(e.startedAt.getTime(), monthStart);
          const end = Math.min(e.endedAt ? e.endedAt.getTime() : now, windowEnd);
          for (const { date, seconds } of bucketSecondsByDay(start, end, tz)) {
            if (seconds > 0) buckets.set(date, (buckets.get(date) ?? 0) + seconds);
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
            tasks: z.array(
            z.object({
              task_id: z.string().nullable(),
              task_name: z.string().nullable(),
              description: z.string().nullable(),
              seconds: z.number(),
              running: z.boolean(), // an entry in this group is currently live
            }),
          ),
          }),
        },
        tags: ['timeline'],
      },
    },
    async (req) => {
      const visible = await visibleUsers(req);
      if (!canView(visible, req.params.userId)) forbid('Not allowed to view this timeline');

      const tz = req.query.tzOffsetMinutes;
      const dayStartMs = localDateToUtcMs(req.query.date, tz);
      const dayEndMs = dayStartMs + DAY_MS;
      const dayStart = new Date(dayStartMs);
      const dayEnd = new Date(dayEndMs);
      // NOTE: rounds (not floors) — preserved as-is so per-app/domain totals don't shift.
      const overlap = (s: number, e: number) =>
        Math.max(0, Math.min(e, dayEndMs) - Math.max(s, dayStartMs)) / 1000;

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

        // Tasks = the day's entries grouped by the OpsCore task (primary) + the
        // "What are you working on?" description (sub-line). An entry with neither
        // a task nor a description is omitted. A running entry (no endedAt) counts
        // up to now and flags its group as live (for the blinking caret on the web).
        const taskRows = await tx
          .select({
            taskId: schema.timeEntries.taskId,
            taskName: schema.tasks.name,
            description: schema.timeEntries.description,
            startedAt: schema.timeEntries.startedAt,
            endedAt: schema.timeEntries.endedAt,
          })
          .from(schema.timeEntries)
          .leftJoin(schema.tasks, eq(schema.tasks.id, schema.timeEntries.taskId))
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
        type TaskAgg = {
          task_id: string | null;
          task_name: string | null;
          description: string | null;
          seconds: number;
          running: boolean;
        };
        const taskMap = new Map<string, TaskAgg>();
        for (const r of taskRows) {
          const desc = (r.description ?? '').trim() || null;
          if (!r.taskName && !desc) continue; // nothing to label this group with
          const key = `${r.taskId ?? ''}::${desc ?? ''}`;
          const endMs = r.endedAt ? r.endedAt.getTime() : nowMs;
          const secs = Math.max(0, Math.round(overlap(r.startedAt.getTime(), endMs)));
          const cur = taskMap.get(key);
          if (cur) {
            cur.seconds += secs;
            if (!r.endedAt) cur.running = true;
          } else {
            taskMap.set(key, {
              task_id: r.taskId ?? null,
              task_name: r.taskName ?? null,
              description: desc,
              seconds: secs,
              running: !r.endedAt,
            });
          }
        }
        const tasks = Array.from(taskMap.values())
          .filter((t) => t.seconds > 0 || t.running)
          .sort((a, b) => b.seconds - a.seconds);

        return {
          apps: agg(appRows).map(([name, seconds]) => ({ name, seconds })),
          urls: agg(urlRows).map(([domain, seconds]) => ({ domain, seconds })),
          tasks,
        };
      });
    },
  );
};
