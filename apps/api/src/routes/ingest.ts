import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';

const ZERO_DEVICE = '00000000-0000-0000-0000-000000000000';

/**
 * High-volume capture ingest from the desktop agent (B4/B5).
 * Idempotent — duplicate buckets/events are ignored.
 */
export const ingestRoutes: FastifyPluginAsyncZod = async (app) => {
  // Per-minute activity samples (B4).
  app.post(
    '/ingest/activity',
    {
      preHandler: [requireAuth],
      schema: {
        body: z.object({
          samples: z.array(
            z.object({
              bucket_minute: z.string().datetime({ offset: true }),
              time_entry_id: z.string().uuid().nullish(),
              keyboard_events: z.number().int().min(0).default(0),
              mouse_events: z.number().int().min(0).default(0),
              active_seconds: z.number().int().min(0).max(60),
              idle_seconds: z.number().int().min(0).max(60),
              activity_score: z.number().int().min(0).max(100),
            }),
          ).max(500),
        }),
        response: { 200: z.object({ accepted: z.number() }) },
        tags: ['ingest'],
      },
    },
    async (req) => {
      if (req.body.samples.length === 0) return { accepted: 0 };
      return req.withTenantDb(async (tx) => {
        const rows = req.body.samples.map((s) => ({
          organizationId: req.organizationId!,
          userId: req.userId!,
          deviceId: ZERO_DEVICE,
          timeEntryId: s.time_entry_id ?? null,
          bucketMinute: new Date(s.bucket_minute),
          keyboardEvents: s.keyboard_events,
          mouseEvents: s.mouse_events,
          activeSeconds: s.active_seconds,
          idleSeconds: s.idle_seconds,
          activityScore: s.activity_score,
        }));
        await tx.insert(schema.activitySamples).values(rows).onConflictDoNothing();
        return { accepted: rows.length };
      });
    },
  );

  // App usage intervals (B5).
  app.post(
    '/ingest/app-usage',
    {
      preHandler: [requireAuth],
      schema: {
        body: z.object({
          events: z.array(
            z.object({
              app_name: z.string().min(1).max(256),
              window_title: z.string().max(256).nullish(),
              started_at: z.string().datetime({ offset: true }),
              ended_at: z.string().datetime({ offset: true }),
              time_entry_id: z.string().uuid().nullish(),
            }),
          ).max(500),
        }),
        response: { 200: z.object({ accepted: z.number() }) },
        tags: ['ingest'],
      },
    },
    async (req) => {
      if (req.body.events.length === 0) return { accepted: 0 };
      return req.withTenantDb(async (tx) => {
        const rows = req.body.events.map((e) => ({
          organizationId: req.organizationId!,
          userId: req.userId!,
          deviceId: ZERO_DEVICE,
          timeEntryId: e.time_entry_id ?? null,
          appName: e.app_name,
          windowTitle: e.window_title ?? null,
          startedAt: new Date(e.started_at),
          endedAt: new Date(e.ended_at),
        }));
        await tx.insert(schema.appUsage).values(rows);
        return { accepted: rows.length };
      });
    },
  );
};
