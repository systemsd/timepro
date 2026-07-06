import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { getDb, schema } from '@timepro/db';
import { buildTestApp, resetDb, seedOrg, seedUser, ZERO_DEVICE } from './helpers';
import { signImageToken } from '../../src/lib/signed-url';

/** Seed a screenshot row pointing at a real PNG on disk; return its id. */
async function seedShotWithFile(orgId: string, userId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tp-ss-'));
  const path = join(dir, `${randomUUID()}.png`);
  const png = await sharp({
    create: { width: 640, height: 400, channels: 3, background: { r: 90, g: 110, b: 200 } },
  }).png().toBuffer();
  await writeFile(path, png);
  const [row] = await getDb()
    .insert(schema.screenshots)
    .values({
      organizationId: orgId,
      userId,
      deviceId: ZERO_DEVICE,
      capturedAt: new Date(),
      s3Key: path,
      clientEventId: `sh-${randomUUID()}`,
    })
    .returning({ id: schema.screenshots.id });
  return row!.id;
}

describe('signed screenshot thumbnails', () => {
  let app: FastifyInstance;
  let org: string;
  let user: string;
  let other: string;
  let shotId: string;
  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await resetDb();
    org = await seedOrg('Org', 'org');
    user = await seedUser(org, { name: 'Emp', role: 'employee' });
    other = await seedUser(org, { name: 'Other', role: 'employee' });
    shotId = await seedShotWithFile(org, user);
  });

  const get = (id: string, token: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/v1/screenshots/${id}/thumb?t=${encodeURIComponent(token)}`, headers });

  it('returns a WebP thumbnail immutably cached with an ETag', async () => {
    const res = await get(shotId, signImageToken(org, user));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['etag']).toBeTruthy();
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it('honors If-None-Match with 304', async () => {
    const token = signImageToken(org, user);
    const first = await get(shotId, token);
    const etag = first.headers['etag'] as string;
    const second = await get(shotId, token, { 'if-none-match': etag });
    expect(second.statusCode).toBe(304);
  });

  it('rejects a token for a different target user (403 — no IDOR)', async () => {
    const res = await get(shotId, signImageToken(org, other)); // token for `other`, shot is `user`'s
    expect(res.statusCode).toBe(403);
  });

  it('rejects an expired or tampered token (401)', async () => {
    const expired = signImageToken(org, user, 60, Date.now() - 120_000);
    expect((await get(shotId, expired)).statusCode).toBe(401);
    const good = signImageToken(org, user);
    expect((await get(shotId, good + 'x')).statusCode).toBe(401);
  });
});
