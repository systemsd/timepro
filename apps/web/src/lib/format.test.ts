import { describe, expect, it } from 'vitest';
import { actPct, dmy, hm, pad } from './format';

describe('format helpers', () => {
  it('pad → two digits', () => {
    expect(pad(3)).toBe('03');
    expect(pad(12)).toBe('12');
  });

  it('hm formats durations', () => {
    expect(hm(0)).toBe('0m');
    expect(hm(30)).toBe('<1m');
    expect(hm(5 * 60)).toBe('5m');
    expect(hm(3600)).toBe('1h 00m');
    expect(hm(3600 + 5 * 60)).toBe('1h 05m');
  });

  it('dmy reformats an ISO date', () => {
    expect(dmy('2026-07-02')).toBe('02/07/26');
  });

  it('actPct shows "—" for null', () => {
    expect(actPct(null)).toBe('—');
    expect(actPct(74)).toBe('74%');
  });
});
