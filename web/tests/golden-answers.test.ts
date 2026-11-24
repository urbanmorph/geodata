// API answers are cached under their endpoint's answer version (lib/answer-versions.ts) and
// the data they read, not the build id, so a deploy keeps them (edge-cache.ts answerKey).
// The price: a change that alters an answer must bump its endpoint's version, or callers
// get the old answer until it expires. These snapshots are named by the versions: change an
// answer without a bump and this fails; bump it and the new snapshot is written by
// `npx vitest run tests/golden-answers.test.ts -u` (CI never writes one: commit it).
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ANSWER_V } from '../functions/lib/answer-versions';
import { __resetCatalogForTest } from '../functions/lib/catalog-loader';
import { clearMetadataCache, clearHeadCache } from '../functions/lib/parquet-r2';
import { clearValueIndexCache } from '../functions/lib/value-index';
import { onRequestGet as layersIndex } from '../functions/api/v1/layers/index';
import { onRequestGet as categories } from '../functions/api/v1/categories';
import { onRequestGet as layerDetail } from '../functions/api/v1/layers/[id]';
import { onRequestGet as schemaRoute } from '../functions/api/v1/layers/[id]/schema';
import { onRequestGet as queryRoute } from '../functions/api/v1/layers/[id]/query';
import { onRequestGet as countsRoute } from '../functions/api/v1/layers/[id]/counts';
import { onRequestGet as exportRoute } from '../functions/api/v1/layers/[id]/export';
import { onRequestGet as nearbyRoute } from '../functions/api/v1/nearby';
import { surfaceAt } from '../functions/lib/surface';
import { groundAt } from '../functions/lib/ground';
import type { ProfileDeps } from '../functions/lib/profile';
import type { CatalogData, CatalogLayer } from '../functions/lib/catalog-api';
import type { LocateResponse } from '../functions/lib/locate';
import type { NearbyResult } from '../functions/lib/nearby';
import { fakeR2 } from './helpers/fake-r2';

const DIST = readFileSync(new URL('./fixtures/sum-agg.parquet', import.meta.url));
const LINES = readFileSync(new URL('./fixtures/nearby-lines.parquet', import.meta.url));
const CATALOG = {
  categories: { boundaries: 'Boundaries', water: 'Water' },
  level_meta: {},
  levels: { district: { order: 2, plural: 'districts', category: 'boundaries' }, river: { order: 5, plural: 'rivers', category: 'water' } },
  layers: [
    { id: 'dist', name: 'Districts', level: 'district', category: 'boundaries', source: 'LGD', rows: 6, licence: 'GODL-India',
      parquet: { url: 'https://pub-x.r2.dev/t/dist.parquet', bytes: DIST.byteLength } },
    { id: 'lines', name: 'Lines', level: 'river', category: 'water', source: 'Test', rows: 54, licence: 'CC0-1.0',
      parquet: { url: 'https://pub-x.r2.dev/t/lines.parquet', bytes: LINES.byteLength } },
  ],
};
const R2 = fakeR2({ 't/dist.parquet': DIST, 't/lines.parquet': LINES });
const assets = {
  fetch: vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/catalog.json') return new Response(JSON.stringify(CATALOG));
    return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
  }),
};

/** The answer's body with the server's own timings left out (they differ per run). */
function body(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(body);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !/^(timing_ms|layer_timing_ms|rows_scanned)$/.test(k)).map(([k, x]) => [k, body(x)]));
  }
  return v;
}

async function call(handler: (ctx: never) => Promise<Response> | Response, path: string, params: Record<string, string> = {}) {
  const res = await handler({
    request: new Request(`https://bharatlas.com${path}`, { headers: { 'user-agent': 'bharatlas-mcp-test' } }),
    env: { ASSETS: assets, R2, POINT_PROFILES: 'on' }, params, waitUntil: () => {},
  } as never);
  return { status: res.status, body: body(JSON.parse(await res.text())) };
}

