import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Point uploads at a throwaway dir before the app reads config.
process.env.STORAGE_DIR ??= mkdtempSync(join(tmpdir(), 'tp-shots-'));

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { buildTestApp, resetDb, seedOrg, seedUser, seedTimeEntry, authHeaders } from './helpers';

/** Build a multipart/form-data body with the `meta` JSON field + `image` file. */
function multipart(meta: object, png: Buffer): { payload: Buffer; contentType: string } {
  const boundary = `----tp${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="meta"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="s.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, png, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

const png = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();

describe('screenshot upload — reject shots against a closed timer entry', () => {
  let app: FastifyInstance;
  let org: string;
  let user: string;
  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await resetDb();
    org = await seedOrg('Org', 'org');
    user = await seedUser(org, { name: 'Emp', role: 'employee' });
  });

  const upload = async (timeEntryId: string) => {
    const body = multipart(
      { client_event_id: randomUUID(), captured_at: new Date().toISOString(), time_entry_id: timeEntryId, monitor_index: 0 },
      await png(),
    );
    return app.inject({
      method: 'POST',
      url: '/v1/screenshots',
      headers: { ...authHeaders(org, user), 'content-type': body.contentType },
      payload: body.payload,
    });
  };

  it('accepts a shot for an OPEN entry', async () => {
    const open = await seedTimeEntry(org, user, { startedAt: new Date(Date.now() - 60_000), endedAt: null });
    const res = await upload(open);
    expect(res.statusCode).toBe(200);
  });

  it('rejects a shot for a CLOSED entry with 409 entry_closed (the desync guard)', async () => {
    const closed = await seedTimeEntry(org, user, {
      startedAt: new Date(Date.now() - 120_000),
      endedAt: new Date(Date.now() - 60_000),
    });
    const res = await upload(closed);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('entry_closed');
  });
});
