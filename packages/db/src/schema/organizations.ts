import { pgTable, text } from 'drizzle-orm/pg-core';
import { citext, pkId, softDeletedAt, timestamps, tsCol } from './_common';

export const organizations = pgTable('organizations', {
  id: pkId(),
  name: text('name').notNull(),
  slug: citext('slug').notNull().unique(),
  plan: text('plan').notNull().default('free'),       // free | starter | business | enterprise
  status: text('status').notNull().default('active'), // active | suspended | cancelled
  trialEndsAt: tsCol('trial_ends_at'),
  dataRegion: text('data_region').notNull().default('us-east-1'),
  ...timestamps,
  ...softDeletedAt,
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
