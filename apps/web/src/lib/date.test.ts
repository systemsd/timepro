import { describe, expect, it } from 'vitest';
import { addDays, localDateTimeIso, manualTimeRange, presetRange, weekStart } from './date';

describe('date helpers', () => {
  it('addDays crosses month/year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('weekStart returns the containing Monday', () => {
    expect(weekStart('2024-01-06')).toBe('2024-01-01'); // Sat → Mon
    expect(weekStart('2024-01-08')).toBe('2024-01-08'); // Mon → itself
  });

  it('presetRange yesterday/this_week are consistent', () => {
    const yest = presetRange('yesterday');
    expect(yest.from).toBe(yest.to); // single day
    const wk = presetRange('this_week');
    expect(weekStart(wk.from)).toBe(wk.from); // starts on a Monday
    expect(addDays(wk.from, 6)).toBe(wk.to); // 7-day span
  });
});

describe('manualTimeRange (Add Offline Time)', () => {
  // A winter date with no DST transition in any common zone, so the durations
  // below are stable wherever the suite runs (CI is UTC; this keeps local runs
  // in DST zones green too).
  const D = '2026-02-10';

  it('normal same-day range: no rollover, exact duration', () => {
    const r = manualTimeRange(D, '09:00', '17:00');
    expect(r.crossesMidnight).toBe(false);
    expect(r.invalid).toBe(false);
    expect(r.durSecs).toBe(8 * 3600);
  });

  it('overnight 19:00 → 01:00 rolls the end to the next day (~6h, valid)', () => {
    const r = manualTimeRange(D, '19:00', '01:00');
    expect(r.crossesMidnight).toBe(true);
    expect(r.invalid).toBe(false);
    expect(r.durSecs).toBe(6 * 3600);
    // The end lands on the following calendar day at the given wall-clock time.
    expect(r.endIso).toBe(localDateTimeIso('2026-02-11', '01:00'));
  });

  it('overnight 19:00 → 02:00 is ~7h', () => {
    expect(manualTimeRange(D, '19:00', '02:00').durSecs).toBe(7 * 3600);
  });

  it('end just after midnight (23:30 → 00:30) is ~1h', () => {
    const r = manualTimeRange(D, '23:30', '00:30');
    expect(r.crossesMidnight).toBe(true);
    expect(r.durSecs).toBe(3600);
  });

  it('end exactly at midnight (19:00 → 00:00) rolls to next-day 00:00 (~5h)', () => {
    const r = manualTimeRange(D, '19:00', '00:00');
    expect(r.crossesMidnight).toBe(true);
    expect(r.invalid).toBe(false);
    expect(r.durSecs).toBe(5 * 3600);
    expect(r.endIso).toBe(localDateTimeIso('2026-02-11', '00:00'));
  });

  it('equal start/end never rolls to 24h — it is invalid (zero length)', () => {
    const r = manualTimeRange(D, '09:00', '09:00');
    expect(r.crossesMidnight).toBe(false);
    expect(r.invalid).toBe(true);
    expect(r.durSecs).toBe(0);
  });

  it('overnight across a month/year boundary rolls the calendar correctly', () => {
    const r = manualTimeRange('2026-12-31', '19:00', '01:00');
    expect(r.crossesMidnight).toBe(true);
    expect(r.endIso).toBe(localDateTimeIso('2027-01-01', '01:00'));
    expect(r.durSecs).toBe(6 * 3600);
  });

  it('rolls by calendar day (not +86400s) so the duration is DST-correct', () => {
    // The end is always the next calendar day at the same wall clock — the
    // mechanism that keeps the real elapsed time right when the clocks change.
    const r = manualTimeRange(D, '22:15', '06:45');
    expect(r.endIso).toBe(localDateTimeIso(addDays(D, 1), '06:45'));
  });
});
