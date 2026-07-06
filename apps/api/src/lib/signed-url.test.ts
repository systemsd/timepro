import { beforeAll, describe, expect, it } from 'vitest';
import { signImageToken, verifyImageToken } from './signed-url';

beforeAll(() => {
  process.env.AUTH_INTERNAL_SHARED_SECRET = 'unit-test-image-signing-secret';
});

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

describe('image URL signing', () => {
  it('round-trips a valid token', () => {
    const tok = signImageToken(ORG, USER);
    expect(verifyImageToken(tok)).toEqual({ orgId: ORG, targetUserId: USER });
  });

  it('rejects an expired token', () => {
    const t0 = 1_000_000_000_000;
    const tok = signImageToken(ORG, USER, 60, t0); // expires at t0 + 60s
    expect(verifyImageToken(tok, t0 + 30_000)).not.toBeNull(); // still valid
    expect(verifyImageToken(tok, t0 + 61_000)).toBeNull(); // expired
  });

  it('rejects a tampered payload or signature', () => {
    const tok = signImageToken(ORG, USER);
    const [body, sig] = tok.split('.');
    expect(verifyImageToken(`${body}x.${sig}`)).toBeNull(); // body changed
    expect(verifyImageToken(`${body}.${sig}x`)).toBeNull(); // sig changed
    expect(verifyImageToken('garbage')).toBeNull();
    expect(verifyImageToken(undefined)).toBeNull();
  });

  it('does not verify under a different secret', () => {
    const tok = signImageToken(ORG, USER);
    process.env.AUTH_INTERNAL_SHARED_SECRET = 'a-different-secret-entirely';
    expect(verifyImageToken(tok)).toBeNull();
    process.env.AUTH_INTERNAL_SHARED_SECRET = 'unit-test-image-signing-secret'; // restore
  });
});
