import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  query,
  aggregateGroups,
  validateSumColumns,
  QueryInputError,
  type GroupByResult,
} from '../functions/lib/parquet-query';
import { parseQueryParams } from '../functions/lib/query-params';

// Fixture (884 B, written with duckdb):
//   district | state | area_ha (DOUBLE) | pop_int (INT64) | small_int (INT32) | label
//   A  S1  10.5  100  1  x
//   A  S1   4.5   50  2  y
//   B  S1  7.25   20  3  z
//   B  S2  0.75    5  4  x
//   C  S2  NULL    7  5  y
//   C  S2   3.0 NULL  6  z
const buf = readFileSync(new URL('./fixtures/sum-agg.parquet', import.meta.url));
const file = {
  byteLength: buf.byteLength,
  slice: async (start: number, end?: number) =>
    buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + (end ?? buf.byteLength)) as ArrayBuffer,
};

describe('aggregateGroups (pure)', () => {
  const rows = [
    { g: 'A', v: 1.5, n: 10n },
    { g: 'A', v: 2.5, n: 5n },
    { g: 'B', v: null, n: 3n },
    { g: 'B', v: 4, n: undefined },
    { g: null, v: 1, n: 1n },
  ];

  it('counts per group, sorted by count desc, and omits sums when none asked', () => {
    const r = aggregateGroups(rows, 'g');
    expect(r.counts).toEqual({ A: 2, B: 2, '(null)': 1 });
    expect(r.total).toBe(5);
    expect(r.sums).toBeUndefined();
  });

  it('sums numeric columns per group, accepting BigInt and skipping null/undefined', () => {
    const r = aggregateGroups(rows, 'g', ['v', 'n']);
    expect(r.sums).toEqual({
      A: { v: 4, n: 15 },
      B: { v: 4, n: 3 },
      '(null)': { v: 1, n: 1 },
    });
  });

  it('rounds float noise (0.1 + 0.2 reads as 0.3)', () => {
    const r = aggregateGroups([{ g: 'x', v: 0.1 }, { g: 'x', v: 0.2 }], 'g', ['v']);
    expect(r.sums!.x.v).toBe(0.3);
  });

  it('a group whose values are all null sums to 0, not NaN', () => {
    const r = aggregateGroups([{ g: 'x', v: null }], 'g', ['v']);
    expect(r.sums!.x.v).toBe(0);
  });
});

describe('validateSumColumns', () => {
  const types = { district: 'BYTE_ARRAY', area_ha: 'DOUBLE', pop_int: 'INT64', small_int: 'INT32', f: 'FLOAT' };

  it('accepts INT32, INT64, FLOAT and DOUBLE columns', () => {
    expect(() => validateSumColumns(['area_ha', 'pop_int', 'small_int', 'f'], types)).not.toThrow();
  });

  it('rejects an unknown column, listing the numeric ones', () => {
    expect(() => validateSumColumns(['nope'], types)).toThrow(QueryInputError);
    expect(() => validateSumColumns(['nope'], types)).toThrow(/area_ha/);
  });

  it('rejects a non-numeric column', () => {
    expect(() => validateSumColumns(['district'], types)).toThrow(QueryInputError);
    expect(() => validateSumColumns(['district'], types)).toThrow(/not numeric/);
  });
});

describe('query() with sum against a real parquet file', () => {
  it('group_by + sum returns counts and per-group sums (DOUBLE + INT64)', async () => {
    const r = (await query(file, { groupBy: 'district', sum: ['area_ha', 'pop_int'] })) as GroupByResult;
    expect(r.counts).toEqual({ A: 2, B: 2, C: 2 });
    expect(r.sums).toEqual({
      A: { area_ha: 15, pop_int: 150 },
      B: { area_ha: 8, pop_int: 25 },
      C: { area_ha: 3, pop_int: 7 },
    });
    expect(r.total).toBe(6);
  });

  it('respects where filters', async () => {
    const r = (await query(file, { groupBy: 'district', sum: ['area_ha'], where: { state: 's1' } })) as GroupByResult;
    expect(r.counts).toEqual({ A: 2, B: 1 });
    expect(r.sums).toEqual({ A: { area_ha: 15 }, B: { area_ha: 7.25 } });
  });

  it('group_by without sum keeps the existing shape (no sums key)', async () => {
    const r = (await query(file, { groupBy: 'state' })) as GroupByResult;
    expect(r.counts).toEqual({ S1: 3, S2: 3 });
    expect(r.sums).toBeUndefined();
  });

  it('rejects sum without group_by', async () => {
    await expect(query(file, { sum: ['area_ha'] })).rejects.toThrow(QueryInputError);
  });

  it('rejects a non-numeric sum column', async () => {
    await expect(query(file, { groupBy: 'district', sum: ['label'] })).rejects.toThrow(/not numeric/);
  });
});

describe('parseQueryParams', () => {
  const p = (qs: string) => parseQueryParams(new URLSearchParams(qs));

  it('parses sum as a column list, never as a where filter', () => {
    const r = p('group_by=district&sum=area_ha, pop_int');
    expect(r.sum).toEqual(['area_ha', 'pop_int']);
    expect(r.where).toBeUndefined();
  });

  it('still turns unreserved params into where filters', () => {
    expect(p('state=S1&group_by=district').where).toEqual({ state: 'S1' });
  });

  it('merges the where= param with direct filters', () => {
    expect(p('where=state=S1,district=A&label=x').where).toEqual({ state: 'S1', district: 'A', label: 'x' });
  });

  it('keeps limit clamped to 1..1000 (default 100)', () => {
    expect(p('').limit).toBe(100);
    expect(p('limit=5000').limit).toBe(1000);
    expect(p('limit=0').limit).toBe(1);
  });

  it('defaults include_centroid to true unless explicitly false', () => {
    expect(p('').includeCentroid).toBe(true);
    expect(p('include_centroid=false').includeCentroid).toBe(false);
  });

  it('leaves sum undefined when absent or blank', () => {
    expect(p('group_by=district').sum).toBeUndefined();
    expect(p('group_by=district&sum=').sum).toBeUndefined();
  });
});
