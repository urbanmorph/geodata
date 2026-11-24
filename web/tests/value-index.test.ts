// A filtered query must count every match for `total`, so it read the filter column of
// every row group: 388 for overture_places_india, about 15 s for basic_category=hospital
// (24 Nov 2026). A baked value index (scripts/bake_value_index.py) records, for each
// low-cardinality text column of a large layer, the row groups each value is in and how
// many rows: a one-value filter takes its total from the index and reads only the groups
// it needs; other filters read only the candidate groups; a group_by answers from it.
// Every answer must equal the full scan's.
//
// Fixture: tests/fixtures/value-index.parquet, 10 rows in row groups of 4, 4 and 2:
//   id name cat     status
//   1  a    Shop    open     | 5 e cafe   open   | 9  i Shop open
//   2  b    cafe    open     | 6 f cafe   open   | 10 j cafe (null)
//   3  c    shop    closed   | 7 g museum closed |
//   4  d    (null)  open     | 8 h cafe   open   |
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { query, topCounts, type QueryResult, type GroupByResult } from '../functions/lib/parquet-query';
import { parseValueIndex, loadValueIndex, clearValueIndexCache, type ValueIndexFile } from '../functions/lib/value-index';

const BUF = readFileSync(new URL('./fixtures/value-index.parquet', import.meta.url));

/** The fixture as an AsyncBuffer, recording each byte range read. */
function file() {
  const reads: Array<[number, number]> = [];
  return {
    reads,
    byteLength: BUF.byteLength,
    slice: async (s: number, e?: number) => {
      reads.push([s, e ?? BUF.byteLength]);
      return BUF.buffer.slice(BUF.byteOffset + s, BUF.byteOffset + (e ?? BUF.byteLength)) as ArrayBuffer;
    },
  };
}

// As scripts/bake_value_index.py writes it: per value, "group:count," in hex.
const INDEX: ValueIndexFile = {
  parquet: { url: 'https://pub-x.r2.dev/t/v.parquet', bytes: BUF.byteLength },
  row_groups: 3,
  rows: 10,
  columns: {
    cat: { values: { Shop: '0:1,2:1,', shop: '0:1,', cafe: '0:1,1:3,2:1,', museum: '1:1,' }, nulls: '0:1,' },
    status: { values: { open: '0:3,1:3,2:1,', closed: '0:1,1:1,' }, nulls: '2:1,' },
  },
};
const index = parseValueIndex(INDEX);

/** The same query with and without the index: the answers must be equal. */
async function both(opts: Parameters<typeof query>[1]) {
  const plain = file();
  const viaIndex = file();
  const a = await query(plain, opts);
  const b = await query(viaIndex, { ...opts, valueIndex: index });
  return { a, b, plainReads: plain.reads.length, indexReads: viaIndex.reads.length };
}

describe('parseValueIndex', () => {
  it('row groups and counts of a value, matched case-insensitively as where matches', () => {
    expect([...index.groups('cat', 'shop')!]).toEqual([[0, 2], [2, 1]]);
    expect([...index.groups('cat', 'museum')!]).toEqual([[1, 1]]);
    expect(index.groups('cat', 'library')!.size).toBe(0);
    expect(index.groups('name', 'a')).toBeNull(); // not indexed
  });
  it('the counts of every value as stored, nulls apart, for group_by', () => {
    expect(index.counts('cat')).toEqual({ cafe: 5, Shop: 2, shop: 1, museum: 1, '(null)': 1 });
    expect(index.counts('name')).toBeNull();
  });
  it('a value spelled "(null)" adds to the nulls, as group_by\'s String(v ?? "(null)") does', () => {
    const i = parseValueIndex({ ...INDEX, columns: { c: { values: { '(null)': '0:2,' }, nulls: '1:1,' } } });
    expect(i.counts('c')).toEqual({ '(null)': 3 });
  });
});

describe('a one-value filter on an indexed column', () => {
  it('answers as the scan does, total from the index', async () => {
    const { a, b } = await both({ where: { cat: 'CAFE' }, select: ['id'], limit: 2 });
    expect(b).toEqual(a);
    expect((b as QueryResult).total).toBe(5);
    expect((b as QueryResult).rows).toEqual([{ id: 2 }, { id: 5 }]);
  });
  it('reads only the row groups it needs for the rows asked', async () => {
    const { a, b, plainReads, indexReads } = await both({ where: { cat: 'museum' }, select: ['name'], limit: 5 });
    expect(b).toEqual(a);
    expect((b as QueryResult).rows).toEqual([{ name: 'g' }]);
    expect(indexReads).toBeLessThan(plainReads);
  });
  it('a value the index has not: total 0, the scan\'s hints', async () => {
    const { a, b } = await both({ where: { cat: 'library' }, limit: 5 });
    expect(b).toEqual(a);
    expect((b as QueryResult).total).toBe(0);
    expect((b as QueryResult).hints).toBeDefined();
  });
});

