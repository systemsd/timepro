import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { forbid, isAdmin, requesterRole, visibleUsers } from '../lib/access';
import {
  buildGroups,
  buildWeeks,
  dateRange,
  DEFAULT_GROUP_BY,
  isWeekendLocal,
  localDateToUtcMs,
  meanScore,
  overlapSeconds,
  pivot,
  utcMsToLocalDate,
  type FlatEntry,
} from '../lib/report-time';

/**
 * Reports console query API (B7 / Phase 5, sub-phase 5A).
 *
 * Computed **on the fly** from `time_entries` (+ project/client joins), mirroring
 * the roster/timeline endpoints — no rollups yet (those land in 5D behind this
 * same API). All day/week boundaries use the org/viewer timezone (C6), passed as
 * `tzOffsetMinutes` (browser `getTimezoneOffset()`), until a stored org tz lands.
 *
 * Spec: docs/06-reporting.md §0. Three report types share one query:
 *   - summary  → grouped totals (group-by employee/project/client, nestable)
 *   - detailed → one row per time entry (Date · Employee · Project · Note · From · To · Duration)
 *   - weekly   → per-employee totals with a per-day breakdown (absences deferred to 5F)
 *
 * Every response also carries the daily-totals series (bar chart) and the
 * Employees/Projects/Clients/Notes pivots that drive the result tabs.
 */

// ---- request ----

const GroupDim = z.enum(['employee', 'project', 'client']);

const ReportQuery = z.object({
  type: z.enum(['summary', 'detailed', 'weekly']).default('summary'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // inclusive, viewer-local date
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // inclusive, viewer-local date
  tzOffsetMinutes: z.number().default(0),
  userIds: z.array(z.string().uuid()).optional(), // empty/absent = all visible
  clientIds: z.array(z.string().uuid()).optional(),
  projectIds: z.array(z.string().uuid()).optional(),
  noteContains: z.string().trim().min(1).optional(),
  groupBy: z.array(GroupDim).optional(), // defaults by type
  onlyOffline: z.boolean().default(false), // manual ("offline") entries only
  excludeArchived: z.boolean().default(false), // drop archived-project time
});
type ReportQuery = z.infer<typeof ReportQuery>;

// ---- response ----

const GroupNode: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    dim: GroupDim,
    key: z.string().nullable(),
    label: z.string(),
    seconds: z.number(),
    activity_score: z.number().nullable(), // mean 0-100 across the group's samples, null if none
    children: z.array(GroupNode).optional(),
  }),
);

const DetailRow = z.object({
  entry_id: z.string(),
  date: z.string(), // YYYY-MM-DD (viewer-local, of the clipped start)
  user_id: z.string(),
  display_name: z.string(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  note: z.string().nullable(),
  from: z.string(), // ISO
  to: z.string(), // ISO (running timers clipped to now)
  duration_seconds: z.number(),
  activity_score: z.number().nullable(), // mean 0-100 across the entry's samples, null if none
  is_manual: z.boolean(),
});

const Pivot = z.object({
  key: z.string().nullable(),
  label: z.string(),
  seconds: z.number(),
  activity_score: z.number().nullable(),
});

// One ISO week (Monday-start) for the Weekly report: total + per-employee rows,
// each with a Mon..Sun day breakdown.
const WeekRow = z.object({
  key: z.string().nullable(),
  label: z.string(),
  seconds: z.number(),
  activity_score: z.number().nullable(),
  days: z.array(z.number()), // length 7, Mon..Sun, seconds per day
});
const WeekBlock = z.object({
  week_start: z.string(), // YYYY-MM-DD (Monday, viewer-local)
  week_end: z.string(), // YYYY-MM-DD (Sunday)
  seconds: z.number(),
  activity_score: z.number().nullable(),
  rows: z.array(WeekRow), // one per employee, desc by seconds
});

const ReportResponse = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  type: z.enum(['summary', 'detailed', 'weekly']),
  group_by: z.array(GroupDim),
  total_seconds: z.number(),
  active_seconds: z.number(), // summed active seconds from activity samples
  idle_seconds: z.number(), // summed idle seconds from activity samples
  avg_activity_score: z.number().nullable(), // overall mean 0-100, null if no samples
  daily: z.array(z.object({ date: z.string(), seconds: z.number(), is_weekend: z.boolean() })),
  groups: z.array(GroupNode), // populated for summary + weekly
  weeks: z.array(WeekBlock), // populated for weekly
  detailed: z.array(DetailRow), // populated for detailed
  detailed_truncated: z.boolean(),
  by_employee: z.array(Pivot),
  by_project: z.array(Pivot),
  by_client: z.array(Pivot),
  apps: z.array(Pivot), // top apps by tracked time (B5)
  urls: z.array(Pivot), // top domains by tracked time (B5; needs the extension)
  notes: z.array(DetailRow), // entries carrying a note
});

