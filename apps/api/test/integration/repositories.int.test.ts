import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@timepro/db';
import { buildTestApp, resetDb, seedOrg, seedScreenshot, seedTimeEntry, seedUser } from './helpers';
import {
  getCurrentTimer,
  listForUsersStartedSince,
} from '../../src/repositories/time-entries';
import { getLatestPerUser } from '../../src/repositories/screenshots';

/** Locks the exemplar repositories directly against the DB. */
describe('repositories', () => {
  beforeAll(async () => { await buildTestApp(); }); // initializes the DB pool
  afterAll(async () => { /* pool closed by process exit */ });
  beforeEach(resetDb);

  it('getCurrentTimer returns the open entry, or null', async () => {
    const org = await seedOrg('Org', 'org');
    const user = await seedUser(org, { name: 'Emp', role: 'employee' });
    expect(await getCurrentTimer(getDb(), org, user)).toBeNull();

    // a closed entry doesn't count
    await seedTimeEntry(org, user, { startedAt: new Date('2026-01-01T09:00Z'), endedAt: new Date('2026-01-01T10:00Z') });
    expect(await getCurrentTimer(getDb(), org, user)).toBeNull();

    // an open entry does
    const openId = await seedTimeEntry(org, user, { startedAt: new Date('2026-01-01T11:00Z'), endedAt: null });
    const cur = await getCurrentTimer(getDb(), org, user);
    expect(cur?.id).toBe(openId);
  });

  it('listForUsersStartedSince filters by since + org, newest first', async () => {
    const org = await seedOrg('Org', 'org');
    const other = await seedOrg('Other', 'other');
    const user = await seedUser(org, { name: 'Emp', role: 'employee' });
    const stranger = await seedUser(other, { name: 'Str', role: 'employee' });

    await seedTimeEntry(org, user, { startedAt: new Date('2026-01-01T09:00Z'), endedAt: new Date('2026-01-01T10:00Z') }); // before since
    const midId = await seedTimeEntry(org, user, { startedAt: new Date('2026-01-05T09:00Z'), endedAt: new Date('2026-01-05T10:00Z') });
    const lateId = await seedTimeEntry(org, user, { startedAt: new Date('2026-01-06T09:00Z'), endedAt: null });
    await seedTimeEntry(other, stranger, { startedAt: new Date('2026-01-06T09:00Z'), endedAt: null }); // other org

    const rows = await listForUsersStartedSince(getDb(), org, [user], new Date('2026-01-05T00:00Z'));
    expect(rows.map((r) => r.id)).toEqual([lateId, midId]); // newest first, org-scoped, since-filtered
  });

  it('getLatestPerUser returns exactly the newest screenshot per user', async () => {
    const org = await seedOrg('Org', 'org');
    const a = await seedUser(org, { name: 'A', role: 'employee' });
    const b = await seedUser(org, { name: 'B', role: 'employee' });
    await seedScreenshot(org, a, new Date('2026-01-01T08:00Z'));
    const aNewest = await seedScreenshot(org, a, new Date('2026-01-01T10:00Z'));
    const bOnly = await seedScreenshot(org, b, new Date('2026-01-01T09:00Z'));

    const map = await getLatestPerUser(getDb(), org, [a, b]);
    expect(map.get(a)?.id).toBe(aNewest);
    expect(map.get(b)?.id).toBe(bOnly);
    expect(map.size).toBe(2);
  });
});
