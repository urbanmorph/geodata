import { describe, it, expect } from 'vitest';
import { parseQueryParams, clampNum } from '../functions/lib/query-params';

describe('clampNum', () => {
  it('parses, clamps, and falls back to the default for junk', () => {
    expect(clampNum('50', 20, 1, 100)).toBe(50);
    expect(clampNum('500', 20, 1, 100)).toBe(100);
    expect(clampNum('0', 20, 1, 100)).toBe(1);
    expect(clampNum('x', 20, 1, 100)).toBe(20);
    expect(clampNum(null, 20, 1, 100)).toBe(20);
    expect(clampNum('2.5', 25, 1, 200)).toBe(2.5);
  });

  it('can round to an integer', () => {
    expect(clampNum('7.9', 20, 1, 100, true)).toBe(7);
  });
});

describe('parseQueryParams limit', () => {
  it('uses the default when limit is not a number (was NaN: 0 rows, non-zero total)', () => {
    expect(parseQueryParams(new URLSearchParams('limit=abc')).limit).toBe(100);
  });
});
