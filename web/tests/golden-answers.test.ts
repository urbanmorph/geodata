// API answers are cached under their endpoint's answer version (lib/answer-versions.ts) and
// the data they read, not the build id, so a deploy keeps them (edge-cache.ts answerKey).
// The price: a change that alters an answer must bump its endpoint's version, or callers
// get the old answer until it expires.
//
// The guard: tests/golden-answers.json records, for each endpoint version, a hash of its
// answers to the requests below. Change an answer and the hash differs: bump the endpoint in
// answer-versions.ts and add a line for the new version (the failure prints it). Editing the
// hash of an existing version instead is the one way round it, and shows in review as
// exactly that. The snapshots alongside show what changed (update them with -u).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ANSWER_V, type AnswerEndpoint } from '../functions/lib/answer-versions';
import { __resetCatalogForTest } from '../functions/lib/catalog-loader';
import { clearMetadataCache, clearHeadCache } from '../functions/lib/parquet-r2';
import { clearValueIndexCache } from '../functions/lib/value-index';
import { onRequestGet as layersIndex } from '../functions/api/v1/layers/index';
import { onRequestGet as categories } from '../functions/api/v1/categories';
import { onRequestGet as levels } from '../functions/api/v1/levels';
import { onRequestGet as layerDetail } from '../functions/api/v1/layers/[id]';
import { onRequestGet as schemaRoute } from '../functions/api/v1/layers/[id]/schema';
import { onRequestGet as queryRoute } from '../functions/api/v1/layers/[id]/query';
import { onRequestGet as countsRoute } from '../functions/api/v1/layers/[id]/counts';
import { onRequestGet as exportRoute } from '../functions/api/v1/layers/[id]/export';
import { onRequestGet as nearbyRoute } from '../functions/api/v1/nearby';
import { surfaceAt, SURFACE_LAYERS } from '../functions/lib/surface';
import { groundAt, GROUND_PROFILE } from '../functions/lib/ground';
import type { ProfileDeps } from '../functions/lib/profile';
import type { CatalogData, CatalogLayer } from '../functions/lib/catalog-api';
import type { LocateResponse } from '../functions/lib/locate';
import type { NearbyResult } from '../functions/lib/nearby';
import { fakeR2 } from './helpers/fake-r2';

const REGISTRY = JSON.parse(readFileSync(new URL('./golden-answers.json', import.meta.url), 'utf8')) as Record<string, string>;
const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url));
const DIST = fixture('sum-agg.parquet');
const LINES = fixture('nearby-lines.parquet');
const TYPES = fixture('schema-types.parquet');
const TYPES_STATS = JSON.parse(fixture('schema-types.stats.json').toString());
const DIST_COUNTS = { row_count: 6, columns: { state: { type: 'VARCHAR', distinct: 2, row_count: 6, values: { S1: 3, S2: 3 } } } };

