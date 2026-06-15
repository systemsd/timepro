import { boolean, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { pkId, softDeletedAt, timestamps } from './_common';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Saved report configurations (B7 / Phase 5, sub-phase 5C).
 *
 * One row = a named, reusable Reports-console filter set. Owned by the user who
 * saved it; `is_shared` exposes it to the whole org (read-only for non-owners).
 * `config` is the serialized builder state (type, range/preset, filters,
 * group-by, toggles) — re-applied and re-run on load.
 */
export const savedReports = pgTable(
  'saved_reports',
  {
    id: pkId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    isShared: boolean('is_shared').notNull().default(false),
    ...timestamps,
    ...softDeletedAt,
  },
  (t) => ({
    ownerIdx: index('saved_reports_owner_idx').on(t.organizationId, t.ownerUserId),
  }),
);

export type SavedReport = typeof savedReports.$inferSelect;
export type NewSavedReport = typeof savedReports.$inferInsert;
