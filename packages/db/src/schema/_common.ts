import { sql } from 'drizzle-orm';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../lib/uuidv7';

/** Standard `timestamptz` with UTC default. */
export const tsCol = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

/** UUIDv7 primary key. */
export const pkId = () => uuid('id').primaryKey().$defaultFn(uuidv7);

/** Foreign-key UUID (nullable by default). */
export const fkId = (name: string) => uuid(name);

/** `created_at` / `updated_at` shorthand. */
export const timestamps = {
  createdAt: tsCol('created_at').notNull().default(sql`now()`),
  updatedAt: tsCol('updated_at').notNull().default(sql`now()`),
};

/** Soft-delete column. */
export const softDeletedAt = { deletedAt: tsCol('deleted_at') };

/** Postgres `citext` (case-insensitive text). */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/** Postgres `inet`. */
export const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});
