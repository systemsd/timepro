'use client';

import { useEffect, useState } from 'react';
import { API_BASE, type Presence } from './api';
import { loadSession } from './session';

/**
 * Realtime presence (B10 / 5E). Subscribes to the API websocket and exposes a
 * live `{ userId: state }` map, replacing the dashboard's presence poll. Dots
 * flip the instant an agent starts/stops tracking or drops offline.
 *
 * One shared socket per tab (ref-counted) feeds every component that calls the
 * hook — TopNav + dashboard don't each open their own connection. Auto-reconnects
 * with backoff. Only manager/admin/owner sessions are accepted by the server.
 */
type PresenceMap = Record<string, Presence>;

let socket: WebSocket | null = null;
let presenceState: PresenceMap = {};
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closedByUs = false;
const listeners = new Set<(s: PresenceMap) => void>();

function publish() {
  for (const l of listeners) l(presenceState);
}

const PRESENCE_ROLES = ['owner', 'admin', 'manager'];

function connect() {
  const s = loadSession();
  // Only presence-consuming roles subscribe; the server rejects others, so
  // opening a socket for an employee would just churn in a reconnect loop.
  if (!s || !PRESENCE_ROLES.includes(s.role)) return;
  closedByUs = false;
  const url =
    API_BASE.replace(/^http/, 'ws') +
    `/v1/realtime/presence?org=${encodeURIComponent(s.organization_id)}&user=${encodeURIComponent(s.user_id)}`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') {
        const next: PresenceMap = {};
        for (const p of msg.presence as Array<{ user_id: string; state: Presence }>) next[p.user_id] = p.state;
        presenceState = next;
        publish();
      } else if (msg.type === 'update') {
        presenceState = { ...presenceState, [msg.user_id]: msg.state as Presence };
        publish();
      }
    } catch {
      /* ignore malformed frame */
    }
  };
  ws.onclose = (ev) => {
    socket = null;
    // 1008 = policy violation (auth/forbidden) — don't hammer a reconnect loop.
    if (!closedByUs && refCount > 0 && ev.code !== 1008) {
      reconnectTimer = setTimeout(connect, 3000);
    }
  };
  ws.onerror = () => {
    try { ws.close(); } catch { /* noop */ }
  };
}

function teardown() {
  closedByUs = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { socket?.close(); } catch { /* noop */ }
  socket = null;
  presenceState = {};
}

export function useRealtimePresence(): PresenceMap {
  const [snap, setSnap] = useState<PresenceMap>(presenceState);
  useEffect(() => {
    refCount += 1;
    if (refCount === 1) connect();
    const l = (s: PresenceMap) => setSnap(s);
    listeners.add(l);
    setSnap(presenceState);
    return () => {
      listeners.delete(l);
      refCount -= 1;
      if (refCount === 0) teardown();
    };
  }, []);
  return snap;
}