beforeEach(() => {
  __resetCatalogForTest(); clearMetadataCache(); clearHeadCache(); clearValueIndexCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('golden answers (a changed answer needs its ANSWER_V bumped)', () => {
  it('layers', async () => {
    const a = [await call(layersIndex, '/api/v1/layers'), await call(categories, '/api/v1/categories')];
    expect(a).toMatchSnapshot(`layers@v${ANSWER_V.layers}`);
  });
  it('detail', async () => {
    expect(await call(layerDetail, '/api/v1/layers/dist', { id: 'dist' })).toMatchSnapshot(`detail@v${ANSWER_V.detail}`);
  });
  it('schema', async () => {
    expect(await call(schemaRoute, '/api/v1/layers/dist/schema', { id: 'dist' })).toMatchSnapshot(`schema@v${ANSWER_V.schema}`);
  });
  it('query', async () => {
    const a = [
      await call(queryRoute, '/api/v1/layers/dist/query?limit=3', { id: 'dist' }),
      await call(queryRoute, '/api/v1/layers/dist/query?group_by=state', { id: 'dist' }),
      await call(queryRoute, '/api/v1/layers/dist/query?state=S1&limit=2', { id: 'dist' }),
      await call(queryRoute, '/api/v1/layers/dist/query?state=nowhere', { id: 'dist' }),
    ];
    expect(a).toMatchSnapshot(`query@v${ANSWER_V.query}`);
  });
  it('counts', async () => {
    expect(await call(countsRoute, '/api/v1/layers/dist/counts?group_by=state', { id: 'dist' })).toMatchSnapshot(`counts@v${ANSWER_V.counts}`);
  });
  it('export', async () => {
    expect(await call(exportRoute, '/api/v1/layers/dist/export?estimate=1&format=csv&state=S1', { id: 'dist' })).toMatchSnapshot(`export@v${ANSWER_V.export}`);
  });
  it('nearby', async () => {
    const a = [
      await call(nearbyRoute, '/api/v1/nearby?lat=28.5&lng=77.012&radius_km=5&layer=lines&limit=5'),
      await call(nearbyRoute, '/api/v1/nearby?lat=20&lng=80.0104&radius_km=0.5&layer=lines&limit=3'),
    ];
    expect(a).toMatchSnapshot(`nearby@v${ANSWER_V.nearby}`);
  });

  // The point lookups with fixed readers: what is checked is the answer's shaping (sections,
  // summary, credits, notes), which is where code changes land.
  const layer = (id: string): CatalogLayer => ({
    id, level: id, source: 'S', rows: 1, category: 'x', provenance: 'p', licence: 'CC0-1.0',
    attribution: { primary: { name: `Pub ${id}`, url: `https://pub/${id}` } },
    pmtiles: { url: `https://r2/${id}.pmtiles`, bytes: 1 }, parquet: { url: `https://r2/${id}.parquet`, bytes: 1 },
  }) as unknown as CatalogLayer;
  const near = (props: Record<string, unknown>, d: number): NearbyResult => ({
    center: { lat: 0, lng: 0 }, radius_km: 1, total: 1, timing_ms: 1, _source: 'parquet-bbox', rows_scanned: 1,
    features: [{ properties: props, _lat: 1, _lng: 2, _distance_km: d }],
  });
  const deps: ProfileDeps = {
    locate: async (_lat, _lng, ids) => ({
      point: { lat: 0, lng: 0 }, zoom: 14, queried_layers: ids, timing_ms: 1,
      results: { x: ids.flatMap((id) => (id === 'lgd_districts' ? [{ layer_id: id, level: id, category: 'x', feature: { properties: { dtname: 'Kolkata' } } }]
        : id === 'sbm_wards' ? [{ layer_id: id, level: id, category: 'x', feature: { properties: { wardcode: '8', wardname: 'Test Ward' } } }] : [])) },
    }) as LocateResponse,
    nearby: async (_lat, _lng, _r, id) => (id === 'nin_health_facilities' ? near({ health_facility_name: 'Near PHC' }, 1.2) : { ...near({}, 0), total: 0, features: [] }),
    nearbyFromTiles: async () => ({ features: [], total: 0, capped: false }),
    nearbyByGeometry: async () => ({ features: [], total: 0, capped: false }),
    pixels: {},
  };
  const profileCatalog = (ids: string[]) => ({ layers: [...new Set(ids)].map(layer), categories: {}, levels: {}, level_meta: {}, level_order: [] }) as unknown as CatalogData;

  it('surface', async () => {
    const { SURFACE_LAYERS } = await import('../functions/lib/surface');
    const s = await surfaceAt(13.993, 74.522, profileCatalog([...SURFACE_LAYERS.map((l) => l.id), 'sbm_wards']), {} as R2Bucket, deps);
    expect(body(s)).toMatchSnapshot(`surface@v${ANSWER_V.surface}`);
  });
  it('ground', async () => {
    const { GROUND_PROFILE } = await import('../functions/lib/ground');
    const g = await groundAt(13.993, 74.522, profileCatalog(GROUND_PROFILE.layers.map((l) => l.id)), {} as R2Bucket, deps);
    expect(body(g)).toMatchSnapshot(`ground@v${ANSWER_V.ground}`);
  });
});
