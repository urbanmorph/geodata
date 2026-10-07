import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as hyparquet from 'hyparquet';
import { query, type GroupByResult, type QueryResult } from '../functions/lib/parquet-query';

// Fixture (duckdb, 4 row groups x 2048 rows): id 'p<i>', nested names
// {primary: 'Place <i>'}, WKB geometry, flat xmin/ymin/xmax/ymax.
// Filtered queries used to read every selected column (all of them by
// default, nested included) for every row, then filter: Cloudflare 1102 on
// Overture places (4.4M rows). Now: filter columns first, row group by row
// group; selected columns only for the matching rows.

// Spy on what gets decoded. hyparquet coalesces neighbouring column chunks
// into one fetch, so bytes fetched don't show what was decoded.
vi.mock('hyparquet', async (importOriginal) => {
  const m = await importOriginal<typeof import('hyparquet')>();
  return { ...m, parquetReadObjects: vi.fn(m.parquetReadObjects), parquetQuery: vi.fn(m.parquetQuery) };
});
/** Row ranges [start, end) decoded for `col`. */
const decoded = (col: string) => vi.mocked(hyparquet.parquetReadObjects).mock.calls
  .map(([o]) => o)
  .filter((o) => o.columns?.includes(col))
  .map((o) => [o.rowStart ?? 0, o.rowEnd ?? 8192]);

beforeEach(() => {
  vi.mocked(hyparquet.parquetReadObjects).mockClear();
  vi.mocked(hyparquet.parquetQuery).mockClear();
});

const buf = readFileSync(new URL('./fixtures/nearby-rg.parquet', import.meta.url));
const file = {
  byteLength: buf.byteLength,
  slice: async (start: number, end?: number) =>
    buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + (end ?? buf.byteLength)) as ArrayBuffer,
};

describe('filtered select streams row groups', () => {
  it('finds a match in the last row group with the right total and full row', async () => {
    const r = (await query(file, { where: { id: 'P7000' }, select: ['id', 'names'] })) as QueryResult;
    expect(r.total).toBe(1);
    expect(r.rows).toEqual([{ id: 'p7000', names: { primary: 'Place 7000' } }]); // case-insensitive
  });

  it('decodes selected (nested) columns only for the matching rows', async () => {
    await query(file, { where: { id: 'p100' } }); // default select includes names
    expect(decoded('names')).toEqual([[100, 101]]);
    expect(hyparquet.parquetQuery).not.toHaveBeenCalled(); // no whole-table read
  });

  it('counts every match but returns at most limit rows', async () => {
    const r = (await query(file, { where: { ymin: '12.9' }, select: ['id'], limit: 3 })) as QueryResult;
    expect(r.total).toBe(8192);
    expect(r.truncated).toBe(true);
    expect(r.rows.map((x) => x.id)).toEqual(['p0', 'p1', 'p2']);
  });

  it('hints with real values when nothing matches', async () => {
    const r = (await query(file, { where: { id: 'nope' }, select: ['id'] })) as QueryResult;
    expect(r.total).toBe(0);
    expect(r.hints?.id?.length).toBeGreaterThan(0);
  });
});

describe('unfiltered select reads only the first rows', () => {
  it('takes the total from metadata and decodes only the first limit rows', async () => {
    const r = (await query(file, { limit: 5 })) as QueryResult;
    expect(r.total).toBe(8192);
    expect(r.rows).toHaveLength(5);
    expect(decoded('names')).toEqual([[0, 5]]);
  });
});

describe('group_by streams row groups', () => {
  it('aggregates across row groups like a single pass would', async () => {
    const g = (await query(file, { groupBy: 'ymin', sum: ['xmin'] })) as GroupByResult;
    expect(g.total).toBe(8192);
    expect(g.counts).toEqual({ '12.9': 8192 });
    // sum of 77 + i*0.0001 for i < 8192
    expect(g.sums!['12.9'].xmin).toBeCloseTo(8192 * 77 + 0.0001 * (8191 * 8192) / 2, 4);
  });

  it('applies where per row group and never decodes unrelated columns', async () => {
    const g = (await query(file, { groupBy: 'ymin', where: { id: 'p5000' } })) as GroupByResult;
    expect(g.counts).toEqual({ '12.9': 1 });
    expect(decoded('names')).toEqual([]);
    // one bounded read per row group, never the whole table at once
    expect(decoded('id')).toEqual([[0, 2048], [2048, 4096], [4096, 6144], [6144, 8192]]);
  });
});
