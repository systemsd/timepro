import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { asPlatform, getDb, schema } from '@timepro/db';
import { loadConfig } from '../config';

/**
 * OpsCore-facing reporting API — the reverse direction of the directory sync.
 *
 * OpsCore is the source of truth for the task board; TimePro is the source of
 * truth for *tracked time*. This route lets OpsCore pull tracked time back —
 * per TASK (task cards show "time spent" + a feed) and per EMPLOYEE (a manager
 * reviewing someone in their reporting line) — without TimePro ever writing
 * task state.
 *
 * NOTE both reads are unfiltered by design: TimePro has no way to evaluate
 * OpsCore's reporting hierarchy, so OPSCORE decides who may see whose time
 * before it calls. This endpoint is reachable only with the shared service key,
 * never from a browser.
 *
 * Auth is the **same shared service key** the directory sync already uses (OpsCore
 * calls it `TIMEPRO_API_KEY`; here it's `OPSCORE_API_KEY` — same value both sides).
 * There is no user session — the caller is OpsCore's server, so we resolve the
 * OpsCore org by slug (`OPSCORE_ORG_SLUG`) and read cross-tenant via `asPlatform`.
 * Single-tenant Systemsd today, so exactly one org matches.
 */

const EntrySchema = z.object({
  id: z.string(),
  opscore_employee_id: z.string().nullable(),
  user_name: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  is_running: z.boolean(),
  seconds: z.number().int().nonnegative(),
  description: z.string().nullable(),
  source: z.string(),
});

const TaskSummarySchema = z.object({
  opscore_task_id: z.string(),
  total_seconds: z.number().int().nonnegative(),
  entry_count: z.number().int().nonnegative(),
  entries: z.array(EntrySchema),
});

const ResponseSchema = z.object({ tasks: z.array(TaskSummarySchema) });

/**
 * Employee-scoped entries carry where the time went (project/task), which the
 * task-scoped feed doesn't need — on a person's page that context IS the point.
 */
const EmployeeEntrySchema = EntrySchema.extend({
  project_name: z.string().nullable(),
  task_name: z.string().nullable(),
  opscore_task_id: z.string().nullable(),
});

const EmployeeSummarySchema = z.object({
  opscore_employee_id: z.string(),
  user_name: z.string().nullable(),
  total_seconds: z.number().int().nonnegative(),
  entry_count: z.number().int().nonnegative(),
  entries: z.array(EmployeeEntrySchema),
});

const EmployeeResponseSchema = z.object({ employees: z.array(EmployeeSummarySchema) });

// Cap the returned entry list per task so a heavily-tracked task can't return
// thousands of rows. `total_seconds` / `entry_count` are computed over ALL
// non-deleted entries, not just the returned page.
const MAX_ENTRIES_PER_TASK = 500;
/** Same idea per employee — a month of dense tracking is well under this. */
const MAX_ENTRIES_PER_EMPLOYEE = 500;
/** Employees per request. OpsCore asks for one resource at a time today. */
const MAX_EMPLOYEES_PER_REQUEST = 100;

