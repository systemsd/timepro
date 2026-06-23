import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, asc, eq, gte } from 'drizzle-orm';
import { schema, type DB } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { canView, forbid, isAdmin, visibleUsers, type VisibleUsers } from '../lib/access';
import { getEffectiveForUser } from '../lib/settings';
import { recordAudit } from '../lib/audit';

/**
 * Editable timeline activities (the scrin.io "Edit Time" modal): change a time
 * entry's project/description, trim its start/end, split it into two, or delete
 * it. Every mutation is authorized and written to `audit_logs` (Level-2 audit).
 *
 * Authorization mirrors the screenshot-delete pattern (C1 + a settings gate):
 *   admin/owner → any entry they can view
 *   manager     → their team's entries
 *   employee    → own entries, only when `time.allow_self_edit` is on
 */

const ActivityResponse = z.object({
  id: z.string(),
  user_id: z.string(),
  project_id: z.string().nullable(),
  description: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  source: z.string(),
  is_manual: z.boolean(),
});

type EntryRow = typeof schema.timeEntries.$inferSelect;

const mapEntry = (e: EntryRow) => ({
  id: e.id,
  user_id: e.userId,
  project_id: e.projectId ?? null,
  description: e.description ?? null,
  started_at: e.startedAt.toISOString(),
  ended_at: e.endedAt ? e.endedAt.toISOString() : null,
  source: e.source,
  is_manual: e.isManual,
});

/** Load an org-scoped entry or throw 404. By default excludes soft-deleted rows. */
async function loadEntry(
  tx: DB,
  orgId: string,
  id: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<EntryRow> {
  const [row] = await tx
    .select()
    .from(schema.timeEntries)
    .where(and(eq(schema.timeEntries.organizationId, orgId), eq(schema.timeEntries.id, id)))
    .limit(1);
  if (!row || (!opts.includeDeleted && row.deletedAt)) {
    throw Object.assign(new Error('time entry not found'), { statusCode: 404, code: 'not_found' });
  }
  return row;
}

/**
 * Authorize a write against the entry's owner. `visible` is resolved once by the
 * caller (outside the tenant tx); the settings gate is checked on `tx`.
 */
async function authorizeWrite(
  tx: DB,
  orgId: string,
  requesterId: string,
  visible: VisibleUsers,
  targetUserId: string,
): Promise<void> {
  if (!canView(visible, targetUserId)) forbid('Not allowed to edit this time entry');
  // Admins and managers may always edit within their visible set; an employee
  // editing their own time is gated by the org/user policy (default on).
  if (!isAdmin(visible.role) && visible.role !== 'manager') {
    const { effective } = await getEffectiveForUser(tx, orgId, requesterId);
    if (!effective['time.allow_self_edit']) {
      forbid('Editing your own time entries is disabled by your team settings');
    }
  }
}

/** A project must be active and assigned to the entry's owner to be selectable. */
async function assertProjectAssignable(
  tx: DB,
  orgId: string,
  projectId: string,
  ownerUserId: string,
): Promise<void> {
  const [ok] = await tx
    .select({ id: schema.projectMembers.projectId })
    .from(schema.projectMembers)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectMembers.projectId))
    .where(
      and(
        eq(schema.projectMembers.projectId, projectId),
        eq(schema.projectMembers.userId, ownerUserId),
        eq(schema.projects.organizationId, orgId),
        eq(schema.projects.status, 'active'),
      ),
    )
    .limit(1);
  if (!ok) {
    throw Object.assign(new Error('project is not assignable to this user'), {
      statusCode: 422,
      code: 'invalid_project',
    });
  }
}

