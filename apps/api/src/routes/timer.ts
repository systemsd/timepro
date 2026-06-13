import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@trackflow/db';
import { requireAuth } from '../plugins/tenant';

const StartBody = z.object({
  project_id: z.string().uuid().optional(),
  task_id: z.string().uuid().optional(),
  description: z.string().max(500).optional(),
  client_event_id: z.string().min(8).max(128),
  source: z.enum(['desktop', 'web', 'mobile']).default('desktop'),
});

const StopBody = z.object({
  client_event_id: z.string().min(8).max(128),
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
        // Idempotent: if a timer is already running for this user, return it.
        const running = await tx
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

        if (running.length > 0) {
          const r = running[0]!;
          return {
            id: r.id,
            project_id: r.projectId ?? null,
            started_at: r.startedAt.toISOString(),
            description: r.description ?? null,
          };
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
        const [updated] = await tx
          .update(schema.timeEntries)
          .set({ endedAt: new Date() })
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              eq(schema.timeEntries.userId, req.userId!),
              isNull(schema.timeEntries.endedAt),
            ),
          )
          .returning();

        if (!updated) {
          // Thrown errors are converted to RFC 9457 by `error-mapper.ts`.
          throw Object.assign(new Error(`No active timer for client_event_id=${body.client_event_id}`), {
            statusCode: 404,
            code: 'no_running_timer',
          });
        }

        return {
          id: updated.id,
          project_id: updated.projectId ?? null,
          started_at: updated.startedAt.toISOString(),
          ended_at: updated.endedAt!.toISOString(),
          description: updated.description ?? null,
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
