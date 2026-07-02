import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pkId, timestamps, tsCol } from './_common';

/** Active-application intervals (B5). Window titles truncated to 256 chars. */
export const appUsage = pgTable(
  'app_usage',
  {
    id: pkId(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    timeEntryId: uuid('time_entry_id'),
    appName: text('app_name').notNull(),
    appBundleId: text('app_bundle_id'),
    windowTitle: text('window_title'),
    category: text('category'),
    startedAt: tsCol('started_at').notNull(),
    endedAt: tsCol('ended_at').notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => ({
    userStarted: index('app_usage_user_started_idx').on(
      t.organizationId,
      t.userId,
      t.startedAt.desc(),
    ),
    // Idempotency key: a retried ingest batch must not double-insert an interval.
    // A user's foreground app sessions are serial, so (started_at, app_name) is
    // effectively unique per user+device. Paired with .onConflictDoNothing() in
    // the ingest route.
    naturalUnique: uniqueIndex('app_usage_natural_uniq').on(
      t.organizationId,
      t.userId,
      t.deviceId,
      t.startedAt,
      t.appName,
    ),
  }),
);

export type AppUsage = typeof appUsage.$inferSelect;
export type NewAppUsage = typeof appUsage.$inferInsert;
