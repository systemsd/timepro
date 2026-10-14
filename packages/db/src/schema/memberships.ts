import { sql } from 'drizzle-orm';
import { char, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pkId, timestamps, tsCol } from './_common';
import { organizations } from './organizations';
import { users } from './users';

export const memberships = pgTable(
  'memberships',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),                        // owner | admin | manager | employee
    employmentType: text('employment_type').notNull().default('employee'), // employee | contractor
    hourlyRateCents: integer('hourly_rate_cents'),
    currency: char('currency', { length: 3 }).default('USD'),
    weeklyHourLimit: integer('weekly_hour_limit'),
    // Reporting line mirrored from OpsCore `Employee.reporting_manager_id`. A
    // viewer sees the activity of everyone below them in this chain.
    reportsToUserId: uuid('reports_to_user_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('active'),  // active | invited | suspended
    invitedAt: tsCol('invited_at'),
    joinedAt: tsCol('joined_at'),
    ...timestamps,
  },
  (t) => ({
    orgUserUnique: uniqueIndex('memberships_org_user_unique').on(t.organizationId, t.userId),
    activeByOrg: index('memberships_org_idx')
      .on(t.organizationId)
      .where(sql`status = 'active'`),
    activeByUser: index('memberships_user_idx').on(t.userId).where(sql`status = 'active'`),
    reportsTo: index('memberships_org_reports_to_idx')
      .on(t.organizationId, t.reportsToUserId)
      .where(sql`reports_to_user_id IS NOT NULL`),
  }),
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
