import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { schema, type DB } from '@timepro/db';

/**
 * Data-access for `screenshots`. Centralizes the two queries that were
 * duplicated across roster (latest-per-user) and timeline (a day's shots).
 */

/** Latest screenshot per user — exactly one row each, any age (DISTINCT ON, index-served). */
export async function getLatestPerUser(
  tx: DB,
  orgId: string,
  userIds: string[],
): Promise<Map<string, { id: string; capturedAt: Date }>> {
  const out = new Map<string, { id: string; capturedAt: Date }>();
  if (userIds.length === 0) return out;
  const rows = await tx
    .selectDistinctOn([schema.screenshots.userId], {
      userId: schema.screenshots.userId,
      id: schema.screenshots.id,
      capturedAt: schema.screenshots.capturedAt,
    })
    .from(schema.screenshots)
    .where(
      and(
        eq(schema.screenshots.organizationId, orgId),
        inArray(schema.screenshots.userId, userIds),
      ),
    )
    .orderBy(schema.screenshots.userId, desc(schema.screenshots.capturedAt));
  for (const r of rows) out.set(r.userId, { id: r.id, capturedAt: r.capturedAt });
  return out;
}

export interface DayScreenshot {
  id: string;
  capturedAt: Date;
  appName: string | null;
  activityScore: number | null;
}

/** A single user's screenshots within [dayStart, dayEnd), oldest first. */
export async function listForUserDay(
  tx: DB,
  orgId: string,
  userId: string,
  dayStart: Date,
  dayEnd: Date,
): Promise<DayScreenshot[]> {
  return tx
    .select({
      id: schema.screenshots.id,
      capturedAt: schema.screenshots.capturedAt,
      appName: schema.screenshots.appName,
      activityScore: schema.screenshots.activityScore,
    })
    .from(schema.screenshots)
    .where(
      and(
        eq(schema.screenshots.organizationId, orgId),
        eq(schema.screenshots.userId, userId),
        gte(schema.screenshots.capturedAt, dayStart),
        lt(schema.screenshots.capturedAt, dayEnd),
      ),
    )
    .orderBy(asc(schema.screenshots.capturedAt));
}