/** Bearer check against the shared OpsCore↔TimePro service key (constant-time). */
function isAuthorizedOpsCoreRequest(req: { headers: Record<string, unknown> }): boolean {
  const expected = loadConfig().OPSCORE_API_KEY;
  if (!expected) return false;
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = header.slice('Bearer '.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function entrySeconds(startedAt: Date, endedAt: Date | null, now: number): number {
  const end = endedAt ? endedAt.getTime() : now;
  return Math.max(0, Math.floor((end - startedAt.getTime()) / 1000));
}

export const opscoreRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Per-task tracked-time summary for OpsCore's task board.
   *   ?opscore_task_ids=cuid1,cuid2,…  (1..200 OpsCore Task ids)
   * Returns one summary per requested id that has a mirrored task locally;
   * ids with no local task / no tracked time simply don't appear.
   */
  app.get(
    '/opscore/tasks/time-summary',
    {
      schema: {
        querystring: z.object({
          opscore_task_ids: z
            .string()
            .min(1)
            .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
        }),
        response: { 200: ResponseSchema, 401: z.object({ error: z.string() }) },
        tags: ['opscore'],
      },
    },
    async (req, reply) => {
      if (!isAuthorizedOpsCoreRequest(req)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const ids = Array.from(new Set(req.query.opscore_task_ids)).slice(0, 200);
      if (ids.length === 0) return { tasks: [] };

      const slug = loadConfig().OPSCORE_ORG_SLUG;
      const now = Date.now();

      return asPlatform(async (tx) => {
        const [org] = await tx
          .select({ id: schema.organizations.id })
          .from(schema.organizations)
          .where(eq(schema.organizations.slug, slug))
          .limit(1);
        // Org not provisioned yet (no OpsCore login has happened) → nothing tracked.
        if (!org) return { tasks: [] };

        // Local tasks mirrored from the requested OpsCore ids (incl. inactive/CLOSED —
        // historical time is still valid and worth showing).
        const localTasks = await tx
          .select({ id: schema.tasks.id, opscoreTaskId: schema.tasks.opscoreTaskId })
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.organizationId, org.id),
              inArray(schema.tasks.opscoreTaskId, ids),
            ),
          );
        if (localTasks.length === 0) return { tasks: [] };

        const opsByLocal = new Map(localTasks.map((t) => [t.id, t.opscoreTaskId]));
        const localIds = localTasks.map((t) => t.id);

        // All non-deleted time entries for those tasks, newest first, with the
        // tracker's OpsCore identity + display name.
        const rows = await tx
          .select({
            id: schema.timeEntries.id,
            taskId: schema.timeEntries.taskId,
            startedAt: schema.timeEntries.startedAt,
            endedAt: schema.timeEntries.endedAt,
            description: schema.timeEntries.description,
            source: schema.timeEntries.source,
            opscoreEmployeeId: schema.users.opscoreEmployeeId,
            userName: schema.users.displayName,
          })
          .from(schema.timeEntries)
          .leftJoin(schema.users, eq(schema.users.id, schema.timeEntries.userId))
          .where(
            and(
              eq(schema.timeEntries.organizationId, org.id),
              inArray(schema.timeEntries.taskId, localIds),
              isNull(schema.timeEntries.deletedAt),
            ),
          )
          .orderBy(desc(schema.timeEntries.startedAt));

        // Group by OpsCore task id: full totals over every entry, capped list.
        const byOps = new Map<
          string,
          { total: number; count: number; entries: z.infer<typeof EntrySchema>[] }
        >();
        for (const t of localTasks) {
          byOps.set(t.opscoreTaskId, { total: 0, count: 0, entries: [] });
        }
        for (const r of rows) {
          const opsId = r.taskId ? opsByLocal.get(r.taskId) : undefined;
          if (!opsId) continue;
          const bucket = byOps.get(opsId)!;
          const secs = entrySeconds(r.startedAt, r.endedAt, now);
          bucket.total += secs;
          bucket.count += 1;
          if (bucket.entries.length < MAX_ENTRIES_PER_TASK) {
            bucket.entries.push({
              id: r.id,
              opscore_employee_id: r.opscoreEmployeeId ?? null,
              user_name: r.userName ?? null,
              started_at: r.startedAt.toISOString(),
              ended_at: r.endedAt ? r.endedAt.toISOString() : null,
              is_running: r.endedAt === null,
              seconds: secs,
              description: r.description ?? null,
              source: r.source,
            });
          }
        }

        return {
          tasks: Array.from(byOps.entries())
            // Only surface tasks that actually have tracked time.
            .filter(([, v]) => v.count > 0)
            .map(([opscore_task_id, v]) => ({
              opscore_task_id,
              total_seconds: v.total,
              entry_count: v.count,
              entries: v.entries,
            })),
        };
      }, getDb());
    },
  );

  /**
   * Per-EMPLOYEE tracked-time activity, for OpsCore's resource detail page.
   *   ?opscore_employee_ids=cuid1,cuid2,…   (1..100 OpsCore Employee ids)
   *   &from=ISO  (optional, inclusive)
   *   &to=ISO    (optional, exclusive)
   *
   * Returns one summary per requested id that has a synced TimePro user AND
   * tracked time in the window; ids with neither simply don't appear (so an
   * employee who has never tracked is "no data", not an error). Totals and
   * `entry_count` cover every non-deleted entry in the window; `entries` is
   * capped at MAX_ENTRIES_PER_EMPLOYEE, newest first.
   *
   * A running entry counts up to now, matching the task feed.
   */
  app.get(
    '/opscore/employees/time-activity',
    {
      schema: {
        querystring: z.object({
          opscore_employee_ids: z
            .string()
            .min(1)
            .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        }),
        response: { 200: EmployeeResponseSchema, 401: z.object({ error: z.string() }) },
        tags: ['opscore'],
      },
    },
    async (req, reply) => {
      if (!isAuthorizedOpsCoreRequest(req)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const ids = Array.from(new Set(req.query.opscore_employee_ids)).slice(
        0,
        MAX_EMPLOYEES_PER_REQUEST,
      );
      if (ids.length === 0) return { employees: [] };

      const from = req.query.from ? new Date(req.query.from) : null;
      const to = req.query.to ? new Date(req.query.to) : null;

      const slug = loadConfig().OPSCORE_ORG_SLUG;
      const now = Date.now();

      return asPlatform(async (tx) => {
        const [org] = await tx
          .select({ id: schema.organizations.id })
          .from(schema.organizations)
          .where(eq(schema.organizations.slug, slug))
          .limit(1);
        // Org not provisioned yet (no OpsCore login has happened) → nothing tracked.
        if (!org) return { employees: [] };

        // The TimePro users mirroring the requested OpsCore employees. Someone
        // who has never signed into TimePro has no row here.
        const localUsers = await tx
          .select({
            id: schema.users.id,
            opscoreEmployeeId: schema.users.opscoreEmployeeId,
            displayName: schema.users.displayName,
          })
          .from(schema.users)
          .where(inArray(schema.users.opscoreEmployeeId, ids));
        if (localUsers.length === 0) return { employees: [] };

        const opsByUser = new Map(
          localUsers.map((u) => [u.id, u.opscoreEmployeeId as string]),
        );
        const nameByOps = new Map(
          localUsers.map((u) => [u.opscoreEmployeeId as string, u.displayName]),
        );

        const where = [
          eq(schema.timeEntries.organizationId, org.id),
          inArray(schema.timeEntries.userId, Array.from(opsByUser.keys())),
          isNull(schema.timeEntries.deletedAt),
        ];
        // Window on started_at — the (org, user, started_at desc) index covers it.
        if (from) where.push(gte(schema.timeEntries.startedAt, from));
        if (to) where.push(lt(schema.timeEntries.startedAt, to));

        const rows = await tx
          .select({
            id: schema.timeEntries.id,
            userId: schema.timeEntries.userId,
            startedAt: schema.timeEntries.startedAt,
            endedAt: schema.timeEntries.endedAt,
            description: schema.timeEntries.description,
            source: schema.timeEntries.source,
            projectName: schema.projects.name,
            taskName: schema.tasks.name,
            opscoreTaskId: schema.tasks.opscoreTaskId,
          })
          .from(schema.timeEntries)
          .leftJoin(schema.projects, eq(schema.projects.id, schema.timeEntries.projectId))
          .leftJoin(schema.tasks, eq(schema.tasks.id, schema.timeEntries.taskId))
          .where(and(...where))
          .orderBy(desc(schema.timeEntries.startedAt));

        const byOps = new Map<
          string,
          { total: number; count: number; entries: z.infer<typeof EmployeeEntrySchema>[] }
        >();
        for (const opsId of ids) byOps.set(opsId, { total: 0, count: 0, entries: [] });

        for (const r of rows) {
          const opsId = opsByUser.get(r.userId);
          if (!opsId) continue;
          const bucket = byOps.get(opsId);
          if (!bucket) continue;
          const secs = entrySeconds(r.startedAt, r.endedAt, now);
          bucket.total += secs;
          bucket.count += 1;
          if (bucket.entries.length < MAX_ENTRIES_PER_EMPLOYEE) {
            bucket.entries.push({
              id: r.id,
              opscore_employee_id: opsId,
              user_name: nameByOps.get(opsId) ?? null,
              started_at: r.startedAt.toISOString(),
              ended_at: r.endedAt ? r.endedAt.toISOString() : null,
              is_running: r.endedAt === null,
              seconds: secs,
              description: r.description ?? null,
              source: r.source,
              project_name: r.projectName ?? null,
              task_name: r.taskName ?? null,
              opscore_task_id: r.opscoreTaskId ?? null,
            });
          }
        }

        return {
          employees: Array.from(byOps.entries())
            // Only surface employees who actually tracked time in the window.
            .filter(([, v]) => v.count > 0)
            .map(([opscore_employee_id, v]) => ({
              opscore_employee_id,
              user_name: nameByOps.get(opscore_employee_id) ?? null,
              total_seconds: v.total,
              entry_count: v.count,
              entries: v.entries,
            })),
        };
      }, getDb());
    },
  );
};
