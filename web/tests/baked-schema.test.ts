// /api/v1/layers/{id}/schema from the layer's baked stats file
// (web/public/api-data/filter-stats/<id>.json, scripts/bake_filter_stats.py)
// instead of sampling the parquet on R2 on every edge-cache miss (p50 3 s,
// 16 to 109 range reads per call, Nov 2026).
//
// Fixture: tests/fixtures/schema-types.parquet (30 rows, one row group, so the
// live sample sees every row) and schema-types.stats.json, written from it by
// the bake's own functions (build_filter_stats.build_all + parquet_columns).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { getSchema, type ColumnSchema } from '../functions/lib/parquet-query';
import { isBakedFor, schemaFromStats, type BakedStats } from '../functions/lib/baked-schema';
import { __resetCatalogForTest } from '../functions/lib/catalog-loader';
import { clearMetadataCache, clearHeadCache } from '../functions/lib/parquet-r2';
import { onRequestGet as schemaRoute } from '../functions/api/v1/layers/[id]/schema';

const PARQUET = readFileSync(new URL('./fixtures/schema-types.parquet', import.meta.url));
const STATS = JSON.parse(readFileSync(new URL('./fixtures/schema-types.stats.json', import.meta.url), 'utf8')) as BakedStats;
const file = {
  byteLength: PARQUET.byteLength,
  slice: async (start: number, end?: number) =>
    PARQUET.buffer.slice(PARQUET.byteOffset + start, PARQUET.byteOffset + (end ?? PARQUET.byteLength)) as ArrayBuffer,
};
const core = (cols: ColumnSchema[]) => cols.map(({ name, type, distinct_values }) => ({ name, type, ...(distinct_values ? { distinct_values } : {}) }));

describe('a baked schema answers as the live read does', () => {
  it('same row count, columns, types and distinct values as getSchema', async () => {
    const live = await getSchema(file);
    const baked = schemaFromStats(STATS);
    expect(baked.row_count).toBe(live.row_count);
    expect(core(baked.columns)).toEqual(core(live.columns));
  });

  it('lists the bounding box, leaves out the geometry, marks nested columns', () => {
    const cols = schemaFromStats(STATS).columns;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['xmin', 'ymin', 'xmax', 'ymax']));
    expect(names).not.toContain('geometry');
    expect(cols.find((c) => c.name === 'names')).toEqual({ name: 'names', type: 'nested' });
    expect(cols.find((c) => c.name === 'ymin')?.distinct_values).toEqual(['20']);
  });

  it('adds the whole-file distinct count, and the top values with counts above 20 distinct', () => {
    const by = Object.fromEntries(schemaFromStats(STATS).columns.map((c) => [c.name, c]));
    expect(by.state.distinct_count).toBe(3);
    expect(by.state.top_values).toBeUndefined();          // its distinct_values say it all
    expect(by.never.distinct_count).toBe(0);
    expect(by.id.distinct_count).toBe(30);
    expect(by.id.distinct_values).toBeUndefined();
    expect(by.id.top_values).toHaveLength(30);
    expect(by.id.top_values![0]).toEqual({ value: 'r0', count: 1 });
    expect(by.names.distinct_count).toBeUndefined();
  });
});

describe('a baked file is used only while it matches the catalog\'s parquet', () => {
  const layer = { id: 'schema_types', parquet: { ...STATS.parquet! } };
  it('same url and bytes: used', () => expect(isBakedFor(STATS, layer)).toBe(true));
  it('another url or size: stale', () => {
    expect(isBakedFor(STATS, { ...layer, parquet: { url: 'https://data.example/v2.parquet', bytes: layer.parquet.bytes } })).toBe(false);
    expect(isBakedFor(STATS, { ...layer, parquet: { url: layer.parquet.url, bytes: 1 } })).toBe(false);
  });
  it('a file from before the source and schema were recorded: not used', () => {
    expect(isBakedFor({ row_count: 1, columns: [] }, layer)).toBe(false);
    expect(isBakedFor({ ...STATS, schema: undefined }, layer)).toBe(false);
  });
});

