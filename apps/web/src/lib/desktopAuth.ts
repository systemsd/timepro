/**
 * Shared key for the desktop OpsCore login bridge (Phase 3 — desktop).
 * The `/desktop-auth` page stashes `{ port, state }` here; `/auth/opscore`
 * reads it to forward the token to the agent's loopback. Lives in lib/ (not a
 * page) because Next App Router pages may only export `default` + framework keys.
 */
export const DESKTOP_AUTH_KEY = 'tp_desktop_auth';
