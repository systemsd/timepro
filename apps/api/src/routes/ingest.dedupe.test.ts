import { describe, expect, it } from 'vitest';
import { dedupeBy } from './ingest';

describe('dedupeBy', () => {
  it('keeps the first row per key', () => {
    const rows = [
      { k: 'a', v: 1 },
      { k: 'a', v: 2 },
      { k: 'b', v: 3 },
      { k: 'a', v: 4 },
    ];
    expect(dedupeBy(rows, (r) => r.k)).toEqual([
      { k: 'a', v: 1 },
      { k: 'b', v: 3 },
    ]);
  });

  it('is a no-op when all keys are unique', () => {
    const rows = [{ k: 'x' }, { k: 'y' }, { k: 'z' }];
    expect(dedupeBy(rows, (r) => r.k)).toEqual(rows);
  });

  it('handles an empty batch', () => {
    expect(dedupeBy([], (r: { k: string }) => r.k)).toEqual([]);
  });
});
