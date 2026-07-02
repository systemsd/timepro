import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';

const ZERO_DEVICE = '00000000-0000-0000-0000-000000000000';

/** Keep the first row per key (drops in-batch duplicates before insert). */
export function dedupeBy<T>(rows: T[], keyOf: (r: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

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
        // Idempotent (matches app_usage_natural_uniq): dedupe within the batch,
        // then ignore any interval already stored from an earlier retry.
        const deduped = dedupeBy(rows, (r) => `${r.startedAt.getTime()}|${r.appName}`);
        await tx.insert(schema.appUsage).values(deduped).onConflictDoNothing();
        return { accepted: req.body.events.length };
      });
    },
  );

  // Browser URL intervals (B5) — posted by the browser extension.
  app.post(
    '/ingest/url-usage',
    {
      preHandler: [requireAuth],
      schema: {
        body: z.object({
          events: z.array(
            z.object({
              browser: z.string().min(1).max(64),
              domain: z.string().min(1).max(256),
              url: z.string().max(2048).nullish(),
              page_title: z.string().max(512).nullish(),
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
          browser: e.browser,
          domain: e.domain,
          url: e.url ?? null,
          pageTitle: e.page_title ?? null,
          startedAt: new Date(e.started_at),
          endedAt: new Date(e.ended_at),
        }));
        // Idempotent (matches url_usage_natural_uniq): dedupe within the batch,
        // then ignore any interval already stored from an earlier retry.
        const deduped = dedupeBy(rows, (r) => `${r.startedAt.getTime()}|${r.domain}|${r.browser}`);
        await tx.insert(schema.urlUsage).values(deduped).onConflictDoNothing();
        return { accepted: req.body.events.length };
      });
    },
  );

  // Desktop-agent diagnostic logs (lifecycle + warnings/errors) — batched by the
  // agent for remote debugging via the admin API. Best-effort, low volume.
  app.post(
    '/ingest/agent-logs',
    {
      preHandler: [requireAuth],
      schema: {
        body: z.object({
          device_id: z.string().max(128).nullish(),
          agent_version: z.string().max(64).nullish(),
          os: z.string().max(64).nullish(),
          events: z
            .array(
              z.object({
                ts: z.string().datetime({ offset: true }),
                level: z.enum(['info', 'warn', 'error']),
                event: z.string().max(256),
                message: z.string().max(4000).default(''),
                fields: z.record(z.unknown()).default({}),
              }),
            )
            .max(500),
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
          deviceId: req.body.device_id ?? null,
          agentVersion: req.body.agent_version ?? null,
          os: req.body.os ?? null,
          ts: new Date(e.ts),
          level: e.level,
          event: e.event,
          message: e.message ?? '',
          fields: e.fields ?? {},
        }));
        await tx.insert(schema.agentLogs).values(rows);
        return { accepted: rows.length };
      });
    },
  );
};
