import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { asPlatform, getDb, schema } from '@timepro/db';
import { loadConfig } from '../config';

/**
 * OpsCore-facing reporting API — the reverse direction of the directory sync.
 *
 * OpsCore is the source of truth for the task board; TimePro is the source of
 * truth for *tracked time*. This route lets OpsCore pull a task's tracked time
 * back so its task cards can show "time spent" + a time-activity feed, without
 * TimePro ever writing task state.
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

// Cap the returned entry list per task so a heavily-tracked task can't return
// thousands of rows. `total_seconds` / `entry_count` are computed over ALL
// non-deleted entries, not just the returned page.
const MAX_ENTRIES_PER_TASK = 500;

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
};
