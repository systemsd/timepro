import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { mondayWeekStartMs, resolveWeeklyLimitHours, weeklyTrackedSeconds } from '../lib/limits';
import { getCurrentTimer } from '../repositories/time-entries';

const StartBody = z.object({
  project_id: z.string().uuid().optional(),
  task_id: z.string().uuid().optional(),
  description: z.string().max(500).optional(),
  client_event_id: z.string().min(8).max(128),
  source: z.enum(['desktop', 'web', 'mobile']).default('desktop'),
  tz_offset_minutes: z.number().default(0),
});

const StopBody = z.object({
  client_event_id: z.string().min(8).max(128),
  // Optional client-supplied end time (ISO 8601). The desktop agent back-dates
  // the stop to the last active moment when it detects the machine slept or the
  // user went idle, so the suspend/idle window isn't billed. Clamped
  // server-side to [started_at, now] — never trust a raw client timestamp.
  ended_at: z.string().datetime({ offset: true }).optional(),
});

const TimerSnapshot = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  started_at: z.string(),
  description: z.string().nullable(),
});

const StoppedSnapshot = TimerSnapshot.extend({ ended_at: z.string() });

/**
 * MVP timer endpoints. Full validation (overlap detection, daily/weekly
 * caps, settings-driven gates) lands as the timer service grows.
 *
 * Business logic moves into `services/timer.ts` once handlers exceed ~30 lines.
 */
export const timerRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/timer/start',
    {
      preHandler: [requireAuth],
      schema: {
        body: StartBody,
        response: { 200: TimerSnapshot },
        tags: ['timer'],
      },
    },
    async (req) => {
      const body = req.body;
      return req.withTenantDb(async (tx) => {
        // Serialize concurrent starts for this user so the check-then-insert below
        // is race-free (double-click / two devices / offline replay carry different
        // client_event_ids, so the unique key can't dedupe them). Transaction-scoped
        // advisory lock → auto-released on commit/rollback, pool-safe. Two-arg
        // hashtext keys on (org, user); a hash collision only serializes briefly and
        // never affects correctness (the real (org,user) re-check does that).
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${req.organizationId!}), hashtext(${req.userId!}))`,
        );

        // Idempotent: if a timer is already running for this user, return it.
        const running = await getCurrentTimer(tx, req.organizationId!, req.userId!);
        if (running) {
          return {
            id: running.id,
            project_id: running.projectId ?? null,
            started_at: running.startedAt.toISOString(),
            description: running.description ?? null,
          };
        }

        // Weekly-limit enforcement (B7): refuse to start a new timer once the
        // user is at/over their effective weekly cap (0 = unlimited).
        const limits = await resolveWeeklyLimitHours(tx, req.organizationId!, [req.userId!]);
        const limitHours = limits.get(req.userId!) ?? 0;
        if (limitHours > 0) {
          const now = Date.now();
          const weekStart = mondayWeekStartMs(body.tz_offset_minutes, now);
          const used = await weeklyTrackedSeconds(tx, req.organizationId!, req.userId!, weekStart, now);
          if (used >= limitHours * 3600) {
            throw Object.assign(
              new Error(`Weekly time limit of ${limitHours}h reached`),
              { statusCode: 409, code: 'weekly_limit_reached' },
            );
          }
        }

        const [inserted] = await tx
          .insert(schema.timeEntries)
          .values({
            organizationId: req.organizationId!,
            userId: req.userId!,
            projectId: body.project_id ?? null,
            taskId: body.task_id ?? null,
            startedAt: new Date(),
            source: body.source,
            description: body.description ?? null,
            clientEventId: body.client_event_id,
          })
          .returning();

        return {
          id: inserted!.id,
          project_id: inserted!.projectId ?? null,
          started_at: inserted!.startedAt.toISOString(),
          description: inserted!.description ?? null,
        };
      });
    },
  );

  app.post(
    '/timer/stop',
    {
      preHandler: [requireAuth],
      schema: {
        body: StopBody,
        response: { 200: StoppedSnapshot },
        tags: ['timer'],
      },
    },
    async (req) => {
      const body = req.body;
      return req.withTenantDb(async (tx) => {
        // Fetch the running entry first so a client-supplied `ended_at` can be
        // clamped against its start (the agent back-dates the stop on sleep/idle).
        const [running] = await tx
          .select()
          .from(schema.timeEntries)
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              eq(schema.timeEntries.userId, req.userId!),
              isNull(schema.timeEntries.endedAt),
            ),
          )
          .limit(1);

        if (!running) {
          // Thrown errors are converted to RFC 9457 by `error-mapper.ts`.
          throw Object.assign(new Error(`No active timer for client_event_id=${body.client_event_id}`), {
            statusCode: 404,
            code: 'no_running_timer',
          });
        }

        // Clamp any back-dated end time to [started_at, now]; default to now.
        const now = new Date();
        let endedAt = now;
        if (body.ended_at) {
          const requested = new Date(body.ended_at).getTime();
          endedAt = new Date(Math.min(Math.max(requested, running.startedAt.getTime()), now.getTime()));
        }

        await tx
          .update(schema.timeEntries)
          .set({ endedAt })
          .where(eq(schema.timeEntries.id, running.id));

        return {
          id: running.id,
          project_id: running.projectId ?? null,
          started_at: running.startedAt.toISOString(),
          ended_at: endedAt.toISOString(),
          description: running.description ?? null,
        };
      });
    },
  );

  app.get(
    '/timer/current',
    {
      preHandler: [requireAuth],
      schema: {
        response: { 200: TimerSnapshot.nullable() },
        tags: ['timer'],
      },
    },
    async (req) => {
      return req.withTenantDb(async (tx) => {
        const running = await getCurrentTimer(tx, req.organizationId!, req.userId!);
        if (!running) return null;
        return {
          id: running.id,
          project_id: running.projectId ?? null,
          started_at: running.startedAt.toISOString(),
          description: running.description ?? null,
        };
      });
    },
  );
};
