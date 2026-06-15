import {
  bigint,
  boolean,
  decimal,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { pkId, softDeletedAt, timestamps, tsCol } from './_common';
import { organizations } from './organizations';
import { users } from './users';

export const projects = pgTable(
  'projects',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code'),
    color: text('color').notNull().default('#6366f1'),
    status: text('status').notNull().default('active'), // active | archived | paused
    isBillable: boolean('is_billable').notNull().default(true),
    defaultRateCents: integer('default_rate_cents'),
    clientName: text('client_name'),
    clientId: uuid('client_id'), // FK to clients; mapping syncs from OpsCore (C3)
    budgetHours: decimal('budget_hours', { precision: 10, scale: 2 }),
    budgetCents: bigint('budget_cents', { mode: 'number' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    ...timestamps,
    ...softDeletedAt,
  },
  (t) => ({
    nameUnique: uniqueIndex('projects_org_name_unique').on(t.organizationId, t.name),
  }),
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rateCents: integer('rate_cents'), // override membership.hourly_rate_cents
    addedAt: tsCol('added_at').notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.projectId, t.userId] }) }),
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
