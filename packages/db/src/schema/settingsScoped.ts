import { boolean, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { tsCol } from './_common';

export const settingsScoped = pgTable(
  'settings_scoped',
  {
    organizationId: uuid('organization_id').notNull(),
    scopeType: text('scope_type').notNull(), // 'org' | 'team' | 'project' | 'user'
    scopeId: uuid('scope_id').notNull(),
    key: text('key').notNull(),              // e.g. 'screenshots.per_hour'
    value: jsonb('value').notNull(),
    isLocked: boolean('is_locked').notNull().default(false),
    updatedBy: uuid('updated_by'),
    updatedAt: tsCol('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.organizationId, t.scopeType, t.scopeId, t.key],
    }),
  }),
);

export type SettingScoped = typeof settingsScoped.$inferSelect;
export type NewSettingScoped = typeof settingsScoped.$inferInsert;
