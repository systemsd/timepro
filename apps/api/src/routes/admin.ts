import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '@timepro/db';
import { requireAuth } from '../plugins/tenant';
import { forbid, isAdmin, requesterRole } from '../lib/access';
import { mapOpsCoreRole, opscoreApi } from '../lib/opscore';

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
          .select({ role: schema.memberships.role })
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
        } else if (m.role !== 'owner' && m.role !== role) {
          await db
            .update(schema.memberships)
            .set({ role })
            .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, user!.id)));
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
      };
    },
  );
};
