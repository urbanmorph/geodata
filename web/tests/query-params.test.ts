import { describe, it, expect } from 'vitest';
import { parseQueryParams, clampNum } from '../functions/lib/query-params';
import { QueryInputError } from '../functions/lib/parquet-query';

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

describe('parseQueryParams where', () => {
  it('reads col=value pairs, comma separated, and direct ?col=value params', () => {
    const p = parseQueryParams(new URLSearchParams('where=statename=Kerala, district = Idukki&level=x'));
    expect(p.where).toEqual({ statename: 'Kerala', district: 'Idukki', level: 'x' });
  });
  it('a pair without "=" is a 400 that says the format (it used to be dropped: unfiltered rows, 200)', () => {
    for (const w of ['statename:Kerala', 'statename=Kerala,Idukki', '=Kerala']) {
      let err: unknown;
      try { parseQueryParams(new URLSearchParams({ where: w })); } catch (e) { err = e; }
      expect(err, w).toBeInstanceOf(QueryInputError);
      expect((err as Error).message, w).toMatch(/col=value/);
      expect((err as Error).message, w).toMatch(/\?col=value/);
    }
  });
  it('an empty piece (a trailing comma) is not a pair', () => {
    expect(parseQueryParams(new URLSearchParams('where=a=1,')).where).toEqual({ a: '1' });
  });
});

describe('the MCP keeps the same option names', () => {
  it('mcp/read-tools.js QUERY_RESERVED equals QUERY_OPTIONS', async () => {
    const { QUERY_OPTIONS } = await import('../functions/lib/query-params');
    const { QUERY_RESERVED } = await import('../../mcp/read-tools.js');
    expect([...QUERY_RESERVED].sort()).toEqual([...QUERY_OPTIONS].sort());
  });
});
