// Review of 2026-11-19 (web/functions): wrong input is a 400 that says what is
// wrong, never a silent empty answer; filtered rows are edge-cached; locate has
// its own rate-limit counter; every /api failure is JSON.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as hyparquet from 'hyparquet';
import { fakeR2 } from './helpers/fake-r2';
import { __resetCatalogForTest } from '../functions/lib/catalog-loader';
import { clearHeadCache, clearMetadataCache } from '../functions/lib/parquet-r2';
import { query, QueryInputError, type QueryResult } from '../functions/lib/parquet-query';
import { queryCacheUrl } from '../functions/lib/query-params';
import { onRequestGet as queryRoute } from '../functions/api/v1/layers/[id]/query';
import { onRequestGet as countsRoute } from '../functions/api/v1/layers/[id]/counts';
import { onRequestGet as layerLocateRoute } from '../functions/api/v1/layers/[id]/locate';
import { onRequestGet as locateRoute } from '../functions/api/v1/locate';
import { onRequestGet as usageRoute } from '../functions/api/v1/usage';
import { onRequestGet as ogView } from '../functions/og/view/[id].png';
import { onRequest as apiMiddleware } from '../functions/api/_middleware';
import { onRequest as v1Middleware } from '../functions/api/v1/_middleware';
import { __resetApiLimiterForTest } from '../functions/lib/api-ratelimit';
import { handleMcp, type McpDeps } from '../functions/lib/mcp';

vi.mock('../functions/lib/og-render', () => ({ renderOgPng: vi.fn(async () => new Uint8Array([137, 80, 78, 71])) }));
vi.mock('hyparquet', async (importOriginal) => {
  const m = await importOriginal<typeof import('hyparquet')>();
  return { ...m, parquetReadObjects: vi.fn(m.parquetReadObjects) };
});

// sum-agg.parquet: district | state | area_ha | pop_int | small_int | label (6 rows).
const sum = readFileSync(new URL('./fixtures/sum-agg.parquet', import.meta.url));
// nearby-rg.parquet: id, nested names, WKB geometry, flat xmin/ymin/xmax/ymax.
const rg = readFileSync(new URL('./fixtures/nearby-rg.parquet', import.meta.url));
const asFile = (buf: Buffer) => ({
  byteLength: buf.byteLength,
  slice: async (start: number, end?: number) =>
    buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + (end ?? buf.byteLength)) as ArrayBuffer,
});

const catalog = {
  layers: [
    { id: 'ir_stations', level: 'x', source: 's', rows: 6, category: 'c', provenance: 'p', parquet: { url: 'https://r2.example/sum.parquet', bytes: sum.byteLength } },
  ],
  categories: {}, levels: {}, level_meta: {}, level_order: [],
};
const ASSETS = {
  fetch: async (u: string | Request) => {
    const path = new URL(typeof u === 'string' ? u : u.url).pathname;
    return path === '/catalog.json' ? new Response(JSON.stringify(catalog)) : new Response('nf', { status: 404 });
  },
};
const ctx = (path: string, id?: string, extra: Record<string, unknown> = {}) => ({
  request: new Request(`https://bharatlas.com${path}`, { headers: { 'user-agent': 'curl/8' } }),
  params: id ? { id } : {},
  env: { ASSETS, R2: fakeR2({ 'sum.parquet': sum }), ...extra },
  waitUntil: () => {},
}) as never;
const body = async (r: Response) => (await r.json()) as Record<string, unknown> & { data: Record<string, unknown> };

