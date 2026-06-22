import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, gte, ilike, inArray, isNotNull, lte } from 'drizzle-orm';
import { getDb, schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { forbid, isAdmin, requesterRole } from '../lib/access';
import { mapOpsCoreRole, opscoreApi } from '../lib/opscore';
import { getEffectiveForUser } from '../lib/settings';
import { pruneOrgScreenshots } from '../lib/retention';

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

/** OpsCore ProjectStatus → TimePro project status. */
function mapProjectStatus(s: string): string {
  switch (s) {
    case 'COMPLETED':
      return 'archived';
    case 'PAUSED':
      return 'paused';
    default:
      return 'active'; // ONGOING | MAINTENANCE | unknown
  }
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
          }),
        },
        tags: ['admin'],
      },
    },
    async (req) => {
      if (!isAdmin(await requesterRole(req))) forbid('Only owners and admins can sync OpsCore');
      const orgId = req.organizationId!;
      const db = getDb();

      const [emp, proj, bp] = await Promise.all([
        opscoreApi.employees(),
        opscoreApi.projects(),
        opscoreApi.businessPartners(),
      ]);

      // 1) Clients (business partners) — match by opscore id, then by name
      // (adopt an existing local client of the same name), else insert.
      const clientByOps = new Map<string, string>();
      for (const b of bp.business_partners) {
        let [existing] = await db
          .select({ id: schema.clients.id })
          .from(schema.clients)
          .where(
            and(
              eq(schema.clients.organizationId, orgId),
              eq(schema.clients.opscoreBusinessPartnerId, b.id),
            ),
          )
          .limit(1);
        if (!existing) {
          [existing] = await db
            .select({ id: schema.clients.id })
            .from(schema.clients)
            .where(and(eq(schema.clients.organizationId, orgId), eq(schema.clients.name, b.name)))
            .limit(1);
        }
        if (existing) {
          await db
            .update(schema.clients)
            .set({ name: b.name, opscoreBusinessPartnerId: b.id })
            .where(eq(schema.clients.id, existing.id));
          clientByOps.set(b.id, existing.id);
        } else {
          const [c] = await db
            .insert(schema.clients)
            .values({ organizationId: orgId, name: b.name, opscoreBusinessPartnerId: b.id })
            .returning();
          clientByOps.set(b.id, c!.id);
        }
      }

      // 2) Employees → users + memberships (mapped role; never demote owner).
      const userByOps = new Map<string, string>();
      for (const e of emp.employees) {
        let [user] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.opscoreEmployeeId, e.id))
          .limit(1);
        if (!user && e.email) {
          [user] = await db.select().from(schema.users).where(eq(schema.users.email, e.email)).limit(1);
        }
        if (!user) {
          [user] = await db
            .insert(schema.users)
            .values({
              email: e.email || `${e.id}@opscore.local`,
              displayName: e.name,
              opscoreEmployeeId: e.id,
            })
            .returning();
        } else {
          await db
            .update(schema.users)
            .set({ opscoreEmployeeId: e.id, displayName: e.name })
            .where(eq(schema.users.id, user.id));
        }
        userByOps.set(e.id, user!.id);

        const role = mapOpsCoreRole(e.role);
        const [m] = await db
          .select({ role: schema.memberships.role, status: schema.memberships.status })
          .from(schema.memberships)
          .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, user!.id)))
          .limit(1);
        if (!m) {
          await db.insert(schema.memberships).values({
            organizationId: orgId,
            userId: user!.id,
            role,
            status: 'active',
            joinedAt: new Date(),
          });
        } else if (m.role !== 'owner') {
          // present in OpsCore → keep role in sync + re-activate if it had been
          // disabled by a prior sync (employee re-added to the directory).
          const patch: { role?: string; status?: string } = {};
          if (m.role !== role) patch.role = role;
          if (m.status !== 'active' && m.status !== 'invited') patch.status = 'active';
          if (Object.keys(patch).length > 0) {
            await db
              .update(schema.memberships)
              .set(patch)
              .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, user!.id)));
          }
        }
      }

      // 2b) Disable OpsCore-managed members no longer present in the directory.
      // Only touches users linked to OpsCore (have an `opscore_employee_id`);
      // local/owner accounts are never auto-disabled.
      const presentOps = new Set(emp.employees.map((e) => e.id));
      const opsMembers = await db
        .select({
          userId: schema.memberships.userId,
          opsId: schema.users.opscoreEmployeeId,
          status: schema.memberships.status,
          role: schema.memberships.role,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(
          and(
            eq(schema.memberships.organizationId, orgId),
            isNotNull(schema.users.opscoreEmployeeId),
          ),
        );
      let disabled = 0;
      for (const m of opsMembers) {
        if (m.opsId && !presentOps.has(m.opsId) && m.role !== 'owner' && m.status === 'active') {
          await db
            .update(schema.memberships)
            .set({ status: 'suspended' })
            .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, m.userId)));
          disabled += 1;
        }
      }

      // 3) Projects (+ client link) and project membership (reconciled from OpsCore).
      let assignments = 0;
      for (const p of proj.projects) {
        const clientId = p.business_partner_id ? clientByOps.get(p.business_partner_id) ?? null : null;
        const status = mapProjectStatus(p.status);
        let [project] = await db
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(
            and(eq(schema.projects.organizationId, orgId), eq(schema.projects.opscoreProjectId, p.id)),
          )
          .limit(1);
        if (!project) {
          // adopt an existing local project with the same name
          [project] = await db
            .select({ id: schema.projects.id })
            .from(schema.projects)
            .where(and(eq(schema.projects.organizationId, orgId), eq(schema.projects.name, p.name)))
            .limit(1);
        }
        if (!project) {
          [project] = await db
            .insert(schema.projects)
            .values({
              organizationId: orgId,
              name: p.name,
              status,
              clientId,
              opscoreProjectId: p.id,
              createdBy: req.userId!,
            })
            .returning({ id: schema.projects.id });
        } else {
          await db
            .update(schema.projects)
            .set({ name: p.name, status, clientId, opscoreProjectId: p.id })
            .where(eq(schema.projects.id, project.id));
        }

        // reconcile members from OpsCore team list
        const memberUserIds = p.member_ids
          .map((mid) => userByOps.get(mid))
          .filter((x): x is string => !!x);
        await db.delete(schema.projectMembers).where(eq(schema.projectMembers.projectId, project!.id));
        for (const uid of memberUserIds) {
          await db
            .insert(schema.projectMembers)
            .values({ projectId: project!.id, userId: uid })
            .onConflictDoNothing();
          assignments += 1;
        }
      }

      return {
        users: emp.employees.length,
        clients: bp.business_partners.length,
        projects: proj.projects.length,
        assignments,
        disabled,
      };
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
        return {
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
};
