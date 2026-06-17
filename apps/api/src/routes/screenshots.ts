import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { canView, forbid, isAdmin, requesterRole, visibleUsers } from '../lib/access';
import { getEffectiveForUser } from '../lib/settings';
import { loadConfig } from '../config';

const ScreenshotResponse = z.object({
  id: z.string().uuid(),
  captured_at: z.string(),
  bytes: z.number(),
  local_path: z.string(),
});

/**
 * MVP screenshot ingest. The agent posts multipart:
 *   - field `meta` (JSON string): { client_event_id, captured_at, time_entry_id?, monitor_index, width, height }
 *   - field `image` (file): PNG (or anything; we save raw bytes)
 *
 * We write the file to STORAGE_DIR/{org_id}/{yyyy-mm-dd}/{id}.png and store
 * that path in `s3_key`. When the S3 driver lands, we'll switch the writer
 * and stop using s3_key for local paths.
 */
const MetaSchema = z.object({
  client_event_id: z.string().min(8).max(128),
  // Accept both `…Z` and `…+00:00` RFC-3339 forms (the Rust agent sends an offset).
  captured_at: z.string().datetime({ offset: true }).optional(),
  time_entry_id: z.string().uuid().nullish(),
  monitor_index: z.number().int().min(0).max(15).default(0),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const screenshotRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/screenshots',
    {
      preHandler: [requireAuth],
      schema: {
        response: { 200: ScreenshotResponse },
        tags: ['screenshots'],
        consumes: ['multipart/form-data'],
      },
    },
    async (req) => {
      const parts = req.parts();

      let meta: z.infer<typeof MetaSchema> | null = null;
      let imageBytes: Buffer | null = null;

      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'meta') {
          // fastify-multipart auto-parses application/json fields into objects;
          // raw text/form fields arrive as strings. Accept either.
          const raw =
            typeof part.value === 'string'
              ? JSON.parse(part.value)
              : (part.value as unknown);
          meta = MetaSchema.parse(raw);
        } else if (part.type === 'file' && part.fieldname === 'image') {
          imageBytes = await part.toBuffer();
        }
      }

      if (!meta) {
        throw Object.assign(new Error('missing meta field'), {
          statusCode: 422,
          code: 'missing_meta',
        });
      }
      if (!imageBytes) {
        throw Object.assign(new Error('missing image file'), {
          statusCode: 422,
          code: 'missing_image',
        });
      }

      const capturedAt = meta.captured_at ? new Date(meta.captured_at) : new Date();
      const day = capturedAt.toISOString().slice(0, 10);
      const config = loadConfig();
      const orgDir = resolve(config.STORAGE_DIR, req.organizationId!, day);
      await mkdir(orgDir, { recursive: true });

      return req.withTenantDb(async (tx) => {
        const [row] = await tx
          .insert(schema.screenshots)
          .values({
            organizationId: req.organizationId!,
            userId: req.userId!,
            deviceId: '00000000-0000-0000-0000-000000000000',
            timeEntryId: meta.time_entry_id ?? null,
            capturedAt,
            monitorIndex: meta.monitor_index,
            width: meta.width ?? null,
            height: meta.height ?? null,
            s3Key: '',                  // placeholder; we update after the write
            bytes: imageBytes!.byteLength,
            clientEventId: meta.client_event_id,
            status: 'pending',
          })
          .returning();

        const fullPath = join(orgDir, `${row!.id}.png`);
        await writeFile(fullPath, imageBytes!);

        const [updated] = await tx
          .update(schema.screenshots)
          .set({ s3Key: fullPath })
          .where(eq(schema.screenshots.id, row!.id))
          .returning();

        return {
          id: updated!.id,
          captured_at: updated!.capturedAt.toISOString(),
          bytes: updated!.bytes ?? imageBytes!.byteLength,
          local_path: fullPath,
        };
      });
    },
  );

  // List recent screenshots (metadata only) for the dashboard gallery.
  app.get(
    '/screenshots',
    {
      preHandler: [requireAuth],
      schema: {
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(24) }),
        response: {
          200: z.object({
            screenshots: z.array(
              z.object({
                id: z.string(),
                captured_at: z.string(),
                width: z.number().nullable(),
                height: z.number().nullable(),
                status: z.string(),
              }),
            ),
          }),
        },
        tags: ['screenshots'],
      },
    },
    async (req) => {
      return req.withTenantDb(async (tx) => {
        const rows = await tx
          .select({
            id: schema.screenshots.id,
            capturedAt: schema.screenshots.capturedAt,
            width: schema.screenshots.width,
            height: schema.screenshots.height,
            status: schema.screenshots.status,
          })
          .from(schema.screenshots)
          .where(
            and(
              eq(schema.screenshots.organizationId, req.organizationId!),
              eq(schema.screenshots.userId, req.userId!),
            ),
          )
          .orderBy(desc(schema.screenshots.capturedAt))
          .limit(req.query.limit);

        return {
          screenshots: rows.map((r) => ({
            id: r.id,
            captured_at: r.capturedAt.toISOString(),
            width: r.width,
            height: r.height,
            status: r.status,
          })),
        };
      });
    },
  );

  // Stream the raw image bytes. MVP reads from the local filesystem path
  // stored in s3_key; the S3 driver later swaps this for a signed-URL redirect.
  app.get(
    '/screenshots/:id/raw',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        tags: ['screenshots'],
      },
    },
    async (req, reply) => {
      const row = await req.withTenantDb(async (tx) => {
        const [r] = await tx
          .select({ s3Key: schema.screenshots.s3Key })
          .from(schema.screenshots)
          .where(
            and(
              eq(schema.screenshots.organizationId, req.organizationId!),
              eq(schema.screenshots.id, req.params.id),
            ),
          )
          .limit(1);
        return r ?? null;
      });

      if (!row || !row.s3Key) {
        throw Object.assign(new Error('screenshot not found'), {
          statusCode: 404,
          code: 'not_found',
        });
      }

      reply.header('Content-Type', 'image/png');
      reply.header('Cache-Control', 'private, max-age=300');
      return reply.send(createReadStream(row.s3Key));
    },
  );

  // Delete a screenshot (row + file). Admins/managers may delete any screenshot
  // of someone they can view; employees may delete their own only when the
  // `screenshots.allow_self_delete` policy is on (C9, default off).
  app.delete(
    '/screenshots/:id',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['screenshots'],
      },
    },
    async (req) => {
      const visible = await visibleUsers(req);
      const role = await requesterRole(req);
      return req.withTenantDb(async (tx) => {
        const [shot] = await tx
          .select({ userId: schema.screenshots.userId, s3Key: schema.screenshots.s3Key })
          .from(schema.screenshots)
          .where(
            and(
              eq(schema.screenshots.organizationId, req.organizationId!),
              eq(schema.screenshots.id, req.params.id),
            ),
          )
          .limit(1);
        if (!shot) {
          throw Object.assign(new Error('screenshot not found'), { statusCode: 404, code: 'not_found' });
        }
        if (!canView(visible, shot.userId)) forbid('Not allowed to delete this screenshot');
        // Employee self-delete is gated by org/user policy; admins & managers always may.
        if (!isAdmin(role) && role !== 'manager') {
          const { effective } = await getEffectiveForUser(tx, req.organizationId!, req.userId!);
          if (!effective['screenshots.allow_self_delete']) {
            forbid('Deleting your own screenshots is disabled by your team settings');
          }
        }
        await tx
          .delete(schema.screenshots)
          .where(
            and(
              eq(schema.screenshots.organizationId, req.organizationId!),
              eq(schema.screenshots.id, req.params.id),
            ),
          );
        if (shot.s3Key) {
          try { await unlink(shot.s3Key); } catch { /* file may already be gone */ }
        }
        return { ok: true };
      });
    },
  );
};
