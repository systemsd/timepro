import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pkId, softDeletedAt, timestamps, tsCol } from './_common';
import { products } from './products';
import { projects } from './projects';
import { tasks } from './tasks';
import { users } from './users';

/**
 * NOTE: not partitioned today. Monthly partitioning by `started_at` was
 * planned (docs/02) but never created — no PARTITION DDL exists in any
 * migration. This is a plain table; treat it as such when adding indexes.
 */
export const timeEntries = pgTable(
  'time_entries',
  {
    id: pkId(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id),
    // Internal-product attribution — the peer of `project_id`, never set with it
    // (see the `time_entries_project_xor_product` check). Product time is always
    // non-billable; `timer/start` forces `is_billable=false` when this is set.
    productId: uuid('product_id').references(() => products.id),
    taskId: uuid('task_id').references(() => tasks.id),
    deviceId: uuid('device_id'),
    startedAt: tsCol('started_at').notNull(),
    endedAt: tsCol('ended_at'), // null while running
    source: text('source').notNull().default('desktop'), // desktop | web | mobile | manual
    isManual: boolean('is_manual').notNull().default(false),
    isBillable: boolean('is_billable').notNull().default(true),
    description: text('description'),
    clientEventId: text('client_event_id').notNull(),
    approvalStatus: text('approval_status').notNull().default('pending'), // pending | approved | rejected
    approvedBy: uuid('approved_by'),
    approvedAt: tsCol('approved_at'),
    rejectionReason: text('rejection_reason'),
    ...timestamps,
    ...softDeletedAt,
  },
  (t) => ({
    clientEventUnique: uniqueIndex('time_entries_client_event_unique').on(
      t.organizationId,
      t.clientEventId,
    ),
    userStarted: index('time_entries_user_started_idx').on(
      t.organizationId,
      t.userId,
      t.startedAt.desc(),
    ),
    projectStarted: index('time_entries_project_started_idx')
      .on(t.organizationId, t.projectId, t.startedAt.desc())
      .where(sql`project_id IS NOT NULL`),
    running: index('time_entries_running_idx')
      .on(t.organizationId, t.userId)
      .where(sql`ended_at IS NULL`),
    productStarted: index('time_entries_product_started_idx')
      .on(t.organizationId, t.productId, t.startedAt.desc())
      .where(sql`product_id IS NOT NULL`),
    // An entry is client-project time or internal-product time, never both —
    // mirrors OpsCore's task XOR and keeps Phase-B reporting unambiguous.
    projectXorProduct: check(
      'time_entries_project_xor_product',
      sql`not (${t.projectId} is not null and ${t.productId} is not null)`,
    ),
  }),
);

export type TimeEntry = typeof timeEntries.$inferSelect;
export type NewTimeEntry = typeof timeEntries.$inferInsert;
