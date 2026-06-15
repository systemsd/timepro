import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { schema, withTenant } from '@timepro/db';
import { onPresenceChange, presenceSnapshot, type PresenceChange } from '../lib/presence';

/**
 * Realtime presence channel (B10 / Phase 5, sub-phase 5E).
 *
 * Replaces the web app's 30s roster poll for presence: clients open a websocket,
 * receive a snapshot of who's online, then live `update` frames as the in-memory
 * presence store transitions (heartbeat start/stop, TTL expiry → offline).
 *
 * Auth mirrors the HTTP dev shim (`requireAuth`): the browser WebSocket API can't
 * set headers, so org/user arrive as query params. Only managers/admins/owner —
 * the surfaces that render presence — may subscribe; others are closed. Replace
 * the query-param shim with the cookie/JWT path when real auth lands.
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

    // Role gate — presence is only consumed by manager/admin/owner surfaces.
    let role = 'none';
    try {
      role = await withTenant(orgId, async (tx) => {
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
        return m?.role ?? 'none';
      });
    } catch {
      socket.close(1011, 'auth-error');
      return;
    }
    if (!['owner', 'admin', 'manager'].includes(role)) {
      socket.close(1008, 'forbidden');
      return;
    }

    const send = (payload: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    };

    // initial snapshot of everyone currently non-offline in this org
    send({ type: 'snapshot', presence: presenceSnapshot(orgId) });

    const unsub = onPresenceChange((c: PresenceChange) => {
      if (c.orgId !== orgId) return;
      send({ type: 'update', user_id: c.userId, state: c.state });
    });

    socket.on('close', unsub);
    socket.on('error', unsub);
  });
};
