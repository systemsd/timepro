import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { schema, withTenant } from '@timepro/db';
import { onPresenceChange, presenceSnapshot, type PresenceChange } from '../lib/presence';
import { resolveVisibleUserIds } from '../lib/access';

/**
 * Realtime presence channel (B10 / Phase 5, sub-phase 5E).
 *
 * Replaces the web app's 30s roster poll for presence: clients open a websocket,
 * receive a snapshot of who's online, then live `update` frames as the in-memory
 * presence store transitions (heartbeat start/stop, TTL expiry → offline).
 *
 * Auth mirrors the HTTP dev shim (`requireAuth`): the browser WebSocket API can't
 * set headers, so org/user arrive as query params. Anyone who can see someone
 * other than themselves (admin, team manager, a lead in the OpsCore reporting
 * chain, or a view grant) may subscribe, and receives presence only for the
 * members they can see; others are closed. Replace the query-param shim with
 * the cookie/JWT path when real auth lands.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const realtimeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/realtime/presence', { websocket: true }, async (socket, req) => {
    const q = req.query as { org?: string; user?: string };
    const orgId = q.org;
    const userId = q.user;
    if (!orgId || !userId || !UUID_RE.test(orgId) || !UUID_RE.test(userId)) {
      socket.close(1008, 'auth');
      return;
    }

    // Scope gate — presence is only for the members this user can view.
    let visible: string[] | 'all' = [];
    try {
      visible = await withTenant(orgId, async (tx) => {
        const [m] = await tx
          .select({ role: schema.memberships.role })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.organizationId, orgId),
              eq(schema.memberships.userId, userId),
            ),
          )
          .limit(1);
        if (!m) return [];
        return resolveVisibleUserIds(tx, orgId, userId, m.role);
      });
    } catch {
      socket.close(1011, 'auth-error');
      return;
    }
    const scope = visible === 'all' ? null : new Set(visible);
    if (scope && !Array.from(scope).some((id) => id !== userId)) {
      socket.close(1008, 'forbidden');
      return;
    }
    const inScope = (id: string) => scope === null || scope.has(id);

    const send = (payload: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    };

    // initial snapshot of everyone visible who is currently non-offline
    send({ type: 'snapshot', presence: presenceSnapshot(orgId).filter((p) => inScope(p.user_id)) });

    const unsub = onPresenceChange((c: PresenceChange) => {
      if (c.orgId !== orgId || !inScope(c.userId)) return;
      send({ type: 'update', user_id: c.userId, state: c.state });
    });

    socket.on('close', unsub);
    socket.on('error', unsub);
  });
};
