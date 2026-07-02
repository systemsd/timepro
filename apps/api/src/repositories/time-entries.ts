import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { schema, type DB } from '@timepro/db';

/**
 * Data-access for `time_entries`. Thin, tenant-scoped functions that keep the
 * Drizzle queries out of the HTTP handlers (previously duplicated across timer /
 * roster / me / reports). Callers pass the request's `tx` (from `withTenantDb`).
 */

export type TimeEntryRow = typeof schema.timeEntries.$inferSelect;

/** The user's currently-running entry (`ended_at IS NULL`), or null. */
export async function getCurrentTimer(
  tx: DB,
  orgId: string,
  userId: string,
): Promise<TimeEntryRow | null> {
  const [row] = await tx
    .select()
    .from(schema.timeEntries)
    .where(
      and(
        eq(schema.timeEntries.organizationId, orgId),
        eq(schema.timeEntries.userId, userId),
        isNull(schema.timeEntries.endedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Non-deleted entries for these users that started at/after `since` (newest first). */
export async function listForUsersStartedSince(
  tx: DB,
  orgId: string,
  userIds: string[],
  since: Date,
): Promise<TimeEntryRow[]> {
  if (userIds.length === 0) return [];
  return tx
    .select()
    .from(schema.timeEntries)
    .where(
      and(
        eq(schema.timeEntries.organizationId, orgId),
        inArray(schema.timeEntries.userId, userIds),
        isNull(schema.timeEntries.deletedAt),
        gte(schema.timeEntries.startedAt, since),
      ),
    )
    .orderBy(desc(schema.timeEntries.startedAt));
}
