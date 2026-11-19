// The API's edge cache (lib/edge-cache.ts) on the real handlers: a hit skips
// the work but still counts the call (lib/usage.ts), 304s answer If-None-Match,
// and /locate stays uncached.
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __resetCatalogForTest } from '../functions/lib/catalog-loader';
import { clearMetadataCache, clearHeadCache } from '../functions/lib/parquet-r2';
import { onRequestGet as layerDetail } from '../functions/api/v1/layers/[id]';
import { onRequestGet as layersIndex } from '../functions/api/v1/layers/index';
import { onRequestGet as categories } from '../functions/api/v1/categories';
import { onRequestGet as levels } from '../functions/api/v1/levels';
import { onRequestGet as counts } from '../functions/api/v1/layers/[id]/counts';
import { onRequestGet as schema } from '../functions/api/v1/layers/[id]/schema';
import { onRequestGet as queryRoute } from '../functions/api/v1/layers/[id]/query';
import { onRequestGet as nearbyRoute } from '../functions/api/v1/nearby';
import { onRequestGet as openapi } from '../functions/api/v1/openapi.json';

const CATALOG = {
  categories: { boundaries: 'Boundaries' },
  level_meta: {},
  levels: { district: { order: 2, plural: 'districts', category: 'boundaries' } },
  layers: [{ id: 'dist', name: 'Districts', level: 'district', category: 'boundaries', source: 'LGD', rows: 6,
    parquet: { url: 'https://data.bharatlas.com/dist-v1.parquet', bytes: 884 } }],
};
const STATS = { row_count: 6, columns: { state: { type: 'VARCHAR', distinct: 2, row_count: 6, values: { S1: 3, S2: 3 } } } };
const PARQUET = readFileSync(new URL('./fixtures/sum-agg.parquet', import.meta.url));

function memoryCache() {
  const store = new Map<string, Response>();
  return {
    store,
    default: {
      async match(key: string) { return store.get(key)?.clone(); },
      async put(key: string, res: Response) { store.set(key, res); },
    },
  };
}

let cache: ReturnType<typeof memoryCache>;
let counted: string[];
let r2Reads: number;

const r2 = {
  async head() { r2Reads++; return { size: PARQUET.byteLength, etag: 'r2etag1' }; },
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
    if (path === '/api-data/layers/dist.json') return new Response(JSON.stringify(STATS));
    return new Response('not found', { status: 404 });
  }),
};

