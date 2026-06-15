import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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
  }),
);

export type UrlUsage = typeof urlUsage.$inferSelect;
export type NewUrlUsage = typeof urlUsage.$inferInsert;
