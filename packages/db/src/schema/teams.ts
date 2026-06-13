import { pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pkId, softDeletedAt, timestamps, tsCol } from './_common';
import { organizations } from './organizations';
import { users } from './users';

export const teams = pgTable(
  'teams',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    managerUserId: uuid('manager_user_id').references(() => users.id),
    ...timestamps,
    ...softDeletedAt,
  },
  (t) => ({
    nameUnique: uniqueIndex('teams_org_name_unique').on(t.organizationId, t.name),
  }),
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: tsCol('added_at').notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.teamId, t.userId] }) }),
);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
