import { describe, expect, it } from 'vitest';
import {
  bucketSecondsByDay,
  dateRange,
  dayIndexInWeek,
  isWeekendLocal,
  localDateToUtcMs,
  overlapSeconds,
  utcMsToLocalDate,
  weekStartLocal,
} from './time';

const UTC = 0;
const PKT = -300; // UTC+5 (getTimezoneOffset returns minutes to add to reach UTC)

describe('local date ↔ UTC ms', () => {
  it('round-trips at UTC and UTC+5', () => {
    for (const tz of [UTC, PKT]) {
      const ms = localDateToUtcMs('2026-01-15', tz);
      expect(utcMsToLocalDate(ms, tz)).toBe('2026-01-15');
    }
  });

  it('places local midnight correctly for UTC+5', () => {
    // Local midnight 2026-01-15 in UTC+5 is 19:00 UTC the previous day.
    expect(localDateToUtcMs('2026-01-15', PKT)).toBe(Date.UTC(2026, 0, 14, 19, 0, 0));
  });
});

describe('isWeekendLocal', () => {
  it('flags Sat/Sun only', () => {
    expect(isWeekendLocal('2024-01-06')).toBe(true); // Saturday
    expect(isWeekendLocal('2024-01-07')).toBe(true); // Sunday
    expect(isWeekendLocal('2024-01-08')).toBe(false); // Monday
  });
});

describe('dateRange', () => {
  it('is inclusive and crosses month boundaries', () => {
    expect(dateRange('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02',
    ]);
    expect(dateRange('2026-03-03', '2026-03-03')).toEqual(['2026-03-03']);
  });
});

describe('overlapSeconds', () => {
  it('clips to the window and floors to whole seconds', () => {
    expect(overlapSeconds(1_000, 5_000, 2_000, 4_000)).toBe(2); // [2s,4s) → 2s
    expect(overlapSeconds(0, 1_000, 5_000, 9_000)).toBe(0); // disjoint
    expect(overlapSeconds(0, 3_500, 0, 10_000)).toBe(3); // floors 3.5 → 3
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

describe('bucketSecondsByDay', () => {
  it('returns a single slice for an intra-day interval', () => {
    const start = Date.UTC(2024, 0, 8, 9, 0, 0);
    expect(bucketSecondsByDay(start, start + 2 * 3600_000, UTC)).toEqual([
      { date: '2024-01-08', seconds: 7200 },
    ]);
  });
  it('splits an interval that crosses midnight', () => {
    const start = Date.UTC(2024, 0, 7, 23, 0, 0); // Sun 23:00Z
    const end = Date.UTC(2024, 0, 8, 1, 0, 0); // Mon 01:00Z
    expect(bucketSecondsByDay(start, end, UTC)).toEqual([
      { date: '2024-01-07', seconds: 3600 },
      { date: '2024-01-08', seconds: 3600 },
    ]);
  });
});
