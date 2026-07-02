import { describe, expect, it } from 'vitest';
import { buildGroups, buildWeeks, meanScore, pivot, type FlatEntry } from './report-time';

/** Build a FlatEntry with sensible defaults for the fields a test doesn't care about. */
function entry(p: Partial<FlatEntry>): FlatEntry {
  return {
    entryId: 'e', userId: 'u', displayName: 'User', projectId: null, projectName: null,
    clientId: null, clientName: null, note: null, startMs: 0, endMs: 0, seconds: 0,
    isManual: false, activeSeconds: 0, idleSeconds: 0, scoreSum: 0, sampleCount: 0,
    ...p,
  };
}

const UTC = 0;

describe('meanScore', () => {
  it('returns null when there are no samples', () => {
    expect(meanScore(0, 0)).toBeNull();
  });
  it('rounds the mean', () => {
    expect(meanScore(300, 3)).toBe(100);
    expect(meanScore(250, 3)).toBe(83); // 83.33 → 83
  });
});

describe('buildGroups / pivot', () => {
  const entries = [
    entry({ userId: 'U1', displayName: 'Alice', projectId: 'P1', projectName: 'Web', seconds: 100, scoreSum: 160, sampleCount: 2 }),
    entry({ userId: 'U1', displayName: 'Alice', projectId: 'P2', projectName: 'Ops', seconds: 300, scoreSum: 150, sampleCount: 3 }),
    entry({ userId: 'U2', displayName: 'Bob', projectId: 'P1', projectName: 'Web', seconds: 50 }),
  ];

  it('nests employee → project, sorts desc by seconds, rolls up activity', () => {
    const groups = buildGroups(entries, ['employee', 'project']);
    expect(groups.map((g) => g.label)).toEqual(['Alice', 'Bob']); // 400 vs 50
    const alice = groups[0]!;
    expect(alice.seconds).toBe(400);
    expect(alice.activity_score).toBe(62); // (160+150)/(2+3)=62
    expect(alice.children!.map((c) => c.label)).toEqual(['Ops', 'Web']); // 300 vs 100
    const bob = groups[1]!;
    expect(bob.activity_score).toBeNull(); // no samples
  });

  it('pivots by a single dimension', () => {
    const byEmp = pivot(entries, 'employee');
    expect(byEmp.map((r) => [r.label, r.seconds])).toEqual([['Alice', 400], ['Bob', 50]]);
    expect(byEmp[0]!.activity_score).toBe(62);
  });
});

describe('buildWeeks (ISO week, Monday-start)', () => {
  it('buckets a single entry onto the right week + weekday', () => {
    const start = Date.UTC(2024, 0, 8, 9, 0, 0); // Mon 2024-01-08 09:00Z
    const weeks = buildWeeks([entry({ userId: 'U1', displayName: 'A', startMs: start, endMs: start + 2 * 3600_000, seconds: 7200 })], UTC);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.week_start).toBe('2024-01-08');
    expect(weeks[0]!.week_end).toBe('2024-01-14');
    expect(weeks[0]!.rows[0]!.days).toEqual([7200, 0, 0, 0, 0, 0, 0]); // Monday slot
    expect(weeks[0]!.seconds).toBe(7200);
  });

  it('splits a Sun→Mon entry across two weeks by day boundary', () => {
    const start = Date.UTC(2024, 0, 7, 23, 0, 0); // Sun 23:00Z
    const end = Date.UTC(2024, 0, 8, 1, 0, 0); // Mon 01:00Z
    const weeks = buildWeeks([entry({ userId: 'U1', displayName: 'A', startMs: start, endMs: end, seconds: 7200 })], UTC);
    expect(weeks.map((w) => w.week_start)).toEqual(['2024-01-01', '2024-01-08']); // asc
    expect(weeks[0]!.rows[0]!.days[6]).toBe(3600); // Sunday hour → prior week
    expect(weeks[1]!.rows[0]!.days[0]).toBe(3600); // Monday hour → next week
  });
});