describe('other filters still answer as the scan does', () => {
  it('two indexed columns: only groups that hold both values are read', async () => {
    const { a, b } = await both({ where: { cat: 'shop', status: 'closed' }, limit: 5 });
    expect(b).toEqual(a);
    expect((b as QueryResult).total).toBe(1);
  });
  it('an indexed column and one that is not', async () => {
    const { a, b } = await both({ where: { cat: 'cafe', name: 'f' }, limit: 5 });
    expect(b).toEqual(a);
    expect((b as QueryResult).total).toBe(1);
  });
  it('a column that is not indexed: the full scan', async () => {
    const { a, b } = await both({ where: { name: 'j' }, limit: 5 });
    expect(b).toEqual(a);
  });
  it('a filter= spec with a where: same answer', async () => {
    const { a, b } = await both({ where: { cat: 'cafe' }, filters: [{ kind: 'in', col: 'status', values: ['open'] }], limit: 5 });
    expect(b).toEqual(a);
  });
});

describe('an index that does not match the file is not used', () => {
  it('another row-group or row count: the scan answers', async () => {
    const beyond = { ...INDEX, row_groups: 6, columns: { ...INDEX.columns, cat: { values: { cafe: '0:1,5:4,' } } } };
    for (const bad of [{ ...INDEX, row_groups: 2 }, { ...INDEX, rows: 11 }, beyond]) {
      const plain = await query(file(), { where: { cat: 'cafe' }, limit: 5 });
      const via = await query(file(), { where: { cat: 'cafe' }, limit: 5, valueIndex: parseValueIndex(bad) });
      expect(via).toEqual(plain);
      expect(await query(file(), { groupBy: 'cat', valueIndex: parseValueIndex(bad) })).toEqual(await query(file(), { groupBy: 'cat' }));
    }
  });
});

describe('more shapes answer as the scan does', () => {
  it('group_by with a where value the index does not have (zero rows, the scan\'s hints)', async () => {
    const { a, b } = await both({ groupBy: 'status', where: { cat: 'library' } });
    expect(b).toEqual(a);
    expect((b as GroupByResult).total).toBe(0);
  });
  it('filter= specs alone, with an index loaded', async () => {
    const { a, b } = await both({ filters: [{ kind: 'in', col: 'cat', values: ['cafe', 'museum'] }], limit: 3 });
    expect(b).toEqual(a);
  });
});

describe('topCounts', () => {
  it('largest first, ties by value, at most 500: the same top for the scan and the index', () => {
    const counts: Record<string, number> = { b: 2, a: 2, c: 5 };
    for (let i = 0; i < 600; i++) counts[`v${String(i).padStart(3, '0')}`] = 1;
    const top = Object.entries(topCounts(counts));
    expect(top.slice(0, 3)).toEqual([['c', 5], ['a', 2], ['b', 2]]);
    expect(top).toHaveLength(500);
    expect(top[top.length - 1]).toEqual(['v496', 1]);
  });
});

describe('group_by on an indexed column', () => {
  it('without a filter, from the index: the scan\'s counts and total, no row group read', async () => {
    const { a, b, plainReads, indexReads } = await both({ groupBy: 'cat' });
    expect((b as GroupByResult).counts).toEqual((a as GroupByResult).counts);
    expect((b as GroupByResult).total).toBe((a as GroupByResult).total);
    expect(b).toEqual(a);
    expect(indexReads).toBeLessThan(plainReads); // the footer only
  });
  it('with a where: the scan, over candidate groups only', async () => {
    const { a, b } = await both({ groupBy: 'status', where: { cat: 'cafe' } });
    expect(b).toEqual(a);
  });
  it('with sum: the scan', async () => {
    const { a, b } = await both({ groupBy: 'cat', sum: ['id'] });
    expect(b).toEqual(a);
  });
});

describe('loadValueIndex', () => {
  beforeEach(() => clearValueIndexCache());
  const layer = { id: 'v', parquet: INDEX.parquet };
  const ctx = (answer: () => Response) => {
    let asked = 0;
    return { asked: () => asked, ctx: { request: new Request('https://bharatlas.com/api/v1/layers/v/query'), env: { ASSETS: { fetch: async () => { asked++; return answer(); } } } } };
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  it('a file baked from the catalog\'s parquet is used, and kept for the isolate', async () => {
    const c = ctx(() => json(INDEX));
    expect((await loadValueIndex(c.ctx as never, layer))?.groups('cat', 'cafe')?.size).toBe(3);
    await loadValueIndex(c.ctx as never, layer);
    expect(c.asked()).toBe(1);
  });
  it('a stale file, a missing one (the site\'s HTML page) or a community layer: none, and the query scans', async () => {
    expect(await loadValueIndex(ctx(() => json({ ...INDEX, parquet: { ...INDEX.parquet, bytes: 1 } })).ctx as never, layer)).toBeNull();
    expect(await loadValueIndex(ctx(() => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })).ctx as never, layer)).toBeNull();
    expect(await loadValueIndex(ctx(() => json(INDEX)).ctx as never, { ...layer, id: 'c_abc' })).toBeNull();
  });
  it('a miss is kept for the isolate too: a layer with no index costs one asset fetch, not one per query', async () => {
    const c = ctx(() => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    expect(await loadValueIndex(c.ctx as never, layer)).toBeNull();
    expect(await loadValueIndex(c.ctx as never, layer)).toBeNull();
    expect(c.asked()).toBe(1);
  });
});