const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export const timeEntryRoutes: FastifyPluginAsyncZod = async (app) => {
  // ─── Edit: project / description / trim start-end ───
  app.patch(
    '/time-entries/:id',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            project_id: z.string().uuid().nullable().optional(),
            description: z.string().max(500).nullable().optional(),
            started_at: z.string().datetime({ offset: true }).optional(),
            ended_at: z.string().datetime({ offset: true }).optional(),
          })
          .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' }),
        response: { 200: ActivityResponse },
        tags: ['time-entries'],
      },
    },
    async (req) => {
      const body = req.body;
      const visible = await visibleUsers(req);
      return req.withTenantDb(async (tx) => {
        const entry = await loadEntry(tx, req.organizationId!, req.params.id);
        await authorizeWrite(tx, req.organizationId!, req.userId!, visible, entry.userId);

        const editsTime = body.started_at !== undefined || body.ended_at !== undefined;
        if (editsTime && !entry.endedAt) {
          throw Object.assign(new Error('stop the running timer before editing its times'), {
            statusCode: 409,
            code: 'timer_running',
          });
        }

        const newStarted = body.started_at ? new Date(body.started_at) : entry.startedAt;
        const newEnded =
          body.ended_at !== undefined ? new Date(body.ended_at) : entry.endedAt;
        if (newEnded && newStarted.getTime() >= newEnded.getTime()) {
          throw Object.assign(new Error('start must be before end'), {
            statusCode: 422,
            code: 'invalid_range',
          });
        }
        const futureLimit = Date.now() + 60_000;
        if (newStarted.getTime() > futureLimit || (newEnded && newEnded.getTime() > futureLimit)) {
          throw Object.assign(new Error('times cannot be in the future'), {
            statusCode: 422,
            code: 'invalid_range',
          });
        }

        if (body.project_id) {
          await assertProjectAssignable(tx, req.organizationId!, body.project_id, entry.userId);
        }

        // Build the audit diff from only the fields that actually changed.
        const changes: Record<string, { old: unknown; new: unknown }> = {};
        const set: Partial<typeof schema.timeEntries.$inferInsert> = {};
        if (body.project_id !== undefined && (body.project_id ?? null) !== (entry.projectId ?? null)) {
          set.projectId = body.project_id;
          changes.project_id = { old: entry.projectId ?? null, new: body.project_id ?? null };
        }
        if (body.description !== undefined && (body.description ?? null) !== (entry.description ?? null)) {
          set.description = body.description;
          changes.description = { old: entry.description ?? null, new: body.description ?? null };
        }
        if (body.started_at !== undefined && newStarted.getTime() !== entry.startedAt.getTime()) {
          set.startedAt = newStarted;
          changes.started_at = { old: entry.startedAt.toISOString(), new: newStarted.toISOString() };
        }
        if (body.ended_at !== undefined && newEnded?.getTime() !== entry.endedAt?.getTime()) {
          set.endedAt = newEnded;
          changes.ended_at = { old: isoOrNull(entry.endedAt), new: isoOrNull(newEnded) };
        }

        if (Object.keys(changes).length === 0) return mapEntry(entry); // no-op

        set.updatedAt = new Date();
        set.source = 'web';
        set.isManual = true;

        const [updated] = await tx
          .update(schema.timeEntries)
          .set(set)
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              eq(schema.timeEntries.id, entry.id),
            ),
          )
          .returning();

        await recordAudit(tx, {
          organizationId: req.organizationId!,
          actorUserId: req.userId!,
          action: 'time_entry.update',
          targetType: 'time_entry',
          targetId: entry.id,
          metadata: { changes },
        });

        return mapEntry(updated!);
      });
    },
  );

  // ─── Split one activity into two at a chosen time ───
  app.post(
    '/time-entries/:id/split',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ at: z.string().datetime({ offset: true }) }),
        response: { 200: z.object({ original: ActivityResponse, created: ActivityResponse }) },
        tags: ['time-entries'],
      },
    },
    async (req) => {
      const at = new Date(req.body.at);
      const visible = await visibleUsers(req);
      return req.withTenantDb(async (tx) => {
        const entry = await loadEntry(tx, req.organizationId!, req.params.id);
        await authorizeWrite(tx, req.organizationId!, req.userId!, visible, entry.userId);

        if (!entry.endedAt) {
          throw Object.assign(new Error('cannot split a running timer'), {
            statusCode: 409,
            code: 'timer_running',
          });
        }
        if (at.getTime() <= entry.startedAt.getTime() || at.getTime() >= entry.endedAt.getTime()) {
          throw Object.assign(new Error('split time must be inside the activity'), {
            statusCode: 422,
            code: 'invalid_split',
          });
        }

        const originalEnd = entry.endedAt;

        const [original] = await tx
          .update(schema.timeEntries)
          .set({ endedAt: at, updatedAt: new Date(), source: 'web', isManual: true })
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              eq(schema.timeEntries.id, entry.id),
            ),
          )
          .returning();

        const [created] = await tx
          .insert(schema.timeEntries)
          .values({
            organizationId: req.organizationId!,
            userId: entry.userId,
            projectId: entry.projectId,
            taskId: entry.taskId,
            startedAt: at,
            endedAt: originalEnd,
            source: 'web',
            isManual: true,
            isBillable: entry.isBillable,
            description: entry.description,
            clientEventId: `split-${randomUUID()}`,
          })
          .returning();

        // Re-home child rows captured at/after the split point to the new entry.
        const newId = created!.id;
        await tx
          .update(schema.screenshots)
          .set({ timeEntryId: newId })
          .where(and(eq(schema.screenshots.timeEntryId, entry.id), gte(schema.screenshots.capturedAt, at)));
        await tx
          .update(schema.appUsage)
          .set({ timeEntryId: newId })
          .where(and(eq(schema.appUsage.timeEntryId, entry.id), gte(schema.appUsage.startedAt, at)));
        await tx
          .update(schema.urlUsage)
          .set({ timeEntryId: newId })
          .where(and(eq(schema.urlUsage.timeEntryId, entry.id), gte(schema.urlUsage.startedAt, at)));
        await tx
          .update(schema.activitySamples)
          .set({ timeEntryId: newId })
          .where(and(eq(schema.activitySamples.timeEntryId, entry.id), gte(schema.activitySamples.bucketMinute, at)));

        await recordAudit(tx, {
          organizationId: req.organizationId!,
          actorUserId: req.userId!,
          action: 'time_entry.split',
          targetType: 'time_entry',
          targetId: entry.id,
          metadata: {
            split_at: at.toISOString(),
            new_entry_id: created!.id,
            original_ended_at: originalEnd.toISOString(),
          },
        });

        return { original: mapEntry(original!), created: mapEntry(created!) };
      });
    },
  );

  // ─── Soft-delete an activity ───
  app.delete(
    '/time-entries/:id',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ ok: z.boolean() }) },
        tags: ['time-entries'],
      },
    },
    async (req) => {
      const visible = await visibleUsers(req);
      return req.withTenantDb(async (tx) => {
        const entry = await loadEntry(tx, req.organizationId!, req.params.id);
        await authorizeWrite(tx, req.organizationId!, req.userId!, visible, entry.userId);

        await tx
          .update(schema.timeEntries)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              eq(schema.timeEntries.id, entry.id),
            ),
          );

        await recordAudit(tx, {
          organizationId: req.organizationId!,
          actorUserId: req.userId!,
          action: 'time_entry.delete',
          targetType: 'time_entry',
          targetId: entry.id,
          metadata: {
            started_at: entry.startedAt.toISOString(),
            ended_at: isoOrNull(entry.endedAt),
            project_id: entry.projectId ?? null,
            description: entry.description ?? null,
          },
        });

        return { ok: true };
      });
    },
  );

  // ─── Edit history for one activity (the modal's audit view) ───
  app.get(
    '/time-entries/:id/history',
    {
      preHandler: [requireAuth],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            history: z.array(
              z.object({
                action: z.string(),
                actor_name: z.string().nullable(),
                at: z.string(),
                metadata: z.record(z.any()),
              }),
            ),
          }),
        },
        tags: ['time-entries'],
      },
    },
    async (req) => {
      const visible = await visibleUsers(req);
      return req.withTenantDb(async (tx) => {
        // Include soft-deleted so history still resolves after a delete.
        const entry = await loadEntry(tx, req.organizationId!, req.params.id, { includeDeleted: true });
        if (!canView(visible, entry.userId)) forbid('Not allowed to view this history');

        const rows = await tx
          .select({
            action: schema.auditLogs.action,
            createdAt: schema.auditLogs.createdAt,
            metadata: schema.auditLogs.metadata,
            actorName: schema.users.displayName,
          })
          .from(schema.auditLogs)
          .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId))
          .where(
            and(
              eq(schema.auditLogs.organizationId, req.organizationId!),
              eq(schema.auditLogs.targetType, 'time_entry'),
              eq(schema.auditLogs.targetId, entry.id),
            ),
          )
          .orderBy(asc(schema.auditLogs.createdAt));

        return {
          history: rows.map((r) => ({
            action: r.action,
            actor_name: r.actorName ?? null,
            at: r.createdAt.toISOString(),
            metadata: (r.metadata ?? {}) as Record<string, unknown>,
          })),
        };
      });
    },
  );
};
