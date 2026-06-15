import { randomBytes } from 'node:crypto';

/**
 * One-time, short-lived auth handoff codes for desktop → web auto-login.
 *
 * The desktop agent (already authenticated) asks the API to mint a code,
 * opens the browser to `…/auth/handoff?code=…`, and the web app exchanges
 * the code for a session. The code is:
 *   - random + high-entropy (32 bytes)
 *   - single-use (deleted on consume)
 *   - short-lived (60s)
 *
 * We never put the real session token in a URL — only this exchange code.
 *
 * MVP uses an in-process Map (fine for a single API instance). In production
 * this moves to Redis with the same create/consume contract so it works
 * across horizontally-scaled API pods.
 */
interface HandoffEntry {
  userId: string;
  organizationId: string;
  expiresAt: number;
}

const store = new Map<string, HandoffEntry>();
const TTL_MS = 60_000;

export function createHandoff(userId: string, organizationId: string): {
  code: string;
  expiresAt: number;
} {
  const code = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + TTL_MS;
  store.set(code, { userId, organizationId, expiresAt });
  return { code, expiresAt };
}

export function consumeHandoff(code: string): HandoffEntry | null {
  const entry = store.get(code);
  if (!entry) return null;
  store.delete(code); // single-use, even if expired
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

// Periodic sweep so abandoned codes don't accumulate.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of store) {
    if (entry.expiresAt < now) store.delete(code);
  }
}, 30_000);
sweep.unref();
