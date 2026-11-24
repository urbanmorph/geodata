// Direct API callers have no MCP instructions: the answers that mean "wrong
// column or value" point at the layer's schema and say how matching works, and
// layer listings and detail carry the schema's address.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { query, queryFailure, QueryInputError } from '../functions/lib/parquet-query';
import { schemaPath, toApiLayer, type CatalogData, type CatalogLayer } from '../functions/lib/catalog-api';
import { __resetCatalogForTest } from '../functions/lib/catalog-loader';
import { clearMetadataCache, clearHeadCache } from '../functions/lib/parquet-r2';
import { onRequestGet as queryRoute } from '../functions/api/v1/layers/[id]/query';
import { onRequestGet as countsRoute } from '../functions/api/v1/layers/[id]/counts';

const PARQUET = readFileSync(new URL('./fixtures/schema-types.parquet', import.meta.url));
const file = {
  byteLength: PARQUET.byteLength,
  slice: async (start: number, end?: number) =>
    PARQUET.buffer.slice(PARQUET.byteOffset + start, PARQUET.byteOffset + (end ?? PARQUET.byteLength)) as ArrayBuffer,
};
const SCHEMA = '/api/v1/layers/states/schema';

describe('column errors name the layer\'s schema', () => {
  it.each([
    ['an unknown where column', { where: { statename: 'Kerala' } }],
    ['a nested column', { where: { names: 'x' } }],
    ['the geometry', { groupBy: 'geometry' }],
    ['an unknown group_by column', { groupBy: 'nope' }],
  ])('%s', async (_n, opts) => {
    const err = await query(file, opts).catch((e) => e);
    expect(err).toBeInstanceOf(QueryInputError);
    const res = queryFailure('Query', 'states')(err);
    expect(res.status).toBe(400);
    const { error } = await res.json() as { error: string };
    expect(error).toContain(err.message);
    expect(error).toContain(SCHEMA);
    expect(error).toMatch(/exact, case-insensitive/);
  });

  it('other 400s are unchanged', async () => {
    const res = queryFailure('Query', 'states')(new QueryInputError('sum requires group_by'));
    expect((await res.json() as { error: string }).error).toBe('sum requires group_by');
  });
});

describe('layer listings and detail carry the schema address', () => {
  const catalog = { layers: [], categories: {}, levels: {}, level_meta: {}, level_order: [] } as unknown as CatalogData;
  const layer = { id: 'states', level: 'state', source: 'LGD', category: 'boundaries', rows: 36, provenance: 'x',
    parquet: { url: 'https://r2/x.parquet', bytes: 9 } } as CatalogLayer;
  it('a layer with a parquet', () => {
    expect(schemaPath('states')).toBe(SCHEMA);
    expect(toApiLayer(layer, catalog).schema_url).toBe(SCHEMA);
    expect(toApiLayer(layer, catalog, true).schema_url).toBe(SCHEMA);
  });
  it('none without a parquet (its /schema is a 404)', () => {
    expect(toApiLayer({ ...layer, parquet: null }, catalog).schema_url).toBeUndefined();
  });
});

describe('/query and /counts: bad where, and a where that matches nothing', () => {
  const CATALOG = { categories: {}, level_meta: {}, levels: {}, layers: [
    { id: 'states', level: 'state', category: 'boundaries', source: 'x', rows: 30, parquet: { url: 'https://r2/schema-types.parquet', bytes: PARQUET.byteLength } },
  ] };
  const r2 = {
    async head() { return { size: PARQUET.byteLength, etag: 'e1' }; },
    async get(_k: string, o: { range: { offset: number; length: number } }) {
      const { offset, length } = o.range;
      return { arrayBuffer: async () => PARQUET.buffer.slice(PARQUET.byteOffset + offset, PARQUET.byteOffset + offset + length) };
    },
  };
  const assets = { fetch: async (url: string) => (new URL(url).pathname === '/catalog.json'
    ? new Response(JSON.stringify(CATALOG)) : new Response('', { status: 404 })) };
  const call = async (handler: typeof queryRoute, path: string) => {
    const pending: Promise<unknown>[] = [];
    const res = await handler({
      request: new Request(`https://bharatlas.com${path}`),
      env: { ASSETS: assets, R2: r2, DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }), batch: async () => [] } },
      params: { id: 'states' },
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    } as never);
    await Promise.all(pending);
    return { status: res.status, body: await res.json() as Record<string, unknown> & { data: { total: number } } };
  };
  beforeEach(() => {
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', { default: { async match(k: string) { return store.get(k)?.clone(); }, async put(k: string, r: Response) { store.set(k, r); } } });
    __resetCatalogForTest();
    clearMetadataCache();
    clearHeadCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a where pair without "=" is a 400 that says the format', async () => {
    const r = await call(queryRoute, '/api/v1/layers/states/query?where=state:Kerala');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/col=value/);
    expect(r.body.error).toContain(SCHEMA);
  });

  it('a match: no hint', async () => {
    const r = await call(queryRoute, '/api/v1/layers/states/query?where=state=kerala');
    expect(r.status).toBe(200);
    expect(r.body.data.total).toBe(15);
    expect(r.body.hint).toBeUndefined();
  });

  it.each([
    ['rows', '/api/v1/layers/states/query?where=state=Kerla'],
    ['groups', '/api/v1/layers/states/query?state=Kerla&group_by=code'],
  ])('no match (%s): the existing fields as before, plus a hint naming the schema', async (_n, path) => {
    const r = await call(queryRoute, path);
    expect(r.status).toBe(200);
    expect(r.body.data.total).toBe(0);
    expect(r.body.layer_id).toBe('states');
    expect(r.body.hint).toContain(SCHEMA);
    expect(r.body.hint).toMatch(/exact, case-insensitive/);
  });

  it('no where, no hint (an empty layer is not a filter mistake)', async () => {
    const r = await call(queryRoute, '/api/v1/layers/states/query?limit=1');
    expect(r.status).toBe(200);
    expect(r.body.hint).toBeUndefined();
  });

  it('/counts: a filter that matches nothing carries the hint too', async () => {
    const r = await call(countsRoute, '/api/v1/layers/states/counts?filter_col=state&filter_val=Kerla');
    expect(r.body.data.total).toBe(0);
    expect((r.body.data as unknown as { hint: string }).hint).toContain(SCHEMA);
    const bad = await call(countsRoute, '/api/v1/layers/states/counts?filter_col=statename&filter_val=Kerala');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain(SCHEMA);
  });
});
