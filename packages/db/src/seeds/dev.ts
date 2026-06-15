/**
 * Dev-only seed: one org, an owner, a team of employees, and projects.
 * Idempotent — safe to run repeatedly.
 *
 *   pnpm db:seed
 *
 * Uses the admin role so RLS doesn't block initial bootstrap.
 */
import { loadRootEnv } from '../lib/loadEnv';
loadRootEnv();

import { and, eq } from 'drizzle-orm';
import { createDb, closeDb, getDb } from '../client';
import { asPlatform } from '../tenant';
import { clients, memberships, organizations, projectMembers, projects, users } from '../schema';

const OWNER_EMAIL = 'owner@timepro.local';

const TEAM: Array<{ name: string; email: string; role: string; status: string }> = [
  { name: 'Arslan Maqsood', email: 'arslan.maqsood@systemsd.local', role: 'employee', status: 'active' },
  { name: 'Faria Abid', email: 'faria.abid@systemsd.local', role: 'employee', status: 'active' },
  { name: 'Iram Ahmed', email: 'iram.ahmed@systemsd.local', role: 'manager', status: 'active' },
  { name: 'Muhammad Anas', email: 'm.anas@systemsd.local', role: 'employee', status: 'suspended' },
  { name: 'Muhammad Hamza Naeem', email: 'hamza.naeem@systemsd.local', role: 'employee', status: 'suspended' },
  { name: 'Usama Hameed', email: 'usamahamait786@gmail.local', role: 'employee', status: 'active' },
  { name: 'Anas Tabussam', email: 'anas.tabussam@systemsd.local', role: 'employee', status: 'archived' },
  { name: 'Hadi Ahmed', email: 'hadi.ahmed@systemsd.local', role: 'employee', status: 'archived' },
  { name: 'Muhammad Abrar Hussain', email: 'abrar.hussain@systemsd.local', role: 'employee', status: 'suspended' },
];

const PROJECT_NAMES = [
  'DIY-Parts',
  'Enginehire',
  'HeyCarson',
  'interviews',
  'Kaptivate',
  'Opengear',
  'presale',
  'Qtip',
  'UwU',
];

const PALETTE = [
  '#6366f1', '#22c55e', '#ef4444', '#f59e0b', '#06b6d4',
  '#8b5cf6', '#ec4899', '#10b981', '#f97316',
];

async function main() {
  process.env.DATABASE_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  createDb();

  await asPlatform(async (tx) => {
    // --- owner ---
    let [owner] = await tx.select().from(users).where(eq(users.email, OWNER_EMAIL)).limit(1);
    if (!owner) {
      [owner] = await tx
        .insert(users)
        .values({
          email: OWNER_EMAIL,
          displayName: 'Hamid Ali',
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$abcdefghijklmnop$replace-me',
        })
        .returning();
    } else if (owner.displayName !== 'Hamid Ali') {
      await tx.update(users).set({ displayName: 'Hamid Ali' }).where(eq(users.id, owner.id));
    }

    // --- org ---
    let [org] = await tx.select().from(organizations).where(eq(organizations.slug, 'demo')).limit(1);
    if (!org) {
      [org] = await tx
        .insert(organizations)
        .values({ name: 'Systemsd', slug: 'demo', plan: 'business' })
        .returning();
    }

    const orgId = org!.id;

    // --- owner membership ---
    const ownerMembership = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, owner!.id)))
      .limit(1);
    if (ownerMembership.length === 0) {
      await tx.insert(memberships).values({
        organizationId: orgId,
        userId: owner!.id,
        role: 'owner',
        status: 'active',
        weeklyHourLimit: 40,
      });
    }

    // --- team members ---
    const memberIds: string[] = [];
    for (const m of TEAM) {
      let [u] = await tx.select().from(users).where(eq(users.email, m.email)).limit(1);
      if (!u) {
        [u] = await tx
          .insert(users)
          .values({ email: m.email, displayName: m.name })
          .returning();
      }
      memberIds.push(u!.id);
      const exists = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, u!.id)))
        .limit(1);
      if (exists.length === 0) {
        await tx.insert(memberships).values({
          organizationId: orgId,
          userId: u!.id,
          role: m.role,
          status: m.status,
          weeklyHourLimit: 40,
        });
      }
    }

    // --- projects ---
    const projectIds: string[] = [];
    for (let i = 0; i < PROJECT_NAMES.length; i++) {
      const name = PROJECT_NAMES[i]!;
      let [p] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.organizationId, orgId), eq(projects.name, name)))
        .limit(1);
      if (!p) {
        [p] = await tx
          .insert(projects)
          .values({
            organizationId: orgId,
            name,
            color: PALETTE[i % PALETTE.length]!,
            createdBy: owner!.id,
          })
          .returning();
      }
      projectIds.push(p!.id);
    }

    // --- assign a few projects to the first member (Arslan) for a populated view ---
    const arslan = memberIds[0]!;
    const enginehire = projectIds[PROJECT_NAMES.indexOf('Enginehire')]!;
    const presale = projectIds[PROJECT_NAMES.indexOf('presale')]!;
    const interviews = projectIds[PROJECT_NAMES.indexOf('interviews')]!;
    for (const pid of [enginehire, presale, interviews]) {
      await tx.insert(projectMembers).values({ projectId: pid, userId: arslan }).onConflictDoNothing();
    }

    // --- clients (interim local catalog; OpsCore-managed once sync lands) ---
    const CLIENTS = ['Acme Corp', 'Globex', 'Initech'];
    for (let i = 0; i < CLIENTS.length; i++) {
      const name = CLIENTS[i]!;
      const existing = await tx
        .select()
        .from(clients)
        .where(and(eq(clients.organizationId, orgId), eq(clients.name, name)))
        .limit(1);
      let clientId: string;
      if (existing.length === 0) {
        const [c] = await tx.insert(clients).values({ organizationId: orgId, name }).returning();
        clientId = c!.id;
      } else {
        clientId = existing[0]!.id;
      }
      // map one project to each client for a populated reports view
      const pid = projectIds[i];
      if (pid) {
        await tx.update(projects).set({ clientId }).where(eq(projects.id, pid));
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[seed] org=${orgId} owner=${owner!.id} members=${TEAM.length + 1} projects=${PROJECT_NAMES.length} clients=${CLIENTS.length}`,
    );
  }, getDb());

  await closeDb();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed', err);
  await closeDb();
  process.exit(1);
});