const CATALOG = {
  categories: { boundaries: 'Boundaries', water: 'Water', health: 'Health' },
  level_meta: {},
  levels: {
    district: { order: 2, plural: 'districts', category: 'boundaries' },
    river: { order: 5, plural: 'rivers', category: 'water' },
    facility: { order: 9, plural: 'facilities', category: 'health' },
  },
  layers: [
    { id: 'dist', name: 'Districts', level: 'district', category: 'boundaries', source: 'LGD', rows: 6, licence: 'GODL-India',
      parquet: { url: 'https://pub-x.r2.dev/t/dist.parquet', bytes: DIST.byteLength } },
    { id: 'lines', name: 'Lines', level: 'river', category: 'water', source: 'Test', rows: 54, licence: 'CC0-1.0',
      parquet: { url: 'https://pub-x.r2.dev/t/lines.parquet', bytes: LINES.byteLength } },
    // non-commercial, with a baked stats file (schema, Filter stats)
    { id: 'types', name: 'Types', level: 'facility', category: 'health', source: 'Test', rows: 30, licence: 'CC-BY-NC-4.0',
      parquet: TYPES_STATS.parquet },
  ],
};
const R2 = fakeR2({ 't/dist.parquet': DIST, 't/lines.parquet': LINES, 'schema-types.parquet': TYPES });
const ASSETS: Record<string, unknown> = {
  '/catalog.json': CATALOG,
  '/api-data/filter-stats/types.json': TYPES_STATS,
  '/api-data/layers/dist.json': DIST_COUNTS,
};
const assets = {
  fetch: vi.fn(async (url: string) => {
    const a = ASSETS[new URL(url).pathname];
    return a ? new Response(JSON.stringify(a)) : new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
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

type Handler = (ctx: never) => Promise<Response> | Response;
/** One request, with the point lookups published (production) or not. */
async function call(handler: Handler, path: string, params: Record<string, string> = {}, lookups = true) {
  const res = await handler({
    request: new Request(`https://bharatlas.com${path}`, { headers: { 'user-agent': 'bharatlas-mcp-test' } }),
    env: { ASSETS: assets, R2, POINT_PROFILES: lookups ? 'on' : 'off' }, params, waitUntil: () => {},
  } as never);
  return { path, lookups, status: res.status, body: body(JSON.parse(await res.text())) };
}
const both = async (handler: Handler, path: string, params: Record<string, string> = {}) =>
  [await call(handler, path, params, true), await call(handler, path, params, false)];

/** The registry check, then the readable snapshot. */
function expectGolden(endpoint: AnswerEndpoint, answers: unknown) {
  const key = `${endpoint}@v${ANSWER_V[endpoint]}`;
  const hash = createHash('sha256').update(JSON.stringify(answers)).digest('hex').slice(0, 16);
  expect(REGISTRY[key], `The ${endpoint} answers changed. Bump ANSWER_V.${endpoint} in functions/lib/answer-versions.ts, `
    + `then add to tests/golden-answers.json: "${endpoint}@v${ANSWER_V[endpoint] + (REGISTRY[key] ? 1 : 0)}": "${hash}"`).toBe(hash);
  expect(answers).toMatchSnapshot(key);
}

beforeEach(() => {
  __resetCatalogForTest(); clearMetadataCache(); clearHeadCache(); clearValueIndexCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('golden answers (a changed answer needs its ANSWER_V bumped)', () => {
  it('layers: the list, categories and levels', async () => {
    expectGolden('layers', [
      ...await both(layersIndex, '/api/v1/layers'), ...await both(layersIndex, '/api/v1/layers?category=health'),
      await call(categories, '/api/v1/categories'), await call(levels, '/api/v1/levels'),
    ]);
  });
  it('detail', async () => {
    expectGolden('detail', [...await both(layerDetail, '/api/v1/layers/dist', { id: 'dist' }), ...await both(layerDetail, '/api/v1/layers/types', { id: 'types' })]);
  });
  it('schema: read live, and from a baked stats file of a non-commercial layer', async () => {
    expectGolden('schema', [await call(schemaRoute, '/api/v1/layers/dist/schema', { id: 'dist' }), await call(schemaRoute, '/api/v1/layers/types/schema', { id: 'types' })]);
  });
  it('query', async () => {
    expectGolden('query', [
      await call(queryRoute, '/api/v1/layers/dist/query?limit=3', { id: 'dist' }),
      await call(queryRoute, '/api/v1/layers/dist/query?group_by=state', { id: 'dist' }),
      await call(queryRoute, '/api/v1/layers/dist/query?state=S1&limit=2', { id: 'dist' }),
      await call(queryRoute, '/api/v1/layers/dist/query?state=nowhere', { id: 'dist' }),
      await call(queryRoute, '/api/v1/layers/types/query?limit=2', { id: 'types' }),
    ]);
  });
  it('counts: from the baked counts, and filtered from the parquet', async () => {
    expectGolden('counts', [
      await call(countsRoute, '/api/v1/layers/dist/counts?group_by=state', { id: 'dist' }),
      await call(countsRoute, '/api/v1/layers/dist/counts?state=S1', { id: 'dist' }),
    ]);
  });
  it('export estimate', async () => {
    expectGolden('export', [await call(exportRoute, '/api/v1/layers/dist/export?estimate=1&format=csv&state=S1', { id: 'dist' })]);
  });
  it('nearby', async () => {
    expectGolden('nearby', [
      await call(nearbyRoute, '/api/v1/nearby?lat=28.5&lng=77.012&radius_km=5&layer=lines&limit=5'),
      await call(nearbyRoute, '/api/v1/nearby?lat=20&lng=80.0104&radius_km=0.5&layer=lines&limit=3'),
    ]);
  });

  // The point lookups with fixed readers: what is checked is the answer's shaping (sections,
  // summary, credits, notes, ward lines), which is where code changes land.
  const layer = (id: string): CatalogLayer => ({
    id, level: id, source: 'S', rows: 1, category: 'x', provenance: 'p', licence: id === 'lgd_assembly' ? 'CC-BY-NC-4.0' : 'CC0-1.0',
    attribution: { primary: { name: `Pub ${id}`, url: `https://pub/${id}` } },
    pmtiles: { url: `https://r2/${id}.pmtiles`, bytes: 1 }, parquet: { url: `https://r2/${id}.parquet`, bytes: 1 },
  }) as unknown as CatalogLayer;
  const near = (props: Record<string, unknown>, d: number): NearbyResult => ({
    center: { lat: 0, lng: 0 }, radius_km: 1, total: 1, timing_ms: 1, _source: 'parquet-bbox', rows_scanned: 1,
    features: [{ properties: props, _lat: 1, _lng: 2, _distance_km: d }],
  });
  const FEATURES: Record<string, Record<string, unknown>> = {
    lgd_districts: { dtname: 'Kolkata' }, lgd_assembly: { ac_name: 'Somewhere' },
    sbm_wards: { wardcode: '8', wardname: 'Test Ward' }, wards_delhi: { Ward_No: '72', Ward_Name: 'CHANDNI CHOWK' },
  };
  const deps: ProfileDeps = {
    locate: async (_lat, _lng, ids) => ({
      point: { lat: 0, lng: 0 }, zoom: 14, queried_layers: ids, timing_ms: 1,
      results: { x: ids.filter((id) => FEATURES[id]).map((id) => ({ layer_id: id, level: id, category: 'x', feature: { properties: FEATURES[id] } })) },
    }) as LocateResponse,
    nearby: async (_lat, _lng, _r, id) => (id === 'nin_health_facilities' ? near({ health_facility_name: 'Near PHC' }, 1.2) : { ...near({}, 0), total: 0, features: [] }),
    nearbyFromTiles: async () => ({ features: [], total: 0, capped: false }),
    nearbyByGeometry: async () => ({ features: [], total: 0, capped: false }),
    pixels: {},
  };
  const profileCatalog = (ids: string[]) => ({ layers: [...new Set(ids)].map(layer), categories: {}, levels: {}, level_meta: {}, level_order: [] }) as unknown as CatalogData;
  const surfaceCatalog = profileCatalog([...SURFACE_LAYERS.map((l) => l.id), 'sbm_wards', 'wards_delhi']);

  it('surface: the national ward map and a city one; open_only and a sections filter', async () => {
    expectGolden('surface', [
      body(await surfaceAt(13.993, 74.522, surfaceCatalog, {} as R2Bucket, deps)),
      body(await surfaceAt(28.6315, 77.2167, surfaceCatalog, {} as R2Bucket, deps)),
      body(await surfaceAt(28.6315, 77.2167, surfaceCatalog, {} as R2Bucket, deps, { openOnly: true, filter: { sections: ['place'] } })),
    ]);
  });
  it('ground', async () => {
    const g = profileCatalog(GROUND_PROFILE.layers.map((l) => l.id));
    expectGolden('ground', [
      body(await groundAt(13.993, 74.522, g, {} as R2Bucket, deps)),
      body(await groundAt(13.993, 74.522, g, {} as R2Bucket, deps, { filter: { sections: ['seismic'] } })),
    ]);
  });
});
