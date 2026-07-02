import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  buildWeeks,
  dateRange,
  dayIndexInWeek,
  isWeekendLocal,
  localDateToUtcMs,
  meanScore,
  overlapSeconds,
  pivot,
  utcMsToLocalDate,
  weekStartLocal,
  type FlatEntry,
} from './report-time';

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
const PKT = -300; // UTC+5 (getTimezoneOffset returns minutes to add to reach UTC)

describe('date helpers', () => {
  it('round-trips local date ↔ UTC ms at UTC and UTC+5', () => {
    for (const tz of [UTC, PKT]) {
      const ms = localDateToUtcMs('2026-01-15', tz);
      expect(utcMsToLocalDate(ms, tz)).toBe('2026-01-15');
    }
  });

  it('places local midnight correctly for UTC+5', () => {
    // Local midnight 2026-01-15 in UTC+5 is 19:00 UTC the previous day.
    expect(localDateToUtcMs('2026-01-15', PKT)).toBe(Date.UTC(2026, 0, 14, 19, 0, 0));
  });

  it('isWeekendLocal flags Sat/Sun only', () => {
    expect(isWeekendLocal('2024-01-06')).toBe(true); // Saturday
    expect(isWeekendLocal('2024-01-07')).toBe(true); // Sunday
    expect(isWeekendLocal('2024-01-08')).toBe(false); // Monday
  });

  it('dateRange is inclusive and crosses month boundaries', () => {
    expect(dateRange('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02',
    ]);
    expect(dateRange('2026-03-03', '2026-03-03')).toEqual(['2026-03-03']);
  });

  it('overlapSeconds clips to the window and floors to whole seconds', () => {
    expect(overlapSeconds(1_000, 5_000, 2_000, 4_000)).toBe(2); // [2s,4s) → 2s
    expect(overlapSeconds(0, 1_000, 5_000, 9_000)).toBe(0); // disjoint
    expect(overlapSeconds(0, 3_500, 0, 10_000)).toBe(3); // floors 3.5 → 3
  });
});

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
    // Sunday hour → prior week's Sun slot (index 6); Monday hour → next week's Mon slot (index 0)
    expect(weeks[0]!.rows[0]!.days[6]).toBe(3600);
    expect(weeks[1]!.rows[0]!.days[0]).toBe(3600);
  });
});

describe('weekStartLocal / dayIndexInWeek', () => {
  it('weekStartLocal returns the containing Monday', () => {
    expect(weekStartLocal('2024-01-06')).toBe('2024-01-01'); // Sat → Mon
    expect(weekStartLocal('2024-01-07')).toBe('2024-01-01'); // Sun → Mon
    expect(weekStartLocal('2024-01-08')).toBe('2024-01-08'); // Mon → itself
  });
  it('dayIndexInWeek is 0 for Monday, 6 for Sunday', () => {
    expect(dayIndexInWeek('2024-01-08')).toBe(0);
    expect(dayIndexInWeek('2024-01-07')).toBe(6);
  });
});
