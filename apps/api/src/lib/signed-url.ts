import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed tokens for the screenshot image routes.
 *
 * Images are served with native `<img>` (no auth header possible), so the
 * screenshot-listing endpoints (timeline, roster) mint a token that authorizes
 * the *viewer* to fetch screenshots of a specific target user until it expires.
 * The image route verifies the token and that the screenshot belongs to
 * `{ orgId, targetUserId }` — so a token can't reach another user's screenshots
 * (also closes the old header-based IDOR on `/raw`). HMAC-SHA256, base64url.
 */

const DEFAULT_TTL_SEC = 3600;

interface Payload {
  o: string; // organization id
  u: string; // target user id (whose screenshots this authorizes)
  e: number; // expiry, epoch seconds
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function secret(): string {
  // Same secret `config.ts` validates (min 16). Read from env directly so signing
  // doesn't drag in the full config (and its DB requirements) — the app boot
  // (loadRootEnv) and tests both populate this.
  const s = process.env.AUTH_INTERNAL_SHARED_SECRET;
  if (!s) throw new Error('AUTH_INTERNAL_SHARED_SECRET is not set');
  return s;
}

function sign(body: string): string {
  return b64url(createHmac('sha256', secret()).update(body).digest());
}

/** Sign a token authorizing screenshots of `targetUserId` in `orgId` for `ttlSec`. */
export function signImageToken(
  orgId: string,
  targetUserId: string,
  ttlSec = DEFAULT_TTL_SEC,
  nowMs = Date.now(),
): string {
  const payload: Payload = { o: orgId, u: targetUserId, e: Math.floor(nowMs / 1000) + ttlSec };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${sign(body)}`;
}

/** Verify a token; returns its scope, or null if malformed / tampered / expired. */
export function verifyImageToken(
  token: string | undefined,
  nowMs = Date.now(),
): { orgId: string; targetUserId: string } | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.o !== 'string' || typeof payload.u !== 'string' || typeof payload.e !== 'number') {
    return null;
  }
  if (payload.e * 1000 <= nowMs) return null; // expired
  return { orgId: payload.o, targetUserId: payload.u };
}
