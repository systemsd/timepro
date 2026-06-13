import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pkId, timestamps, tsCol } from './_common';
import { projects } from './projects';
import { users } from './users';

export const screenshots = pgTable(
  'screenshots',
  {
    id: pkId(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull(),
    timeEntryId: uuid('time_entry_id'),
    projectId: uuid('project_id').references(() => projects.id),
    capturedAt: tsCol('captured_at').notNull(),
    monitorIndex: smallint('monitor_index').notNull().default(0),
    width: smallint('width'),
    height: smallint('height'),
    s3Key: text('s3_key').notNull(),
    s3ThumbKey: text('s3_thumb_key'),
    bytes: integer('bytes'),
    thumbnailBytes: integer('thumbnail_bytes'),
    isBlurred: boolean('is_blurred').notNull().default(false),
    encryptionDekId: uuid('encryption_dek_id'),
    activityScore: smallint('activity_score'),
    appName: text('app_name'),
    windowTitle: text('window_title'),
    status: text('status').notNull().default('pending'), // pending | approved | rejected | deleted
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: tsCol('reviewed_at'),
    rejectionReason: text('rejection_reason'),
    clientEventId: text('client_event_id').notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => ({
    clientEventUnique: uniqueIndex('screenshots_client_event_unique').on(
      t.organizationId,
      t.clientEventId,
    ),
    userCaptured: index('screenshots_user_captured_idx').on(
      t.organizationId,
      t.userId,
      t.capturedAt.desc(),
    ),
    byEntry: index('screenshots_entry_idx')
      .on(t.timeEntryId)
      .where(sql`time_entry_id IS NOT NULL`),
    pending: index('screenshots_status_idx')
      .on(t.organizationId, t.status, t.capturedAt.desc())
      .where(sql`status = 'pending'`),
  }),
);

export type Screenshot = typeof screenshots.$inferSelect;
export type NewScreenshot = typeof screenshots.$inferInsert;
