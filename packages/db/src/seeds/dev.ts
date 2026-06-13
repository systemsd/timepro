/**
 * Dev-only seed: one org, one owner, one project. Idempotent.
 *
 *   pnpm db:seed
 *
 * Uses the admin role so RLS doesn't block initial bootstrap.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { createDb, closeDb, getDb } from '../client';
import { asPlatform } from '../tenant';
import {
  memberships,
  organizations,
  projects,
  users,
} from '../schema';

async function main() {
  // Bootstrap uses admin (BYPASSRLS) connection because there is no tenant yet.
  process.env.DATABASE_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  createDb();

  await asPlatform(async (tx) => {
    let [owner] = await tx
      .select()
      .from(users)
      .where(eq(users.email, 'owner@trackflow.local'))
      .limit(1);

    if (!owner) {
      [owner] = await tx
        .insert(users)
        .values({
          email: 'owner@trackflow.local',
          displayName: 'Demo Owner',
          // hash for "password" via argon2id — replace in real seeds
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$abcdefghijklmnop$replace-me',
        })
        .returning();
    }

    let [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.slug, 'demo'))
      .limit(1);

    if (!org) {
      [org] = await tx
        .insert(organizations)
        .values({
          name: 'Demo Org',
          slug: 'demo',
          plan: 'starter',
        })
        .returning();
    }

    // Ensure owner has membership.
    const existingMembership = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.userId, owner!.id))
      .limit(1);

    if (existingMembership.length === 0) {
      await tx.insert(memberships).values({
        organizationId: org!.id,
        userId: owner!.id,
        role: 'owner',
        status: 'active',
      });
    }

    // First project
    const existingProject = await tx
      .select()
      .from(projects)
      .where(eq(projects.organizationId, org!.id))
      .limit(1);

    if (existingProject.length === 0) {
      await tx.insert(projects).values({
        organizationId: org!.id,
        name: 'Internal',
        color: '#22c55e',
        createdBy: owner!.id,
      });
    }

    // eslint-disable-next-line no-console
    console.log(`[seed] org=${org!.id} owner=${owner!.id}`);
  }, getDb());

  await closeDb();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed', err);
  await closeDb();
  process.exit(1);
});
