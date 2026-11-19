import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as hyparquet from 'hyparquet';
import {
  getSchema, groupAccumulator, query, sampleSpans, QueryInputError, type QueryResult,
} from '../functions/lib/parquet-query';

// Fixture (duckdb, 4 row groups x 2048 rows): id 'p<i>', nested names, WKB
// geometry, flat xmin/ymin/xmax/ymax (see query-streaming.test.ts).
vi.mock('hyparquet', async (importOriginal) => {
  const m = await importOriginal<typeof import('hyparquet')>();
  return { ...m, parquetReadObjects: vi.fn(m.parquetReadObjects) };
});
const decoded = (col: string) => vi.mocked(hyparquet.parquetReadObjects).mock.calls
  .map(([o]) => o)
  .filter((o) => o.columns?.includes(col))
  .map((o) => [o.rowStart ?? 0, o.rowEnd ?? 8192]);
beforeEach(() => { vi.mocked(hyparquet.parquetReadObjects).mockClear(); });

const buf = readFileSync(new URL('./fixtures/nearby-rg.parquet', import.meta.url));
const file = {
  byteLength: buf.byteLength,
  slice: async (start: number, end?: number) =>
    buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + (end ?? buf.byteLength)) as ArrayBuffer,
};

describe('group_by holds a bounded number of groups', () => {
  it('refuses a column with more distinct values than the cap, saying what to do', () => {
    const acc = groupAccumulator('g', [], 3);
    acc.add([{ g: 'a' }, { g: 'b' }, { g: 'c' }, { g: 'a' }]);
    expect(() => acc.add([{ g: 'd' }])).toThrow(QueryInputError);
    expect(() => groupAccumulator('g', [], 1).add([{ g: 'x' }, { g: 'y' }])).toThrow(/more than 1 distinct.*where filter/);
  });

  it('a group named like an Object property is an ordinary key', () => {
    const acc = groupAccumulator('g');
    acc.add([{ g: 'constructor' }, { g: '__proto__' }, { g: 'constructor' }]);
    expect(acc.result().counts).toEqual(Object.fromEntries([['constructor', 2], ['__proto__', 1]]));
  });

  it('query() stops a high-cardinality group_by with a 400-class error', async () => {
    await expect(query(file, { groupBy: 'id', maxGroupKeys: 100 })).rejects.toThrow(QueryInputError);
    const ok = await query(file, { groupBy: 'ymin', maxGroupKeys: 100 });
    expect(ok).toMatchObject({ total: 8192 });
  });
});

describe('select never returns shapes', () => {
  it('refuses the geometry column, pointing at include_centroid', async () => {
    await expect(query(file, { select: ['id', 'geometry'] })).rejects.toThrow(/geometry.*include_centroid/);
    expect(decoded('geometry')).toEqual([]);
  });

  it('still allows nested columns', async () => {
    const r = (await query(file, { select: ['names'], limit: 1 })) as QueryResult;
    expect(r.rows[0]).toEqual({ names: { primary: 'Place 0' } });
  });
});

describe('pass 2 reads sparse matches in windows', () => {
  it('decodes the matching rows, not every row between the first and the last', async () => {
    const r = (await query(file, {
      select: ['id', 'names'],
      filters: [{ col: 'id', kind: 'in', values: ['p0', 'p2000'] }],
    })) as QueryResult;
    expect(r.rows.map((x) => x.id)).toEqual(['p0', 'p2000']);
    expect(decoded('names')).toEqual([[0, 1], [2000, 2001]]);
  });
});

describe('schema samples rows from row groups spread through the file', () => {
  it('picks the first, last and between', async () => {
    const md = await hyparquet.parquetMetadataAsync(file);
    expect(sampleSpans(md)).toEqual([
      { start: 0, end: 50 }, { start: 2048, end: 2098 }, { start: 4096, end: 4146 }, { start: 6144, end: 6194 },
    ]);
  });

  it('getSchema reads its sample from more than the first row group', async () => {
    await getSchema(file);
    expect(decoded('id')).toEqual([[0, 50], [2048, 2098], [4096, 4146], [6144, 6194]]);
  });
});
