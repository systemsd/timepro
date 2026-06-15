import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { visibleUsers } from '../lib/access';
import { getPresence } from '../lib/presence';
import { resolveWeeklyLimitHours } from '../lib/limits';

/**
 * Manager/Admin "My Home" roster (S2). One row per visible employee with
 * tracked-time totals for today / yesterday / this week / this month and the
 * most recent screenshot. Computed on the fly (rollups come in a later phase).
 *
 * Periods use the org/viewer timezone (C6) — passed as `tzOffsetMinutes`
 * from the browser until a stored org tz lands.
 */
const RosterRow = z.object({
  user_id: z.string(),
  display_name: z.string(),
  email: z.string(),
  role: z.string(),
  is_owner: z.boolean(),
  status: z.string(),
  presence: z.enum(['offline', 'connected', 'tracking']),
  last_app: z.string().nullable(),
  today_seconds: z.number(),
  yesterday_seconds: z.number(),
  week_seconds: z.number(),
  month_seconds: z.number(),
  period_seconds: z.number(), // tracked time in the selected day/month (S2 day/month switch)
  weekly_limit_hours: z.number(), // effective limit; 0 = unlimited
  over_limit: z.boolean(),
  last_active: z.string().nullable(),
  last_screenshot_id: z.string().nullable(),
});

const RosterResponse = z.object({
  rows: z.array(RosterRow),
  totals: z.object({
    today_seconds: z.number(),
    yesterday_seconds: z.number(),
    week_seconds: z.number(),
    month_seconds: z.number(),
    period_seconds: z.number(),
    online: z.number(),
  }),
  period: z.object({
    type: z.enum(['day', 'month']),
    date: z.string(), // the selected local date (YYYY-MM-DD), anchor of the window
  }),
});

/** Boundaries (UTC ms) for today/yesterday/week/month, shifted by viewer tz. */
function periodBounds(tzOffsetMinutes: number) {
  const now = Date.now();
  const shifted = new Date(now - tzOffsetMinutes * 60_000); // local wall-clock as UTC fields
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const dow = shifted.getUTCDay(); // 0=Sun
  const localMidnight = (yy: number, mm: number, dd: number) =>
    Date.UTC(yy, mm, dd) + tzOffsetMinutes * 60_000; // back to real UTC
  const todayStart = localMidnight(y, m, d);
  const yesterdayStart = todayStart - 86_400_000;
  const mondayOffset = (dow + 6) % 7; // days since Monday
  const weekStart = todayStart - mondayOffset * 86_400_000;
  const monthStart = localMidnight(y, m, 1);
  return { now, todayStart, yesterdayStart, weekStart, monthStart };
}

function overlapSeconds(start: number, end: number, winStart: number, winEnd: number): number {
  const s = Math.max(start, winStart);
  const e = Math.min(end, winEnd);
  return e > s ? Math.floor((e - s) / 1000) : 0;
}

/** UTC-ms window for the selected day or month (viewer-local), + the anchor date. */
function selectedWindow(
  period: 'day' | 'month',
  date: string | undefined,
  tzOffsetMinutes: number,
  now: number,
): { start: number; end: number; date: string } {
  let y: number, m: number, d: number;
  if (date) {
    const p = date.split('-');
    y = Number(p[0]);
    m = Number(p[1]) - 1;
    d = Number(p[2]);
  } else {
    const s = new Date(now - tzOffsetMinutes * 60_000);
    y = s.getUTCFullYear();
    m = s.getUTCMonth();
    d = s.getUTCDate();
  }
  const localMidnight = (yy: number, mm: number, dd: number) =>
    Date.UTC(yy, mm, dd) + tzOffsetMinutes * 60_000;
  const pad = (n: number) => String(n).padStart(2, '0');
  const anchor = `${y}-${pad(m + 1)}-${pad(d)}`;
  if (period === 'month') {
    return { start: localMidnight(y, m, 1), end: localMidnight(y, m + 1, 1), date: anchor };
  }
  const start = localMidnight(y, m, d);
  return { start, end: start + 86_400_000, date: anchor };
}