beforeEach(() => {
  __resetCatalogForTest();
  clearHeadCache();
  clearMetadataCache();
  __resetApiLimiterForTest();
  vi.mocked(hyparquet.parquetReadObjects).mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('query: unknown columns are a 400, read nothing', () => {
  it('select of a column that does not exist names it and lists the columns', async () => {
    const r = await queryRoute(ctx('/api/v1/layers/ir_stations/query?select=NoSuchCol', 'ir_stations'));
    expect(r.status).toBe(400);
    const b = await body(r);
    expect(b.error).toMatch(/"NoSuchCol" not found/);
    expect(b.error).toMatch(/district/);
  });

  it('a mix of known and unknown select columns is refused too', async () => {
    await expect(query(asFile(sum), { select: ['state', 'nope'] })).rejects.toThrow(/"nope" not found/);
  });

  it('a where column that does not exist is refused before any row is read', async () => {
    await expect(query(asFile(sum), { where: { nope: 'x' } })).rejects.toThrow(QueryInputError);
    await expect(query(asFile(sum), { groupBy: 'state', where: { nope: 'x' } })).rejects.toThrow(/"nope" not found/);
    expect(hyparquet.parquetReadObjects).not.toHaveBeenCalled();
  });

  it('the route answers 400 for an unknown where column (plain col=val form)', async () => {
    const r = await queryRoute(ctx('/api/v1/layers/ir_stations/query?group_by=state&nope=x', 'ir_stations'));
    expect(r.status).toBe(400);
  });
});

describe('query: the default select leaves the bounding-box columns out', () => {
  it('rows carry _lat/_lng but not xmin..ymax unless asked', async () => {
    const r = (await query(asFile(rg), { limit: 1, includeCentroid: true })) as QueryResult;
    expect(r.columns).not.toContain('xmin');
    expect(Object.keys(r.rows[0])).toEqual(expect.arrayContaining(['id', '_lat', '_lng']));
    expect(r.rows[0]).not.toHaveProperty('ymax');
    const asked = (await query(asFile(rg), { select: ['id', 'xmin'], limit: 1 })) as QueryResult;
    expect(asked.columns).toEqual(['id', 'xmin']);
  });
});

describe('counts (deprecated): filter_col/filter_val', () => {
  it('narrow the total when there is no group_by', async () => {
    const b = await body(await countsRoute(ctx('/api/v1/layers/ir_stations/counts?filter_col=state&filter_val=s2', 'ir_stations')));
    expect(b.data.total).toBe(3);
  });

  it('an unknown filter column is a 400', async () => {
    const a = await countsRoute(ctx('/api/v1/layers/ir_stations/counts?group_by=district&filter_col=nope&filter_val=x', 'ir_stations'));
    expect(a.status).toBe(400);
    const b = await countsRoute(ctx('/api/v1/layers/ir_stations/counts?filter_col=nope&filter_val=x', 'ir_stations'));
    expect(b.status).toBe(400);
  });

  it('one of the pair without the other is a 400', async () => {
    const r = await countsRoute(ctx('/api/v1/layers/ir_stations/counts?filter_col=state', 'ir_stations'));
    expect(r.status).toBe(400);
  });
});

describe('query edge cache', () => {
  function memoryCache() {
    const store = new Map<string, Response>();
    return { store, default: { match: async (k: string) => store.get(k)?.clone(), put: async (k: string, r: Response) => { store.set(k, r); } } };
  }
  const run = async (path: string) => {
    const waits: Promise<unknown>[] = [];
    const c = { ...(ctx(path, 'ir_stations') as object), waitUntil: (p: Promise<unknown>) => waits.push(p) } as never;
    const r = await queryRoute(c);
    await Promise.all(waits);
    return r;
  };

  it('a filtered row answer is kept and served again', async () => {
    const cache = memoryCache();
    vi.stubGlobal('caches', cache);
    const a = await run('/api/v1/layers/ir_stations/query?state=S1&select=district');
    const b = await run('/api/v1/layers/ir_stations/query?state=S1&select=district');
    expect(a.headers.get('x-edge-cache')).toBe('MISS');
    expect(b.headers.get('x-edge-cache')).toBe('HIT');
    expect(b.headers.get('cache-control')).toBe(a.headers.get('cache-control'));
  });

  it('group_by answers share a key whatever the row-only options say', async () => {
    const cache = memoryCache();
    vi.stubGlobal('caches', cache);
    await run('/api/v1/layers/ir_stations/query?group_by=state&limit=5');
    const b = await run('/api/v1/layers/ir_stations/query?group_by=state&select=district&include_centroid=false');
    expect(b.headers.get('x-edge-cache')).toBe('HIT');
    expect(cache.store.size).toBe(1);
  });

  it('queryCacheUrl drops options that cannot change the answer', () => {
    const u = (q: string) => queryCacheUrl(new URL(`https://x/api/v1/layers/a/query?${q}`)).search;
    expect(u('group_by=s&limit=5&select=a&include_centroid=false&order_by=x&format=csv&estimate=1')).toBe('?group_by=s');
    expect(u('group_by=s&sum=a&state=KA&filter=%5B%5D')).toBe('?group_by=s&sum=a&state=KA&filter=%5B%5D');
    expect(u('state=KA&limit=5&select=a&order_by=x')).toBe('?state=KA&limit=5&select=a');
  });
});

describe('locate: explicit layers', () => {
  it('a retired id is mapped to its successor and an unknown id is reported', async () => {
    const r = await locateRoute(ctx('/api/v1/locate?lat=12.9&lng=77.5&layers=ir_stations_merged,lgd_statez'));
    expect(r.status).toBe(200);
    const b = await body(r);
    expect(b.unknown_layers).toEqual(['lgd_statez']);
    expect(r.headers.get('content-type')).toBe('application/json');
  });

  it('none of them known is a 400 naming them', async () => {
    const r = await locateRoute(ctx('/api/v1/locate?lat=12.9&lng=77.5&layers=lgd_statez,nope'));
    expect(r.status).toBe(400);
    expect((await body(r)).error).toMatch(/lgd_statez, nope/);
  });
});

// Not counted: the viewer's locate button calls it on every tap, and each count is a D1 write.
describe('per-layer locate is not counted in /usage', () => {
  it('writes nothing to api_usage', async () => {
    const counted: string[] = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...a: unknown[]) => ({ run: async () => { if (/INTO api_usage \(/.test(sql)) counted.push(String(a[0])); } }) }),
      batch: async (s: { run(): Promise<unknown> }[]) => Promise.all(s.map((x) => x.run())),
    };
    const waits: Promise<unknown>[] = [];
    const c = { ...(ctx('/api/v1/layers/ir_stations/locate?lat=12.9&lng=77.5&mode=contains', 'ir_stations', { DB: db }) as object), waitUntil: (p: Promise<unknown>) => waits.push(p) } as never;
    const r = await layerLocateRoute(c);
    await Promise.all(waits);
    expect(r.status).toBe(200);
    expect(counted).toEqual([]);
  });
});

