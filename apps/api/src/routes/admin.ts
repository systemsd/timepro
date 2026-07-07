import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { forbid, isAdmin, requesterRole } from '../lib/access';
import { syncOrgFromOpsCore } from '../lib/opscore-sync';
import { getEffectiveForUser } from '../lib/settings';
import { pruneOrgScreenshots } from '../lib/retention';
import { DAY_MS, localDateToUtcMs } from '../lib/time';

// Developers allowed to read agent diagnostics WITHOUT an org-admin role
// (single-tenant Systemsd: the app developer monitors all users' agent logs to
// debug field issues). Extend via DIAGNOSTICS_ALLOWED_USERS (comma-separated
// user UUIDs) without a code change.
const DIAGNOSTICS_DEVELOPERS = new Set<string>([
  '019eda21-9c83-7aa7-b27d-805cdf5aa684', // Muhammad Anas (developer)
  ...(process.env.DIAGNOSTICS_ALLOWED_USERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]);

function canViewDiagnostics(role: string, userId: string | undefined): boolean {
  return isAdmin(role) || (!!userId && DIAGNOSTICS_DEVELOPERS.has(userId));
}

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Pull users / projects / clients from OpsCore and upsert them into the
   * requester's org. OpsCore is authoritative (C2/C3): identity, roles, the
   * project↔client link, and project membership all come from OpsCore.
   */
  app.post(
    '/admin/opscore/sync',
    {
      preHandler: [requireAuth],
      schema: {
        response: {
          200: z.object({
            users: z.number(),
            clients: z.number(),
            projects: z.number(),
            assignments: z.number(),
            disabled: z.number(),
            tasks: z.number(),
            tasksDisabled: z.number(),
          }),
        },
        tags: ['admin'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can sync OpsCore');
      return syncOrgFromOpsCore(req.organizationId!, req.userId!);
    },
  );

  /**
   * Manually run screenshot retention for the requester's org (admin-only).
   * The same prune runs automatically on the server's in-process sweep; this
   * lets an admin apply a just-changed retention setting immediately.
   */
  app.post(
    '/admin/screenshots/prune',
    {
      preHandler: [requireAuth],
      schema: {
        response: { 200: z.object({ deleted: z.number() }) },
        tags: ['admin'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can prune screenshots');
      return req.withTenantDb(async (tx) => {
        const { effective } = await getEffectiveForUser(tx, req.organizationId!, req.userId!);
        const days = Number(effective['screenshots.retention_days'] ?? 90);
        const deleted = await pruneOrgScreenshots(tx, req.organizationId!, days);
        return { deleted };
      });
    },
  );

  // Read desktop-agent diagnostic logs for remote debugging (owners/admins only).
  app.get(
    '/admin/agent-logs',
    {
      preHandler: [requireAuth],
      schema: {
        querystring: z.object({
          userId: z.string().uuid().optional(),
          level: z.enum(['info', 'warn', 'error']).optional(),
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(1000).default(200),
        }),
        response: {
          200: z.object({
            logs: z.array(
              z.object({
                id: z.string(),
                userId: z.string(),
                displayName: z.string().nullable(),
                email: z.string().nullable(),
                deviceId: z.string().nullable(),
                agentVersion: z.string().nullable(),
                os: z.string().nullable(),
                ts: z.string(),
                level: z.string(),
                event: z.string(),
                message: z.string(),
                fields: z.record(z.unknown()),
              }),
            ),
            users: z.array(
              z.object({
                userId: z.string(),
                displayName: z.string().nullable(),
                email: z.string().nullable(),
              }),
            ),
          }),
        },
        tags: ['admin'],
      },
    },
    async (req) => {
      if (!canViewDiagnostics(await requesterRole(req), req.userId))
        forbid('Only owners, admins, or allowlisted developers can view agent logs');
      const { userId, level, from, to, q, limit } = req.query;
      return req.withTenantDb(async (tx) => {
        const conds = [eq(schema.agentLogs.organizationId, req.organizationId!)];
        if (userId) conds.push(eq(schema.agentLogs.userId, userId));
        if (level) conds.push(eq(schema.agentLogs.level, level));
        if (from) conds.push(gte(schema.agentLogs.ts, new Date(from)));
        if (to) conds.push(lte(schema.agentLogs.ts, new Date(to)));
        if (q) conds.push(ilike(schema.agentLogs.message, `%${q}%`));
        const rows = await tx
          .select({
            id: schema.agentLogs.id,
            userId: schema.agentLogs.userId,
            displayName: schema.users.displayName,
            email: schema.users.email,
            deviceId: schema.agentLogs.deviceId,
            agentVersion: schema.agentLogs.agentVersion,
            os: schema.agentLogs.os,
            ts: schema.agentLogs.ts,
            level: schema.agentLogs.level,
            event: schema.agentLogs.event,
            message: schema.agentLogs.message,
            fields: schema.agentLogs.fields,
          })
          .from(schema.agentLogs)
          .leftJoin(schema.users, eq(schema.users.id, schema.agentLogs.userId))
          .where(and(...conds))
          .orderBy(desc(schema.agentLogs.ts))
          .limit(limit);

        // Distinct users that have shipped agent logs (independent of the
        // date/level/search filters) — populates the "All users" dropdown so it
        // stays complete regardless of the selected day.
        const userRows = await tx
          .selectDistinct({
            userId: schema.agentLogs.userId,
            displayName: schema.users.displayName,
            email: schema.users.email,
          })
          .from(schema.agentLogs)
          .leftJoin(schema.users, eq(schema.users.id, schema.agentLogs.userId))
          .where(eq(schema.agentLogs.organizationId, req.organizationId!));
        const users = userRows
          .map((u) => ({
            userId: u.userId,
            displayName: u.displayName ?? null,
            email: u.email ?? null,
          }))
          .sort((a, b) =>
            (a.displayName ?? a.email ?? '').localeCompare(b.displayName ?? b.email ?? ''),
          );

        return {
          users,
          logs: rows.map((r) => ({
            id: r.id,
            userId: r.userId,
            displayName: r.displayName ?? null,
            email: r.email ?? null,
            deviceId: r.deviceId,
            agentVersion: r.agentVersion,
            os: r.os,
            ts: r.ts.toISOString(),
            level: r.level,
            event: r.event,
            message: r.message,
            fields: (r.fields ?? {}) as Record<string, unknown>,
          })),
        };
      });
    },
  );

  /**
   * Diagnostics: search org users by name/email (find the right person when two
   * have similar names). Allowlisted like agent-logs. Read-only.
   */
  app.get(
    '/admin/users',
    {
      preHandler: [requireAuth],
      schema: {
        querystring: z.object({ q: z.string().trim().max(120).optional() }),
        response: {
          200: z.object({
            users: z.array(
              z.object({
                id: z.string(),
                display_name: z.string().nullable(),
                email: z.string().nullable(),
                role: z.string(),
                status: z.string(),
              }),
            ),
          }),
        },
        tags: ['admin'],
      },
    },
    async (req) => {
      if (!canViewDiagnostics(await requesterRole(req), req.userId))
        forbid('Only owners, admins, or allowlisted developers can search users');
      const q = req.query.q;
      return req.withTenantDb(async (tx) => {
        const conds = [eq(schema.memberships.organizationId, req.organizationId!)];
        if (q) {
          const like = `%${q}%`;
          conds.push(or(ilike(schema.users.displayName, like), ilike(schema.users.email, like))!);
        }
        const rows = await tx
          .select({
            id: schema.users.id,
            displayName: schema.users.displayName,
            email: schema.users.email,
            role: schema.memberships.role,
            status: schema.memberships.status,
          })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(and(...conds))
          .orderBy(asc(schema.users.displayName))
          .limit(100);
        return {
          users: rows.map((r) => ({
            id: r.id,
            display_name: r.displayName ?? null,
            email: r.email ?? null,
            role: r.role,
            status: r.status,
          })),
        };
      });
    },
  );

  /**
   * Diagnostics: a user's time entries for a viewer-local day + any
   * `time_entry.auto_closed` audit rows for those entries — so a field issue like
   * "my tracked time dropped" can be traced to the abandoned-timer sweep (which
   * back-dates `ended_at` to the last activity signal). Allowlisted; read-only.
   */
  app.get(
    '/admin/user-activity',
    {
      preHandler: [requireAuth],
      schema: {
        querystring: z.object({
          userId: z.string().uuid(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          tzOffsetMinutes: z.coerce.number().default(0),
        }),
        response: {
          200: z.object({
            entries: z.array(
              z.object({
                id: z.string(),
                started_at: z.string(),
                ended_at: z.string().nullable(),
                is_open: z.boolean(),
                source: z.string(), // 'system' = touched by the sweep
                is_manual: z.boolean(),
                project_name: z.string().nullable(),
                description: z.string().nullable(),
                deleted_at: z.string().nullable(),
                tracked_seconds: z.number(),
              }),
            ),
            auto_closed: z.array(
              z.object({
                entry_id: z.string().nullable(),
                at: z.string(),
                was_open: z.boolean().nullable(),
                old_ended_at: z.string().nullable(),
                new_ended_at: z.string().nullable(),
                trimmed_seconds: z.number().nullable(),
                reason: z.string().nullable(),
              }),
            ),
          }),
        },
        tags: ['admin'],
      },
    },
    async (req) => {
      if (!canViewDiagnostics(await requesterRole(req), req.userId))
        forbid('Only owners, admins, or allowlisted developers can view user activity');
      const { userId, date, tzOffsetMinutes } = req.query;
      const dayStart = new Date(localDateToUtcMs(date, tzOffsetMinutes));
      const dayEnd = new Date(localDateToUtcMs(date, tzOffsetMinutes) + DAY_MS);
      const now = Date.now();
      return req.withTenantDb(async (tx) => {
        // entries overlapping the day (include soft-deleted, for diagnostics)
        const entryRows = await tx
          .select({
            id: schema.timeEntries.id,
            startedAt: schema.timeEntries.startedAt,
            endedAt: schema.timeEntries.endedAt,
            source: schema.timeEntries.source,
            isManual: schema.timeEntries.isManual,
            description: schema.timeEntries.description,
            deletedAt: schema.timeEntries.deletedAt,
            projectName: schema.projects.name,
          })
          .from(schema.timeEntries)
          .leftJoin(schema.projects, eq(schema.projects.id, schema.timeEntries.projectId))
          .where(
            and(
              eq(schema.timeEntries.organizationId, req.organizationId!),
              eq(schema.timeEntries.userId, userId),
              lt(schema.timeEntries.startedAt, dayEnd),
              or(isNull(schema.timeEntries.endedAt), gte(schema.timeEntries.endedAt, dayStart)),
            ),
          )
          .orderBy(asc(schema.timeEntries.startedAt));

        const entryIds = entryRows.map((e) => e.id);
        const auditRows = entryIds.length
          ? await tx
              .select({
                targetId: schema.auditLogs.targetId,
                createdAt: schema.auditLogs.createdAt,
                metadata: schema.auditLogs.metadata,
              })
              .from(schema.auditLogs)
              .where(
                and(
                  eq(schema.auditLogs.organizationId, req.organizationId!),
                  eq(schema.auditLogs.action, 'time_entry.auto_closed'),
                  inArray(schema.auditLogs.targetId, entryIds),
                ),
              )
              .orderBy(desc(schema.auditLogs.createdAt))
          : [];

        return {
          entries: entryRows.map((e) => {
            const start = e.startedAt.getTime();
            const end = e.endedAt ? e.endedAt.getTime() : now;
            return {
              id: e.id,
              started_at: e.startedAt.toISOString(),
              ended_at: e.endedAt ? e.endedAt.toISOString() : null,
              is_open: e.endedAt === null,
              source: e.source,
              is_manual: e.isManual,
              project_name: e.projectName ?? null,
              description: e.description ?? null,
              deleted_at: e.deletedAt ? e.deletedAt.toISOString() : null,
              tracked_seconds: Math.max(0, Math.floor((end - start) / 1000)),
            };
          }),
          auto_closed: auditRows.map((a) => {
            const m = (a.metadata ?? {}) as Record<string, unknown>;
            return {
              entry_id: a.targetId,
              at: a.createdAt.toISOString(),
              was_open: typeof m.was_open === 'boolean' ? m.was_open : null,
              old_ended_at: typeof m.old_ended_at === 'string' ? m.old_ended_at : null,
              new_ended_at: typeof m.new_ended_at === 'string' ? m.new_ended_at : null,
              trimmed_seconds: typeof m.trimmed_seconds === 'number' ? m.trimmed_seconds : null,
              reason: typeof m.reason === 'string' ? m.reason : null,
            };
          }),
        };
      });
    },
  );
};
