/**
 * Presence (B3). Tracks which users have a live agent and whether they're
 * actively tracking, giving the three states from C4:
 *   - offline    → no fresh heartbeat
 *   - connected  → fresh heartbeat, app open, not tracking
 *   - tracking   → fresh heartbeat, timer running
 *
 * MVP is an in-process map (single API instance). The architecture's Redis
 * presence keys (`presence:org:<id>:user:<id>` with TTL) are a drop-in
 * replacement with the same record/read contract once we scale out.
 */
export type PresenceState = 'offline' | 'connected' | 'tracking';

interface Entry {
  lastSeen: number;
  isTracking: boolean;
}

const store = new Map<string, Entry>();
const TTL_MS = 90_000; // grey after 90s of silence

const key = (orgId: string, userId: string) => `${orgId}:${userId}`;

export function recordHeartbeat(orgId: string, userId: string, isTracking: boolean): void {
  store.set(key(orgId, userId), { lastSeen: Date.now(), isTracking });
}

export function getPresence(orgId: string, userId: string): PresenceState {
  const e = store.get(key(orgId, userId));
  if (!e || Date.now() - e.lastSeen > TTL_MS) return 'offline';
  return e.isTracking ? 'tracking' : 'connected';
}

/** How many of the given users are non-offline (for "N online" headlines). */
export function onlineCount(orgId: string, userIds: string[]): number {
  return userIds.reduce((n, u) => (getPresence(orgId, u) !== 'offline' ? n + 1 : n), 0);
}

// periodic cleanup of stale entries
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, e] of store) if (now - e.lastSeen > TTL_MS) store.delete(k);
}, 60_000);
sweep.unref();
