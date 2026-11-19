// Layer routes share one resolver (id check, retired 301, 404), one India
// point check, and errors that never leak internals.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fakeR2 } from './helpers/fake-r2';
import { __resetCatalogForTest } from '../functions/lib/catalog-loader';
import { clearHeadCache, clearMetadataCache } from '../functions/lib/parquet-r2';
import { parseIndiaPoint } from '../functions/lib/api-layer';
import { locate, tileAt, clearTileCache } from '../functions/lib/locate';
import { onRequestGet as schemaRoute } from '../functions/api/v1/layers/[id]/schema';
import { onRequestGet as queryRoute } from '../functions/api/v1/layers/[id]/query';
import { onRequestGet as exportRoute } from '../functions/api/v1/layers/[id]/export';
import { onRequestGet as countsRoute } from '../functions/api/v1/layers/[id]/counts';
import { onRequestGet as layerLocateRoute } from '../functions/api/v1/layers/[id]/locate';
import { onRequestGet as nearbyRoute } from '../functions/api/v1/nearby';

const sum = readFileSync(new URL('./fixtures/sum-agg.parquet', import.meta.url));
const catalog = {
  layers: [
    { id: 'ir_stations', level: 'x', source: 's', rows: 6, category: 'c', provenance: 'p', parquet: { url: 'https://r2.example/sum.parquet', bytes: sum.byteLength } },
    { id: 'gone', level: 'x', source: 's', rows: 6, category: 'c', provenance: 'p', parquet: { url: 'https://r2.example/missing.parquet', bytes: 10 }, pmtiles: { url: 'https://r2.example/missing.pmtiles', bytes: 10 } },
  ],
  categories: {}, levels: {}, level_meta: {}, level_order: [],
};
const ASSETS = {
  fetch: async (u: string | Request) => {
    const path = new URL(typeof u === 'string' ? u : u.url).pathname;
    return path === '/catalog.json' ? new Response(JSON.stringify(catalog)) : new Response('nf', { status: 404 });
  },
};
const ctx = (path: string, id?: string) => ({
  request: new Request(`https://bharatlas.com${path}`),
  params: id ? { id } : {},
  env: { ASSETS, R2: fakeR2({ 'sum.parquet': sum }) },
  waitUntil: () => {},
}) as never;

beforeEach(() => {
  __resetCatalogForTest();
  clearHeadCache();
  clearMetadataCache();
});

describe('a retired layer id answers 301 on every layer route', () => {
  const OLD = 'ir_stations_merged';
  it.each([
    ['schema', schemaRoute, `/api/v1/layers/${OLD}/schema`],
    ['query', queryRoute, `/api/v1/layers/${OLD}/query?group_by=state`],
    ['export', exportRoute, `/api/v1/layers/${OLD}/export?format=csv&state=S1`],
    ['counts', countsRoute, `/api/v1/layers/${OLD}/counts`],
    ['locate', layerLocateRoute, `/api/v1/layers/${OLD}/locate?lat=12&lng=77`],
  ])('%s', async (_n, route, path) => {
    const r = await route(ctx(path, OLD));
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toContain('/layers/ir_stations/');
  });

  it('nearby swaps the layer query parameter', async () => {
    const r = await nearbyRoute(ctx(`/api/v1/nearby?lat=12&lng=77&layer=${OLD}`));
    expect(r.status).toBe(301);
    expect(new URL(r.headers.get('location')!).searchParams.get('layer')).toBe('ir_stations');
  });
});

describe('parseIndiaPoint', () => {
  const p = (q: string) => parseIndiaPoint(new URLSearchParams(q));
  it('accepts a point in India and refuses a missing or outside one', () => {
    expect(p('lat=12.9&lng=77.5')).toEqual({ lat: 12.9, lng: 77.5 });
    expect(p('lat=12.9')).toEqual({ error: 'lat and lng query params are required' });
    expect(p('lat=x&lng=77')).toHaveProperty('error');
    expect(p('lat=51.5&lng=0')).toEqual({ error: 'lat must be 6-38, lng must be 68-98 (India bounding box)' });
  });
});