export const rosterRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/roster',
    {
      preHandler: [requireAuth],
      schema: {
        querystring: z.object({
          tzOffsetMinutes: z.coerce.number().default(0),
          period: z.enum(['day', 'month']).default('day'),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
        response: { 200: RosterResponse },
        tags: ['roster'],
      },
    },
    async (req) => {
      // Admin/owner → whole org; manager → their team; employee → just themselves
      // (their own row drives the Employee Dashboard). `visibleUsers` scopes it.
      const visible = await visibleUsers(req);

      const b = periodBounds(req.query.tzOffsetMinutes);
      // Selected day/month window (S2 day/month switch). `now` clips the future.
      const win = selectedWindow(req.query.period, req.query.date, req.query.tzOffsetMinutes, b.now);
      const winEnd = Math.min(win.end, b.now);
      // Fetch from the earlier of the month-to-date start and the selected window.
      const fetchFrom = new Date(Math.min(b.monthStart, win.start));

      return req.withTenantDb(async (tx) => {
        // members in scope
        const memberScope =
          visible.userIds === 'all'
            ? eq(schema.memberships.organizationId, req.organizationId!)
            : and(
                eq(schema.memberships.organizationId, req.organizationId!),
                inArray(schema.memberships.userId, visible.userIds),
              );
        const members = await tx
          .select({
            userId: schema.users.id,
            displayName: schema.users.displayName,
            email: schema.users.email,
            role: schema.memberships.role,
            status: schema.memberships.status,
          })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(memberScope);

        const userIds = members.map((m) => m.userId);
        const periodMeta = { type: req.query.period, date: win.date };
        if (userIds.length === 0) {
          return {
            rows: [],
            totals: { today_seconds: 0, yesterday_seconds: 0, week_seconds: 0, month_seconds: 0, period_seconds: 0, online: 0 },
            period: periodMeta,
          };
        }

        // time entries since the earlier of month-start / selected-window-start
        const entries = await tx
          .select({
            userId: schema.timeEntries.userId,
            startedAt: schema.timeEntries.startedAt,
            endedAt: schema.timeEntries.endedAt,
          })
          .from(schema.timeEntries)
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              inArray(schema.timeEntries.userId, userIds),
              gte(schema.timeEntries.startedAt, fetchFrom),
            ),
          );

        // latest screenshot per user (cap to month for cheapness; "last active")
        const shots = await tx
          .select({
            userId: schema.screenshots.userId,
            id: schema.screenshots.id,
            capturedAt: schema.screenshots.capturedAt,
          })
          .from(schema.screenshots)
          .where(
            and(
              eq(schema.screenshots.organizationId, req.organizationId!),
              inArray(schema.screenshots.userId, userIds),
            ),
          )
          .orderBy(desc(schema.screenshots.capturedAt));

        const lastShot = new Map<string, { id: string; at: number }>();
        for (const s of shots) {
          if (!lastShot.has(s.userId)) lastShot.set(s.userId, { id: s.id, at: s.capturedAt.getTime() });
        }

        // most recent app per user (B5)
        const appRows = await tx
          .select({
            userId: schema.appUsage.userId,
            appName: schema.appUsage.appName,
            startedAt: schema.appUsage.startedAt,
          })
          .from(schema.appUsage)
          .where(
            and(
              eq(schema.appUsage.organizationId, req.organizationId!),
              inArray(schema.appUsage.userId, userIds),
              gte(schema.appUsage.startedAt, new Date(b.monthStart)),
            ),
          )
          .orderBy(desc(schema.appUsage.startedAt));
        const lastApp = new Map<string, string>();
        for (const a of appRows) if (!lastApp.has(a.userId)) lastApp.set(a.userId, a.appName);

        // effective weekly limits (B7) — for the over-cap indicator
        const weeklyLimits = await resolveWeeklyLimitHours(tx, req.organizationId!, userIds);

        type Acc = { today: number; yesterday: number; week: number; month: number; period: number; lastActive: number };
        const acc = new Map<string, Acc>();
        for (const id of userIds) acc.set(id, { today: 0, yesterday: 0, week: 0, month: 0, period: 0, lastActive: 0 });

        for (const e of entries) {
          const a = acc.get(e.userId);
          if (!a) continue;
          const start = e.startedAt.getTime();
          const end = e.endedAt ? e.endedAt.getTime() : b.now;
          a.today += overlapSeconds(start, end, b.todayStart, b.now);
          a.yesterday += overlapSeconds(start, end, b.yesterdayStart, b.todayStart);
          a.week += overlapSeconds(start, end, b.weekStart, b.now);
          a.month += overlapSeconds(start, end, b.monthStart, b.now);
          a.period += overlapSeconds(start, end, win.start, winEnd);
          a.lastActive = Math.max(a.lastActive, end);
        }

        const rows = members.map((m) => {
          const a = acc.get(m.userId)!;
          const ls = lastShot.get(m.userId);
          const lastActiveMs = Math.max(a.lastActive, ls?.at ?? 0);
          const limitHours = weeklyLimits.get(m.userId) ?? 0;
          return {
            user_id: m.userId,
            display_name: m.displayName,
            email: m.email,
            role: m.role,
            is_owner: m.role === 'owner',
            status: m.status,
            presence: getPresence(req.organizationId!, m.userId),
            last_app: lastApp.get(m.userId) ?? null,
            today_seconds: a.today,
            yesterday_seconds: a.yesterday,
            week_seconds: a.week,
            month_seconds: a.month,
            period_seconds: a.period,
            weekly_limit_hours: limitHours,
            over_limit: limitHours > 0 && a.week > limitHours * 3600,
            last_active: lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : null,
            last_screenshot_id: ls?.id ?? null,
          };
        });

        // sort by last active desc (nulls last), like the screenshot
        rows.sort((x, y) => (y.last_active ? Date.parse(y.last_active) : 0) - (x.last_active ? Date.parse(x.last_active) : 0));

        const totals = rows.reduce(
          (t, r) => ({
            today_seconds: t.today_seconds + r.today_seconds,
            yesterday_seconds: t.yesterday_seconds + r.yesterday_seconds,
            week_seconds: t.week_seconds + r.week_seconds,
            month_seconds: t.month_seconds + r.month_seconds,
            period_seconds: t.period_seconds + r.period_seconds,
            online: t.online + (r.presence !== 'offline' ? 1 : 0),
          }),
          { today_seconds: 0, yesterday_seconds: 0, week_seconds: 0, month_seconds: 0, period_seconds: 0, online: 0 },
        );

        return { rows, totals, period: periodMeta };
      });
    },
  );
};