const DETAIL_CAP = 5000; // sync read guard; large pulls move to exports (5C/§8)

export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Filter-bar options (RBAC-scoped employees + the client/project catalogs). */
  app.get(
    '/reports/filters',
    {
      preHandler: [requireAuth],
      schema: {
        response: {
          200: z.object({
            employees: z.array(z.object({ id: z.string(), name: z.string() })),
            clients: z.array(z.object({ id: z.string(), name: z.string() })),
            projects: z.array(
              z.object({ id: z.string(), name: z.string(), client_id: z.string().nullable() }),
            ),
          }),
        },
        tags: ['reports'],
      },
    },
    async (req) => {
      const visible = await visibleUsers(req);
      return req.withTenantDb(async (tx) => {
        const memberScope =
          visible.userIds === 'all'
            ? eq(schema.memberships.organizationId, req.organizationId!)
            : and(
                eq(schema.memberships.organizationId, req.organizationId!),
                inArray(schema.memberships.userId, visible.userIds),
              );
        const employees = await tx
          .select({ id: schema.users.id, name: schema.users.displayName })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(memberScope)
          .orderBy(asc(schema.users.displayName));

        // Employees don't filter by client/project (and shouldn't see the org
        // catalog) — only managers/admins get those lists.
        if (visible.role === 'employee') {
          return { employees, clients: [], projects: [] };
        }

        const clients = await tx
          .select({ id: schema.clients.id, name: schema.clients.name })
          .from(schema.clients)
          .where(
            and(
              eq(schema.clients.organizationId, req.organizationId!),
              isNull(schema.clients.deletedAt),
            ),
          )
          .orderBy(asc(schema.clients.name));

        const projects = await tx
          .select({
            id: schema.projects.id,
            name: schema.projects.name,
            client_id: schema.projects.clientId,
          })
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.organizationId, req.organizationId!),
              isNull(schema.projects.deletedAt),
            ),
          )
          .orderBy(asc(schema.projects.name));

        return { employees, clients, projects };
      });
    },
  );

  /** Run a report. */
  app.post(
    '/reports/run',
    {
      preHandler: [requireAuth],
      schema: {
        body: ReportQuery,
        response: { 200: ReportResponse },
        tags: ['reports'],
      },
    },
    async (req) => {
      const q = req.body;
      if (q.to < q.from) forbid('Invalid range: "to" precedes "from"');

      const visible = await visibleUsers(req);
      const groupBy = q.groupBy ?? DEFAULT_GROUP_BY[q.type];

      // Resolve the user filter against the RBAC-visible set (defense in depth).
      let userFilter: string[] | 'all';
      if (visible.userIds === 'all') {
        userFilter = q.userIds && q.userIds.length > 0 ? q.userIds : 'all';
      } else {
        const allowed = new Set(visible.userIds);
        const requested = q.userIds && q.userIds.length > 0 ? q.userIds : visible.userIds;
        const filtered = requested.filter((id) => allowed.has(id));
        if (filtered.length === 0) forbid('No visible users in the requested selection');
        userFilter = filtered;
      }

      const rangeStart = localDateToUtcMs(q.from, q.tzOffsetMinutes);
      const rangeEnd = localDateToUtcMs(q.to, q.tzOffsetMinutes) + 86_400_000; // exclusive
      const now = Date.now();
      const windowEnd = Math.min(rangeEnd, now); // don't count the future

      return req.withTenantDb(async (tx) => {
        const conds = [
          eq(schema.timeEntries.organizationId, req.organizationId!),
          isNull(schema.timeEntries.deletedAt),
          // entry overlaps the range: started before rangeEnd (ended clip handled in JS)
          lt(schema.timeEntries.startedAt, new Date(rangeEnd)),
          gte(schema.timeEntries.startedAt, new Date(rangeStart - 86_400_000)), // small lead for overnight spans
        ];
        if (userFilter !== 'all') conds.push(inArray(schema.timeEntries.userId, userFilter));
        if (q.projectIds && q.projectIds.length > 0)
          conds.push(inArray(schema.timeEntries.projectId, q.projectIds));
        if (q.onlyOffline) conds.push(eq(schema.timeEntries.isManual, true));

        const rows = await tx
          .select({
            entryId: schema.timeEntries.id,
            userId: schema.timeEntries.userId,
            displayName: schema.users.displayName,
            projectId: schema.timeEntries.projectId,
            projectName: schema.projects.name,
            projectStatus: schema.projects.status,
            clientId: schema.projects.clientId,
            clientName: schema.clients.name,
            description: schema.timeEntries.description,
            startedAt: schema.timeEntries.startedAt,
            endedAt: schema.timeEntries.endedAt,
            isManual: schema.timeEntries.isManual,
          })
          .from(schema.timeEntries)
          .innerJoin(schema.users, eq(schema.users.id, schema.timeEntries.userId))
          .leftJoin(schema.projects, eq(schema.projects.id, schema.timeEntries.projectId))
          .leftJoin(schema.clients, eq(schema.clients.id, schema.projects.clientId))
          .where(and(...conds))
          .orderBy(asc(schema.timeEntries.startedAt));

        // Activity per entry: aggregate the minute-level activity_samples by
        // time_entry_id (the agent stamps it). SUM/COUNT come back as strings from
        // the pg driver, so coerce with Number().
        const actUserScope =
          userFilter === 'all' ? undefined : inArray(schema.activitySamples.userId, userFilter);
        const activityRows = await tx
          .select({
            entryId: schema.activitySamples.timeEntryId,
            activeSeconds: sql<number>`COALESCE(SUM(${schema.activitySamples.activeSeconds}), 0)`,
            idleSeconds: sql<number>`COALESCE(SUM(${schema.activitySamples.idleSeconds}), 0)`,
            scoreSum: sql<number>`COALESCE(SUM(${schema.activitySamples.activityScore}), 0)`,
            sampleCount: sql<number>`COUNT(*)`,
          })
          .from(schema.activitySamples)
          .where(
            and(
              eq(schema.activitySamples.organizationId, req.organizationId!),
              isNotNull(schema.activitySamples.timeEntryId),
              gte(schema.activitySamples.bucketMinute, new Date(rangeStart)),
              lt(schema.activitySamples.bucketMinute, new Date(windowEnd)),
              actUserScope,
            ),
          )
          .groupBy(schema.activitySamples.timeEntryId);
        const actByEntry = new Map<
          string,
          { activeSeconds: number; idleSeconds: number; scoreSum: number; sampleCount: number }
        >();
        for (const a of activityRows) {
          if (!a.entryId) continue;
          actByEntry.set(a.entryId, {
            activeSeconds: Number(a.activeSeconds),
            idleSeconds: Number(a.idleSeconds),
            scoreSum: Number(a.scoreSum),
            sampleCount: Number(a.sampleCount),
          });
        }

        const clientFilter = q.clientIds && q.clientIds.length > 0 ? new Set(q.clientIds) : null;

        // Build clipped flat entries, applying the JS-side filters.
        const flat: FlatEntry[] = [];
        for (const r of rows) {
          if (q.excludeArchived && r.projectStatus === 'archived') continue;
          if (clientFilter && !(r.clientId && clientFilter.has(r.clientId))) continue;
          if (q.noteContains && !(r.description ?? '').toLowerCase().includes(q.noteContains.toLowerCase()))
            continue;

          const start = r.startedAt.getTime();
          const end = r.endedAt ? r.endedAt.getTime() : now;
          const clippedStart = Math.max(start, rangeStart);
          const clippedEnd = Math.min(end, windowEnd);
          const seconds = overlapSeconds(start, end, rangeStart, windowEnd);
          if (seconds <= 0) continue;

          const act = actByEntry.get(r.entryId);
          flat.push({
            entryId: r.entryId,
            userId: r.userId,
            displayName: r.displayName,
            projectId: r.projectId,
            projectName: r.projectName ?? null,
            clientId: r.clientId ?? null,
            clientName: r.clientName ?? null,
            note: r.description ?? null,
            startMs: clippedStart,
            endMs: clippedEnd,
            seconds,
            isManual: r.isManual,
            activeSeconds: act?.activeSeconds ?? 0,
            idleSeconds: act?.idleSeconds ?? 0,
            scoreSum: act?.scoreSum ?? 0,
            sampleCount: act?.sampleCount ?? 0,
          });
        }

        // Daily series (bar chart).
        const dayBuckets = new Map<string, number>();
        for (const e of flat) {
          // split across day boundaries so overnight entries land on the right bars
          let cursor = e.startMs;
          while (cursor < e.endMs) {
            const day = utcMsToLocalDate(cursor, q.tzOffsetMinutes);
            const dayEnd = localDateToUtcMs(day, q.tzOffsetMinutes) + 86_400_000;
            const slice = overlapSeconds(cursor, e.endMs, cursor, dayEnd);
            dayBuckets.set(day, (dayBuckets.get(day) ?? 0) + slice);
            cursor = dayEnd;
          }
        }
        const daily = dateRange(q.from, q.to).map((date) => ({
          date,
          seconds: dayBuckets.get(date) ?? 0,
          is_weekend: isWeekendLocal(date),
        }));

        const total_seconds = flat.reduce((t, e) => t + e.seconds, 0);
        const active_seconds = flat.reduce((t, e) => t + e.activeSeconds, 0);
        const idle_seconds = flat.reduce((t, e) => t + e.idleSeconds, 0);
        const avg_activity_score = meanScore(
          flat.reduce((t, e) => t + e.scoreSum, 0),
          flat.reduce((t, e) => t + e.sampleCount, 0),
        );

        const toDetail = (e: FlatEntry): z.infer<typeof DetailRow> => ({
          entry_id: e.entryId,
          date: utcMsToLocalDate(e.startMs, q.tzOffsetMinutes),
          user_id: e.userId,
          display_name: e.displayName,
          project_id: e.projectId,
          project_name: e.projectName,
          note: e.note,
          from: new Date(e.startMs).toISOString(),
          to: new Date(e.endMs).toISOString(),
          duration_seconds: e.seconds,
          activity_score: meanScore(e.scoreSum, e.sampleCount),
          is_manual: e.isManual,
        });

        const detailedFull = q.type === 'detailed';
        const detailed = detailedFull ? flat.slice(0, DETAIL_CAP).map(toDetail) : [];
        const notes = flat
          .filter((e) => e.note && e.note.trim().length > 0)
          .slice(0, DETAIL_CAP)
          .map(toDetail);

        // Apps & URLs: aggregate capture intervals by user + range (not project/
        // note filtered — those are time-entry concepts). Clip each interval to
        // the window and sum seconds per app / domain.
        const userScope = userFilter === 'all' ? undefined : inArray(schema.appUsage.userId, userFilter);
        const appUsageRows = await tx
          .select({ key: schema.appUsage.appName, startedAt: schema.appUsage.startedAt, endedAt: schema.appUsage.endedAt })
          .from(schema.appUsage)
          .where(
            and(
              eq(schema.appUsage.organizationId, req.organizationId!),
              lt(schema.appUsage.startedAt, new Date(windowEnd)),
              gte(schema.appUsage.endedAt, new Date(rangeStart)),
              userScope,
            ),
          );
        const urlScope = userFilter === 'all' ? undefined : inArray(schema.urlUsage.userId, userFilter);
        const urlUsageRows = await tx
          .select({ key: schema.urlUsage.domain, startedAt: schema.urlUsage.startedAt, endedAt: schema.urlUsage.endedAt })
          .from(schema.urlUsage)
          .where(
            and(
              eq(schema.urlUsage.organizationId, req.organizationId!),
              lt(schema.urlUsage.startedAt, new Date(windowEnd)),
              gte(schema.urlUsage.endedAt, new Date(rangeStart)),
              urlScope,
            ),
          );
        const aggIntervals = (rows: Array<{ key: string; startedAt: Date; endedAt: Date }>) => {
          const m = new Map<string, number>();
          for (const r of rows) {
            const secs = overlapSeconds(r.startedAt.getTime(), r.endedAt.getTime(), rangeStart, windowEnd);
            if (secs > 0) m.set(r.key, (m.get(r.key) ?? 0) + secs);
          }
          return Array.from(m.entries())
            // apps/URLs have no activity concept → activity_score is always null
            .map(([key, seconds]) => ({ key, label: key, seconds, activity_score: null }))
            .sort((a, b) => b.seconds - a.seconds);
        };

        return {
          range: { from: q.from, to: q.to },
          type: q.type,
          group_by: groupBy,
          total_seconds,
          active_seconds,
          idle_seconds,
          avg_activity_score,
          daily,
          groups: q.type === 'detailed' ? [] : (buildGroups(flat, groupBy) as z.infer<typeof GroupNode>[]),
          weeks: q.type === 'weekly' ? buildWeeks(flat, q.tzOffsetMinutes) : [],
          detailed,
          detailed_truncated: detailedFull && flat.length > DETAIL_CAP,
          by_employee: pivot(flat, 'employee'),
          by_project: pivot(flat, 'project'),
          by_client: pivot(flat, 'client'),
          apps: aggIntervals(appUsageRows),
          urls: aggIntervals(urlUsageRows),
          notes,
        };
      });
    },
  );

  // ---- saved reports (5C) ----

  // Serialized builder state. Kept permissive (passthrough) so the UI can evolve
  // the builder without a migration; the run endpoint re-validates on load.
  const SavedConfig = z
    .object({
      type: z.enum(['summary', 'detailed', 'weekly']),
      preset: z.string().nullable().optional(),
      from: z.string(),
      to: z.string(),
      userIds: z.array(z.string()).optional(),
      clientIds: z.array(z.string()).optional(),
      projectIds: z.array(z.string()).optional(),
      noteContains: z.string().optional(),
      groupBy: z.array(GroupDim).optional(),
      onlyOffline: z.boolean().optional(),
      excludeArchived: z.boolean().optional(),
    })
    .passthrough();

  const SavedRow = z.object({
    id: z.string(),
    name: z.string(),
    is_shared: z.boolean(),
    owner_user_id: z.string(),
    owner_name: z.string().nullable(),
    is_mine: z.boolean(),
    config: SavedConfig,
  });

  /** List the requester's own saved reports + any shared with the org. */
  app.get(
    '/reports/saved',
    {
      preHandler: [requireAuth],
      schema: { response: { 200: z.object({ reports: z.array(SavedRow) }) }, tags: ['reports'] },
    },
    async (req) => {
      return req.withTenantDb(async (tx) => {
        const rows = await tx
          .select({
            id: schema.savedReports.id,
            name: schema.savedReports.name,
            isShared: schema.savedReports.isShared,
            ownerUserId: schema.savedReports.ownerUserId,
            ownerName: schema.users.displayName,
            config: schema.savedReports.config,
          })
          .from(schema.savedReports)
          .innerJoin(schema.users, eq(schema.users.id, schema.savedReports.ownerUserId))
          .where(
            and(
              eq(schema.savedReports.organizationId, req.organizationId!),
              isNull(schema.savedReports.deletedAt),
              or(
                eq(schema.savedReports.ownerUserId, req.userId!),
                eq(schema.savedReports.isShared, true),
              ),
            ),
          )
          .orderBy(desc(schema.savedReports.updatedAt));
        return {
          reports: rows.map((r) => ({
            id: r.id,
            name: r.name,
            is_shared: r.isShared,
            owner_user_id: r.ownerUserId,
            owner_name: r.ownerName,
            is_mine: r.ownerUserId === req.userId,
            config: r.config as z.infer<typeof SavedConfig>,
          })),
        };
      });
    },
  );

  /** Save a report config. */
  app.post(
    '/reports/saved',
    {
      preHandler: [requireAuth],
      schema: {
        body: z.object({
          name: z.string().trim().min(1).max(120),
          config: SavedConfig,
          is_shared: z.boolean().default(false),
        }),
        response: { 200: z.object({ id: z.string() }) },
        tags: ['reports'],
      },
    },
    async (req) => {
      return req.withTenantDb(async (tx) => {
        const [row] = await tx
          .insert(schema.savedReports)
          .values({
            organizationId: req.organizationId!,
            ownerUserId: req.userId!,
            name: req.body.name,
            config: req.body.config,
            isShared: req.body.is_shared,
          })
          .returning({ id: schema.savedReports.id });
        return { id: row!.id };
      });
    },
  );

  /** Delete a saved report (owner, or an admin/owner). */
  app.delete(
    '/reports/saved/:id',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['reports'],
      },
    },
    async (req) => {
      const role = await requesterRole(req);
      return req.withTenantDb(async (tx) => {
        const [existing] = await tx
          .select({ ownerUserId: schema.savedReports.ownerUserId })
          .from(schema.savedReports)
          .where(
            and(
              eq(schema.savedReports.id, req.params.id),
              eq(schema.savedReports.organizationId, req.organizationId!),
              isNull(schema.savedReports.deletedAt),
            ),
          )
          .limit(1);
        if (!existing) return { ok: true }; // already gone / not visible
        if (existing.ownerUserId !== req.userId && !isAdmin(role))
          forbid('Only the owner or an admin can delete this report');

        await tx
          .update(schema.savedReports)
          .set({ deletedAt: new Date() })
          .where(eq(schema.savedReports.id, req.params.id));
        return { ok: true };
      });
    },
  );
};