describe('server faults are 500s that name no internals', () => {
  it('a missing R2 object does not leak its key', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await schemaRoute(ctx('/api/v1/layers/gone/schema', 'gone'));
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(body).not.toContain('missing.parquet');
    expect(err).toHaveBeenCalled(); // the detail went to the log
    err.mockRestore();
  });
});

describe('locate reports layers it could not read', () => {
  it('a failed layer is listed, not taken for "no feature here"', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await locate(12, 77, ['gone'], 14, catalog as never, fakeR2({}));
    expect(r.failed_layers).toEqual(['gone']);
    expect(r.results).toEqual({});
    err.mockRestore();
  });

  it('layers/{id}/locate?mode=contains answers 500 when the tiles cannot be read', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await layerLocateRoute(ctx('/api/v1/layers/gone/locate?lat=12&lng=77&mode=contains', 'gone'));
    expect(r.status).toBe(500);
    err.mockRestore();
  });
});

describe('locate keeps recently read tiles', () => {
  it('a tile asked twice is read once', async () => {
    clearTileCache();
    const data = new ArrayBuffer(8);
    const pm = { getZxy: vi.fn(async () => ({ data })) };
    expect(await tileAt(pm as never, 'k', 14, 1, 2)).toBe(data);
    expect(await tileAt(pm as never, 'k', 14, 1, 2)).toBe(data);
    expect(await tileAt(pm as never, 'k', 14, 1, 3)).toBe(data);
    expect(pm.getZxy).toHaveBeenCalledTimes(2);
  });
  it('remembers a missing tile too', async () => {
    clearTileCache();
    const pm = { getZxy: vi.fn(async () => undefined) };
    expect(await tileAt(pm as never, 'k', 5, 0, 0)).toBeNull();
    expect(await tileAt(pm as never, 'k', 5, 0, 0)).toBeNull();
    expect(pm.getZxy).toHaveBeenCalledTimes(1);
  });
});

describe('counts (deprecated) answers group_by from the parquet', () => {
  it('counts any column without precomputed stats, honouring filter_col', async () => {
    const all = await (await countsRoute(ctx('/api/v1/layers/ir_stations/counts?group_by=state', 'ir_stations'))).json() as { data: { counts: Record<string, number>; total: number } };
    expect(all.data.counts).toEqual({ S1: 3, S2: 3 });
    const one = await (await countsRoute(ctx('/api/v1/layers/ir_stations/counts?group_by=district&filter_col=state&filter_val=s2', 'ir_stations'))).json() as { data: { counts: Record<string, number>; total: number } };
    expect(one.data).toMatchObject({ total: 3, counts: { C: 2, B: 1 } });
    expect(JSON.stringify(one)).not.toMatch(/build_api_indexes|filter_note/);
  });
});

describe('export estimate is kept in the edge cache', () => {
  it('a second identical estimate is a cache hit', async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', { default: {
      match: async (k: string) => store.get(k)?.clone(),
      put: async (k: string, r: Response) => { store.set(k, r); },
    } });
    const waits: Promise<unknown>[] = [];
    const c = () => ({ ...(ctx('/api/v1/layers/ir_stations/export?estimate=1&state=S1', 'ir_stations') as object), waitUntil: (p: Promise<unknown>) => waits.push(p) }) as never;
    const a = await exportRoute(c());
    await Promise.all(waits);
    const b = await exportRoute(c());
    expect(a.headers.get('x-edge-cache')).toBe('MISS');
    expect(b.headers.get('x-edge-cache')).toBe('HIT');
    expect(((await b.json()) as { data: { total: number } }).data.total).toBe(3);
    vi.unstubAllGlobals();
  });
});
