import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pkId, timestamps, tsCol } from './_common';

/**
 * Browser URL intervals (B5). Populated by the browser extension (deferred);
 * the table exists so the ingest + read paths are ready.
 */
export const urlUsage = pgTable(
  'url_usage',
  {
    id: pkId(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    timeEntryId: uuid('time_entry_id'),
    browser: text('browser').notNull(),
    domain: text('domain').notNull(),
    url: text('url'),
    pageTitle: text('page_title'),
    category: text('category'),
    startedAt: tsCol('started_at').notNull(),
    endedAt: tsCol('ended_at').notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => ({
    domainIdx: index('url_usage_domain_idx').on(
      t.organizationId,
      t.domain,
      t.startedAt.desc(),
    ),
    // Idempotency key: a retried ingest batch must not double-insert an interval.
    // `browser` is part of the key so the same domain/instant reported by two
    // browsers for one user doesn't collapse. Paired with .onConflictDoNothing().
    naturalUnique: uniqueIndex('url_usage_natural_uniq').on(
      t.organizationId,
      t.userId,
      t.deviceId,
      t.startedAt,
      t.domain,
      t.browser,
    ),
  }),
);

export type UrlUsage = typeof urlUsage.$inferSelect;
export type NewUrlUsage = typeof urlUsage.$inferInsert;
