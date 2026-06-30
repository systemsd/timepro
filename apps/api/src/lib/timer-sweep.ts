import { and, eq, gt, inArray, isNull, max, or, sql } from 'drizzle-orm';
import { asPlatform, schema, type DB } from '@timepro/db';
import { recordAudit } from './audit';

/**
 * Abandoned-timer sweep.
 *
 * If a machine sleeps (lid closed) or the agent crashes/is force-quit while a
 * timer is running, the entry is left open — and the roster/reports count an open
 * entry right up to `now`, so a single forgotten timer can be billed as hours or
 * days of "work" (inflated dashboards). The desktop agent back-dates on wake, but
 * it can't help if it never wakes. This server-side safety net is agent-independent.
 *
 * Each run, for every recent entry that's still open OR implausibly long, we find
 * the user's last real activity *inside* the entry (latest screenshot / activity
 * sample / app-usage — all of which stop the instant the machine sleeps) and, if
 * there's a long dead tail after it, clamp `ended_at` back to that last activity.
 * An actively-tracking user is never touched (their last activity is seconds old).
 * Cross-tenant maintenance → runs under `asPlatform`. Every change is audited.
 */

const MIN = 60_000;
const LOOKBACK_MS = 40 * 86_400_000; // only scan the last ~40 days (covers the month window)
const SUSPECT_MIN_MS = 30 * MIN; // ignore short closed entries; only inspect open or >30 min ones
const DEAD_GAP_MS = 15 * MIN; // no activity signal for >15 min = machine asleep / agent gone
const GRACE_MS = 1 * MIN; // keep up to 1 min past the last activity

/** Latest activity timestamp (ms) recorded against each of the given time-entry ids. */
async function lastActivityByEntry(tx: DB, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const bump = (id: string | null, at: Date | null) => {
    if (!id || !at) return;
    const ms = at.getTime();
    const cur = out.get(id);
    if (cur === undefined || ms > cur) out.set(id, ms);
  };

  const shots = await tx
    .select({ id: schema.screenshots.timeEntryId, at: max(schema.screenshots.capturedAt) })
    .from(schema.screenshots)
    .where(inArray(schema.screenshots.timeEntryId, ids))
    .groupBy(schema.screenshots.timeEntryId);
  for (const r of shots) bump(r.id, r.at);

  const samples = await tx
    .select({ id: schema.activitySamples.timeEntryId, at: max(schema.activitySamples.bucketMinute) })
    .from(schema.activitySamples)
    .where(inArray(schema.activitySamples.timeEntryId, ids))
    .groupBy(schema.activitySamples.timeEntryId);
  for (const r of samples) bump(r.id, r.at);

  const apps = await tx
    .select({ id: schema.appUsage.timeEntryId, at: max(schema.appUsage.endedAt) })
    .from(schema.appUsage)
    .where(inArray(schema.appUsage.timeEntryId, ids))
    .groupBy(schema.appUsage.timeEntryId);
  for (const r of apps) bump(r.id, r.at);

  return out;
}

/**
 * Close/trim abandoned timers across all orgs. Idempotent — a corrected entry's
 * tail gap shrinks below threshold, so it isn't touched again. Returns counts.
 */
export async function sweepAbandonedTimers(): Promise<{ scanned: number; corrected: number }> {
  return asPlatform(async (tx) => {
    const now = Date.now();

    const suspects = await tx
      .select({
        id: schema.timeEntries.id,
        orgId: schema.timeEntries.organizationId,
        userId: schema.timeEntries.userId,
        startedAt: schema.timeEntries.startedAt,
        endedAt: schema.timeEntries.endedAt,
      })
      .from(schema.timeEntries)
      .where(
        and(
          isNull(schema.timeEntries.deletedAt),
          gt(schema.timeEntries.startedAt, new Date(now - LOOKBACK_MS)),
          or(
            isNull(schema.timeEntries.endedAt), // still running
            sql`${schema.timeEntries.endedAt} - ${schema.timeEntries.startedAt} > make_interval(secs => ${SUSPECT_MIN_MS / 1000})`,
          ),
        ),
      );
    if (suspects.length === 0) return { scanned: 0, corrected: 0 };

    const lastAct = await lastActivityByEntry(tx, suspects.map((s) => s.id));

    let corrected = 0;
    for (const e of suspects) {
      // Only act on entries that have a real activity signal — if an entry has no
      // screenshots/samples/app-usage at all (e.g. all tracking disabled), we can't
      // tell "asleep" from "working", so leave it untouched rather than risk zeroing
      // legitimate time.
      const signalMs = lastAct.get(e.id);
      if (signalMs === undefined) continue;

      const startMs = e.startedAt.getTime();
      const effEnd = e.endedAt ? e.endedAt.getTime() : now;
      const lastActive = Math.max(startMs, signalMs);
      if (effEnd - lastActive <= DEAD_GAP_MS) continue; // active tail / normal entry — leave it

      const newEndMs = Math.min(effEnd, lastActive + GRACE_MS);
      if (newEndMs >= effEnd) continue; // nothing to trim (shouldn't happen given the gap check)
      const newEnd = new Date(newEndMs);

      await tx
        .update(schema.timeEntries)
        .set({ endedAt: newEnd, updatedAt: new Date(), source: 'system' })
        .where(eq(schema.timeEntries.id, e.id));

      await recordAudit(tx, {
        organizationId: e.orgId,
        actorUserId: null,
        actorType: 'system',
        action: 'time_entry.auto_closed',
        targetType: 'time_entry',
        targetId: e.id,
        metadata: {
          was_open: e.endedAt === null,
          old_ended_at: e.endedAt ? e.endedAt.toISOString() : null,
          new_ended_at: newEnd.toISOString(),
          trimmed_seconds: Math.round((effEnd - newEndMs) / 1000),
          reason: 'no activity (machine asleep / agent stopped); back-dated to last activity',
        },
      });
      corrected++;
    }
    return { scanned: suspects.length, corrected };
  });
}