describe('every curated layer\'s stats file matches its parquet', () => {
  const catalog = JSON.parse(readFileSync(new URL('../../catalog.json', import.meta.url), 'utf8')) as {
    layers: Array<{ id: string; parquet?: { url: string; bytes: number | null } | null }>;
  };
  it('none missing, none stale (else rerun: python3 -u scripts/bake_filter_stats.py)', () => {
    const problems: string[] = [];
    for (const l of catalog.layers) {
      if (!l.parquet?.url || l.id.startsWith('c_')) continue;
      const path = new URL(`../public/api-data/filter-stats/${l.id}.json`, import.meta.url);
      if (!existsSync(path)) { problems.push(`${l.id}: no stats file`); continue; }
      const stats = JSON.parse(readFileSync(path, 'utf8')) as BakedStats;
      if (!isBakedFor(stats, l)) problems.push(`${l.id}: baked from ${JSON.stringify(stats.parquet ?? null)}, catalog has ${JSON.stringify({ url: l.parquet.url, bytes: l.parquet.bytes })}`);
    }
    expect(problems, 'Stats files are missing or stale: rerun `python3 -u scripts/bake_filter_stats.py` and commit web/public/api-data/filter-stats/').toEqual([]);
  });
});

describe('GET /api/v1/layers/{id}/schema', () => {
  const layer = (id: string, bytes = STATS.parquet!.bytes) => ({
    id, level: 'district', category: 'boundaries', source: 'x', rows: 30, parquet: { url: STATS.parquet!.url, bytes },
  });
  const CATALOG = { categories: {}, level_meta: {}, levels: {}, layers: [layer('baked'), layer('stale', 1), layer('c_comm')] };
  let r2Reads = 0;
  const r2 = {
    async head() { r2Reads++; return { size: PARQUET.byteLength, etag: 'e1' }; },
    async get(_k: string, o: { range: { offset: number; length: number } }) {
      r2Reads++;
      const { offset, length } = o.range;
      return { arrayBuffer: async () => PARQUET.buffer.slice(PARQUET.byteOffset + offset, PARQUET.byteOffset + offset + length) };
    },
  };
  const assets = {
    fetch: vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/catalog.json') return new Response(JSON.stringify(CATALOG));
      if (/^\/api-data\/filter-stats\/(baked|stale|c_comm)\.json$/.test(path)) return new Response(JSON.stringify(STATS));
      return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }); // Pages' SPA fallback
    }),
  };
  const call = async (id: string) => {
    const pending: Promise<unknown>[] = [];
    const res = await schemaRoute({
      request: new Request(`https://bharatlas.com/api/v1/layers/${id}/schema`),
      env: { ASSETS: assets, R2: r2, DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }), batch: async () => [] } },
      params: { id },
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    } as never);
    await Promise.all(pending);
    return res;
  };
  beforeEach(() => {
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', { default: { async match(k: string) { return store.get(k)?.clone(); }, async put(k: string, r: Response) { store.set(k, r); } } });
    r2Reads = 0;
    __resetCatalogForTest();
    clearMetadataCache();
    clearHeadCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('answers from the baked file with no R2 read, in the live shape', async () => {
    const res = await call('baked');
    expect(res.status).toBe(200);
    expect(r2Reads).toBe(0);
    const body = await res.json() as { data: { row_count: number; columns: ColumnSchema[] } };
    expect(body.data.row_count).toBe(30);
    expect(core(body.data.columns)).toEqual(core((await getSchema(file)).columns));
  });

  it('a stale file, or a community layer, is read live from R2', async () => {
    for (const id of ['stale', 'c_comm']) {
      r2Reads = 0;
      const res = await call(id);
      expect(res.status, id).toBe(200);
      expect(r2Reads, id).toBeGreaterThan(0);
      const body = await res.json() as { data: { columns: ColumnSchema[] } };
      expect(body.data.columns[0].distinct_count, id).toBeUndefined();
    }
  });
});
