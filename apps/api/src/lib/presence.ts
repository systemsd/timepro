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
import { EventEmitter } from 'node:events';

export type PresenceState = 'offline' | 'connected' | 'tracking';

interface Entry {
  orgId: string;
  userId: string;
  lastSeen: number;
  isTracking: boolean;
}

const store = new Map<string, Entry>();
const TTL_MS = 90_000; // grey after 90s of silence

const key = (orgId: string, userId: string) => `${orgId}:${userId}`;

/**
 * Realtime fan-out (B10 / 5E). Emits a `change` event whenever a user's derived
 * `PresenceState` transitions, so websocket subscribers can push live dots
 * instead of the web app polling. In-process today; a Redis pub/sub channel is
 * the drop-in replacement when the API scales past one instance.
 */
export interface PresenceChange {
  orgId: string;
  userId: string;
  state: PresenceState;
}
const emitter = new EventEmitter();
emitter.setMaxListeners(0); // one listener per open socket — don't warn

/** Subscribe to presence transitions; returns an unsubscribe fn. */
export function onPresenceChange(fn: (c: PresenceChange) => void): () => void {
  emitter.on('change', fn);
  return () => emitter.off('change', fn);
}

function derive(e: Entry | undefined): PresenceState {
  if (!e || Date.now() - e.lastSeen > TTL_MS) return 'offline';
  return e.isTracking ? 'tracking' : 'connected';
}

export function recordHeartbeat(orgId: string, userId: string, isTracking: boolean): void {
  const k = key(orgId, userId);
  const prev = derive(store.get(k));
  store.set(k, { orgId, userId, lastSeen: Date.now(), isTracking });
  const next: PresenceState = isTracking ? 'tracking' : 'connected';
  if (prev !== next) emitter.emit('change', { orgId, userId, state: next } satisfies PresenceChange);
}

export function getPresence(orgId: string, userId: string): PresenceState {
  return derive(store.get(key(orgId, userId)));
}

/** Non-offline users in an org — the initial snapshot for a new subscriber. */
export function presenceSnapshot(orgId: string): Array<{ user_id: string; state: PresenceState }> {
  const now = Date.now();
  const out: Array<{ user_id: string; state: PresenceState }> = [];
  for (const e of store.values()) {
    if (e.orgId === orgId && now - e.lastSeen <= TTL_MS) {
      out.push({ user_id: e.userId, state: e.isTracking ? 'tracking' : 'connected' });
    }
  }
  return out;
}

/** How many of the given users are non-offline (for "N online" headlines). */
export function onlineCount(orgId: string, userIds: string[]): number {
  return userIds.reduce((n, u) => (getPresence(orgId, u) !== 'offline' ? n + 1 : n), 0);
}

// periodic cleanup of stale entries — a transition to offline is broadcast too
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, e] of store) {
    if (now - e.lastSeen > TTL_MS) {
      store.delete(k);
      emitter.emit('change', { orgId: e.orgId, userId: e.userId, state: 'offline' } satisfies PresenceChange);
    }
  }
}, 30_000);
sweep.unref();
