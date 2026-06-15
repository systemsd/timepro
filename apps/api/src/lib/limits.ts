import { and, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import { schema, type DB } from '@timepro/db';
import { getOrgDefaults } from './settings';

/**
 * Weekly time-limit enforcement (B7 / Phase 5, the "weekly-limit" piece).
 *
 * The limit is the effective `limits.weekly_hours` setting (org default ← per-user
 * override, C5). `0` = unlimited. Usage is tracked seconds in the current week,
 * computed on the fly (no rollups). Surfaced on the roster + My Home, and enforced
 * at timer start (you can't start a new timer once you're at/over the cap).
 */
const WEEKLY_KEY = 'limits.weekly_hours';

/** Monday 00:00 (viewer-local) as real UTC ms — same basis as the roster (C6). */
export function mondayWeekStartMs(tzOffsetMinutes: number, nowMs = Date.now()): number {
  const shifted = new Date(nowMs - tzOffsetMinutes * 60_000);
  const todayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) +
    tzOffsetMinutes * 60_000;
  const mondayOffset = (shifted.getUTCDay() + 6) % 7; // days since Monday
  return todayStart - mondayOffset * 86_400_000;
}

function overlapSeconds(start: number, end: number, winStart: number, winEnd: number): number {
  const s = Math.max(start, winStart);
  const e = Math.min(end, winEnd);
  return e > s ? Math.floor((e - s) / 1000) : 0;
}

/**
 * Effective weekly-hour limit for each user (org default ← user override).
 * Batched: one org-defaults read + one overrides read, regardless of user count.
 */
export async function resolveWeeklyLimitHours(
  tx: DB,
  orgId: string,
  userIds: string[],
): Promise<Map<string, number>> {
  const orgDefaults = await getOrgDefaults(tx, orgId);
  const orgLimit = Number(orgDefaults[WEEKLY_KEY] ?? 40);
  const map = new Map<string, number>();
  for (const id of userIds) map.set(id, orgLimit);
  if (userIds.length === 0) return map;

  const overrides = await tx
    .select({ scopeId: schema.settingsScoped.scopeId, value: schema.settingsScoped.value })
    .from(schema.settingsScoped)
    .where(
      and(
        eq(schema.settingsScoped.organizationId, orgId),
        eq(schema.settingsScoped.scopeType, 'user'),
        eq(schema.settingsScoped.key, WEEKLY_KEY),
        inArray(schema.settingsScoped.scopeId, userIds),
      ),
    );
  for (const o of overrides) map.set(o.scopeId, Number(o.value));
  return map;
}

/** Tracked seconds for one user within [weekStartMs, nowMs]. */
export async function weeklyTrackedSeconds(
  tx: DB,
  orgId: string,
  userId: string,
  weekStartMs: number,
  nowMs: number,
): Promise<number> {
  const entries = await tx
    .select({ startedAt: schema.timeEntries.startedAt, endedAt: schema.timeEntries.endedAt })
    .from(schema.timeEntries)
    .where(
      and(
        eq(schema.timeEntries.organizationId, orgId),
        eq(schema.timeEntries.userId, userId),
        isNull(schema.timeEntries.deletedAt),
        lt(schema.timeEntries.startedAt, new Date(nowMs)),
        or(
          isNull(schema.timeEntries.endedAt),
          gte(schema.timeEntries.endedAt, new Date(weekStartMs)),
        ),
      ),
    );
  let secs = 0;
  for (const e of entries) {
    const s = e.startedAt.getTime();
    const en = e.endedAt ? e.endedAt.getTime() : nowMs;
    secs += overlapSeconds(s, en, weekStartMs, nowMs);
  }
  return secs;
}
