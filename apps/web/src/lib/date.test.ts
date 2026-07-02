import { describe, expect, it } from 'vitest';
import { addDays, presetRange, weekStart } from './date';

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