describe('/usage and the OG card know the layer', () => {
  it('/usage?layer=<unknown> is a 404; a retired id is a 301', async () => {
    expect((await usageRoute(ctx('/api/v1/usage?layer=nope'))).status).toBe(404);
    const moved = await usageRoute(ctx('/api/v1/usage?layer=ir_stations_merged'));
    expect(moved.status).toBe(301);
    expect(new URL(moved.headers.get('location')!).searchParams.get('layer')).toBe('ir_stations');
  });

  it('/og/view/<retired>.png is a 301 to the successor', async () => {
    const r = await ogView(ctx('/og/view/ir_stations_merged.png', 'ir_stations_merged'));
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toContain('/og/view/ir_stations.png');
  });
});

describe('every /api failure is JSON', () => {
  it('a handler that throws becomes a JSON 500 {error, status}', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await apiMiddleware({
      request: new Request('https://bharatlas.com/api/v1/levels'),
      next: async () => { throw new Error('D1_ERROR: secret detail'); },
    } as never);
    expect(r.status).toBe(500);
    expect(r.headers.get('content-type')).toBe('application/json');
    const b = await body(r);
    expect(b.status).toBe(500);
    expect(String(b.error)).not.toContain('secret');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('locate has its own rate-limit counter', () => {
  it('121 general calls in a minute (D1 says so) do not 429 locate', async () => {
    // D1 reports this key over every limit; only the key's own row matters.
    const bound: string[] = [];
    const db = { prepare: () => ({ bind: (k: string) => { bound.push(k); return { first: async () => ({ hour_window_start: new Date().toISOString(), hour_count: k.includes('locate') ? 1 : 121 }) }; } }) };
    const call = async (path: string) => {
      const waits: Promise<unknown>[] = [];
      const r = await v1Middleware({
        request: new Request(`https://bharatlas.com${path}`, { headers: { 'cf-connecting-ip': '198.51.100.9' } }),
        env: { DB: db },
        next: async () => new Response('{}'),
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      } as never);
      await Promise.all(waits);
      return r.status;
    };
    expect(await call('/api/v1/layers')).toBe(200);
    expect(await call('/api/v1/layers')).toBe(429);
    expect(await call('/api/v1/locate?lat=12&lng=77')).toBe(200);
    expect(bound.some((k) => k.includes('locate'))).toBe(true);
  });
});

describe('hosted MCP: malformed params', () => {
  const deps: McpDeps = { routes: [], rateLimit: async () => ({ ok: true }), waitUntil: () => {} };
  const post = (payload: string) => handleMcp(new Request('https://bharatlas.com/mcp', { method: 'POST', body: payload }), {} as never, deps);

  it('params: null is treated as no params', async () => {
    const r = await (await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: null }))).json() as { result?: { protocolVersion: string } };
    expect(r.result?.protocolVersion).toBe('2025-06-18');
  });

  it('params that are not an object are -32602', async () => {
    for (const params of [5, 'x', [1]]) {
      const r = await (await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params }))).json() as { error?: { code: number } };
      expect(r.error?.code).toBe(-32602);
    }
  });

  it('the body limit counts bytes, not UTF-16 units', async () => {
    // 30,000 three-byte characters: 30,000 UTF-16 units, 90,000 bytes (over 64 KiB).
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'क'.repeat(30_000) } });
    expect(big.length).toBeLessThan(64 * 1024);
    expect((await post(big)).status).toBe(413);
  });
});
