import { sql } from 'drizzle-orm';
import { index, pgTable, primaryKey, smallint, uuid } from 'drizzle-orm/pg-core';
import { tsCol } from './_common';

/**
 * One row per (user, minute). Partitioned monthly on bucket_minute
 * (DDL in migrations/0001_partitions.sql).
 */
export const activitySamples = pgTable(
  'activity_samples',
  {
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    timeEntryId: uuid('time_entry_id'),
    bucketMinute: tsCol('bucket_minute').notNull(),
    keyboardEvents: smallint('keyboard_events').notNull().default(0),
    mouseEvents: smallint('mouse_events').notNull().default(0),
    activeSeconds: smallint('active_seconds').notNull(),
    idleSeconds: smallint('idle_seconds').notNull(),
    activityScore: smallint('activity_score').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.userId, t.bucketMinute] }),
    byEntry: index('activity_samples_entry_idx')
      .on(t.timeEntryId)
      .where(sql`time_entry_id IS NOT NULL`),
  }),
);

export type ActivitySample = typeof activitySamples.$inferSelect;
export type NewActivitySample = typeof activitySamples.$inferInsert;
