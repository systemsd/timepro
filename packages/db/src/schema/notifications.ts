import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { pkId, timestamps, tsCol } from './_common';

export const notifications = pgTable(
  'notifications',
  {
    id: pkId(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(), // 'timesheet.approval_needed' | ...
    title: text('title').notNull(),
    body: text('body'),
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    readAt: tsCol('read_at'),
    deliveredEmailAt: tsCol('delivered_email_at'),
    createdAt: timestamps.createdAt,
  },
  (t) => ({
    unread: index('notifications_user_unread_idx')
      .on(t.organizationId, t.userId, t.createdAt.desc())
      .where(sql`read_at IS NULL`),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