const db = {
  prepare: (sql: string) => ({
    bind: (...args: unknown[]) => ({
      // one count per call: the running-total row (the day row rides in the same batch)
      run: async () => { if (/INTO api_usage \(/.test(sql)) counted.push(String(args[0])); return { meta: {} }; },
    }),
  }),
  batch: async (stmts: { run(): Promise<unknown> }[]) => Promise.all(stmts.map((s) => s.run())),
};

async function call(handler: (ctx: never) => Promise<Response> | Response, path: string, params: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const pending: Promise<unknown>[] = [];
  const res = await handler({
    request: new Request(`https://bharatlas.com${path}`, { headers: { 'user-agent': 'curl/8', ...headers } }),
    env: { ASSETS: assets, DB: db, R2: r2 },
    params,
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
  } as never);
  await Promise.all(pending);
  return res;
}

beforeEach(() => {
  cache = memoryCache();
  vi.stubGlobal('caches', cache);
  counted = [];
  r2Reads = 0;
  __resetCatalogForTest();
  clearMetadataCache();
  clearHeadCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('catalog answers are edge-cached', () => {
  it.each([
    ['layers', layersIndex, '/api/v1/layers?q=dist'],
    ['categories', categories, '/api/v1/categories'],
    ['levels', levels, '/api/v1/levels'],
  ])('%s: a miss then a hit, same body', async (_n, handler, path) => {
    const a = await call(handler, path);
    const b = await call(handler, path);
    expect(a.headers.get('x-edge-cache')).toBe('MISS');
    expect(b.headers.get('x-edge-cache')).toBe('HIT');
    expect(await b.text()).toBe(await a.text());
    expect(cache.store.size).toBe(1);
  });

  it('layer detail: a hit still counts the call', async () => {
    await call(layerDetail, '/api/v1/layers/dist', { id: 'dist' });
    const hit = await call(layerDetail, '/api/v1/layers/dist', { id: 'dist' });
    expect(hit.headers.get('x-edge-cache')).toBe('HIT');
    expect(counted).toEqual(['dist', 'dist']);
  });

  it('layer detail: an unknown layer is a 404, not counted, not cached', async () => {
    const r = await call(layerDetail, '/api/v1/layers/nope', { id: 'nope' });
    expect(r.status).toBe(404);
    expect(counted).toEqual([]);
    expect(cache.store.size).toBe(0);
  });

  it('counts: stats come from the deployment (ASSETS); a hit counts and skips the read', async () => {
    const a = await call(counts, '/api/v1/layers/dist/counts?group_by=state', { id: 'dist' });
    expect((await a.json() as { data: { counts: unknown } }).data.counts).toEqual({ S1: 3, S2: 3 });
    const reads = assets.fetch.mock.calls.length;
    const b = await call(counts, '/api/v1/layers/dist/counts?group_by=state', { id: 'dist' });
    expect(b.headers.get('x-edge-cache')).toBe('HIT');
    expect(assets.fetch.mock.calls.length).toBe(reads);
    expect(counted).toEqual(['dist', 'dist']);
  });

  it('answers 304 to If-None-Match with the ETag it gave', async () => {
    const a = await call(layerDetail, '/api/v1/layers/dist', { id: 'dist' });
    const etag = a.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const b = await call(layerDetail, '/api/v1/layers/dist', { id: 'dist' }, { 'if-none-match': etag });
    expect(b.status).toBe(304);
    expect(counted).toEqual(['dist', 'dist']);
  });

  it('openapi.json carries an ETag and answers 304', async () => {
    const a = await call(openapi, '/api/v1/openapi.json');
    const b = await call(openapi, '/api/v1/openapi.json', {}, { 'if-none-match': a.headers.get('etag')! });
    expect(b.status).toBe(304);
  });
});

describe('R2 answers are edge-cached', () => {
  it('schema: a hit reads nothing from R2 and still counts; the ETag carries the R2 etag', async () => {
    const a = await call(schema, '/api/v1/layers/dist/schema', { id: 'dist' });
    expect(a.status).toBe(200);
    expect(a.headers.get('etag')).toContain('r2etag1');
    const reads = r2Reads;
    const b = await call(schema, '/api/v1/layers/dist/schema', { id: 'dist' });
    expect(b.headers.get('x-edge-cache')).toBe('HIT');
    expect(r2Reads).toBe(reads);
    expect(counted).toEqual(['dist', 'dist']);
  });

  it('query answers (group_by and rows) are cached; a hit still counts', async () => {
    await call(queryRoute, '/api/v1/layers/dist/query?group_by=state', { id: 'dist' });
    const hit = await call(queryRoute, '/api/v1/layers/dist/query?group_by=state', { id: 'dist' });
    expect(hit.headers.get('x-edge-cache')).toBe('HIT');
    const rows = await call(queryRoute, '/api/v1/layers/dist/query?limit=2', { id: 'dist' });
    expect(rows.status).toBe(200);
    expect(rows.headers.get('x-edge-cache')).toBe('MISS');
    expect(counted).toEqual(['dist', 'dist', 'dist']);
  });

  it('nearby: an unknown layer is a 400 and not counted; a known one counts on every call', async () => {
    const bad = await call(nearbyRoute, '/api/v1/nearby?lat=12&lng=77&layer=nope');
    expect(bad.status).toBe(400);
    expect(counted).toEqual([]);
    // The fixture has no geometry, so nearby fails (500, not cached), but the call named a real layer.
    const r = await call(nearbyRoute, '/api/v1/nearby?lat=12&lng=77&layer=dist');
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(counted).toEqual(['dist']);
    expect(cache.store.size).toBe(0);
  });
});
