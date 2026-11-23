// Lookup filters (owner design, 2026-11-23): the layer listings say each layer's
// realm and which point lookup reads it (and in which section), and /ground and
// /surface read only the sections or layers asked for. Membership comes from the
// lookups' own tables (GROUND_PROFILE, SURFACE_PROFILE), never a hand-kept copy.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GROUND_LAYERS, GROUND_PROFILE, SECTIONS } from '../functions/lib/ground';
import { SURFACE_LAYERS, SURFACE_PROFILE, SURFACE_SECTIONS, surfaceAt } from '../functions/lib/surface';
import { LOOKUPS, LOOKUP_GUIDE, lookupsOf } from '../functions/lib/lookups';
import { parseProfileFilter, selectProfile, profileAt, type ProfileDeps } from '../functions/lib/profile';
import { profileHandler } from '../functions/lib/profile-endpoint';
import { WARD_BBOXES } from '../functions/lib/ward-bboxes';
import { __resetCatalogForTest } from '../functions/lib/catalog-loader';
import { onRequestGet as layersIndex } from '../functions/api/v1/layers/index';
import { onRequestGet as layerDetail } from '../functions/api/v1/layers/[id]';
import type { CatalogData, CatalogLayer } from '../functions/lib/catalog-api';
import type { LocateResponse } from '../functions/lib/locate';

const params = (q: string) => new URLSearchParams(q);

describe('lookup membership, from the lookup tables', () => {
  it('names each table layer with its lookup and section', () => {
    for (const l of GROUND_LAYERS) expect(lookupsOf(l.id)?.ground, l.id).toBe(l.section);
    for (const l of SURFACE_LAYERS) expect(lookupsOf(l.id)?.surface, l.id).toBe(l.section);
  });

  it('a layer both lookups read says both', () => {
    expect(lookupsOf('seismic_zones')).toEqual({ ground: 'seismic', surface: 'hazards' });
    expect(lookupsOf('ndem_floods_1998_2022')).toEqual({ ground: 'watershed', surface: 'water' });
  });

  it('ward layers are read by /surface in place', () => {
    for (const id of [...Object.keys(WARD_BBOXES), 'sbm_wards', 'wb_amrut_wards']) expect(lookupsOf(id), id).toEqual({ surface: 'place' });
  });

  it('a layer no lookup reads has none', () => {
    expect(lookupsOf('lgd_villages')).toBeUndefined();
  });

  it('no layer sits in two sections of one lookup (so one section per lookup is the whole truth)', () => {
    for (const [name, spec] of Object.entries(LOOKUPS)) {
      const seen = new Map<string, string>();
      for (const l of spec.layers) {
        if (seen.has(l.id)) expect(seen.get(l.id), `${name}: ${l.id}`).toBe(l.section);
        seen.set(l.id, l.section);
      }
    }
  });

  it('the rasters, which are not layers, are described with their sections', () => {
    expect(LOOKUP_GUIDE.ground.bySection).toMatch(/(^|; )soil: soilgrids \(raster\), slusi_soil_health(;|$)/);
    expect(LOOKUP_GUIDE.surface.bySection).toMatch(/(^|; )land: worldcover \(raster\), dem \(raster\), worldpop \(raster\), corestack_lulc_blocks/);
    expect(LOOKUP_GUIDE.surface.bySection).toMatch(/(^|; )place: .*the ward layer covering the point(;|$)/);
  });
});

describe('parseProfileFilter', () => {
  it('no filter reads everything', () => {
    expect(parseProfileFilter(GROUND_PROFILE, params(''))).toEqual({ filter: undefined });
    expect(parseProfileFilter(GROUND_PROFILE, params('sections=&layers=,'))).toEqual({ filter: undefined });
  });

  it('normalises: sorted, deduped, trimmed, repeated params joined', () => {
    expect(parseProfileFilter(GROUND_PROFILE, params('sections=soil, seismic,soil&sections=geology'))).toEqual({ filter: { sections: ['geology', 'seismic', 'soil'] } });
    expect(parseProfileFilter(SURFACE_PROFILE, params('layers=dem,airports,dem'))).toEqual({ filter: { layers: ['airports', 'dem'] } });
  });

  it('every section asked is everything', () => {
    expect(parseProfileFilter(GROUND_PROFILE, params(`sections=${SECTIONS.join(',')}`))).toEqual({ filter: undefined });
    expect(parseProfileFilter(GROUND_PROFILE, params(`sections=${SECTIONS.join(',')}&layers=soilgrids`))).toEqual({ filter: undefined });
  });

  it('an unknown section is an error naming the valid ones', () => {
    const r = parseProfileFilter(GROUND_PROFILE, params('sections=soil,weather'));
    expect('error' in r && r.error).toMatch(/Unknown section "weather".*seismic, geology, resources, groundwater, soil, subsidence, underground, watershed/);
  });

  it('a layer the lookup does not read is an error naming the valid ones', () => {
    const r = parseProfileFilter(GROUND_PROFILE, params('layers=airports'));
    expect('error' in r && r.error).toMatch(/"airports" is not read by this lookup/);
    expect('error' in r && r.error).toMatch(/soilgrids/);
    expect('error' in r && r.error).toMatch(/cgwb_aquifers/);
  });

  it('takes layer ids, entry keys, rasters and ward layers', () => {
    for (const id of ['gs_wildlife', 'gs_wildlife_nearest', 'india_outline', 'india_boundary', 'worldpop', 'wards_chennai', 'sbm_wards']) {
      expect(parseProfileFilter(SURFACE_PROFILE, params(`layers=${id}`)), id).toEqual({ filter: { layers: [id] } });
    }
  });
});

describe('selectProfile', () => {
  it('keeps the sections asked, in table order, with their layers and rasters', () => {
    const s = selectProfile(SURFACE_PROFILE, { sections: ['land', 'access'] });
    expect(s.sections).toEqual(['land', 'access']);
    expect(new Set(s.layers.map((l) => l.section))).toEqual(new Set(['land', 'access']));
    expect(s.pixels.map((p) => p.id)).toEqual(['worldcover', 'dem', 'worldpop']);
    expect(s.expand!(12.9716, 77.5946, {} as CatalogData)).toEqual([]); // wards are place
  });

  it('a section and a layer elsewhere: both', () => {
    const s = selectProfile(SURFACE_PROFILE, { sections: ['water'], layers: ['airports', 'dem'] });
    expect(s.sections).toEqual(['land', 'water', 'access']);
    expect(s.pixels.map((p) => p.id)).toEqual(['dem']);
    expect(s.layers.filter((l) => l.section !== 'water').map((l) => l.id)).toEqual(['airports']);
  });

  it('place brings the ward layer covering the point', () => {
    const s = selectProfile(SURFACE_PROFILE, { sections: ['place'] });
    expect(s.expand!(12.9716, 77.5946, {} as CatalogData).some((l) => l.id.startsWith('wards_bengaluru'))).toBe(true);
  });

  it('a ward layer asked by id is read even where it does not cover the point (then not_covered)', () => {
    const s = selectProfile(SURFACE_PROFILE, { layers: ['wards_chennai'] });
    expect(s.sections).toEqual(['place']);
    expect(s.layers).toEqual([]);
    expect(s.expand!(12.9716, 77.5946, {} as CatalogData)).toEqual([expect.objectContaining({ id: 'wards_chennai', section: 'place', match: 'contains' })]);
  });

  it('no filter is the profile unchanged', () => {
    expect(selectProfile(GROUND_PROFILE, undefined)).toBe(GROUND_PROFILE);
  });
});

// ── the runner reads only what was asked ─────────────────────────────────────

const layer = (id: string): CatalogLayer => ({
  id, level: id, source: 'S', rows: 1, category: 'x', provenance: 'p', licence: 'CC0-1.0',
  attribution: { primary: { name: `Pub ${id}`, url: `https://pub/${id}` } },
  pmtiles: { url: `https://r2/${id}.pmtiles`, bytes: 1 }, parquet: { url: `https://r2/${id}.parquet`, bytes: 1 },
});
const ids = [...new Set([...SURFACE_LAYERS.map((l) => l.id), ...Object.keys(WARD_BBOXES), 'sbm_wards'])];
const catalog = { layers: ids.map(layer), categories: {}, levels: {}, level_meta: {}, level_order: [] } as unknown as CatalogData;

function recordingDeps() {
  const read: string[] = [];
  const deps: ProfileDeps = {
    locate: async (_lat, _lng, layerIds) => {
      read.push(...layerIds);
      return { point: { lat: 0, lng: 0 }, zoom: 14, queried_layers: layerIds, timing_ms: 1, results: {} } as LocateResponse;
    },
    nearby: async (_lat, _lng, r, id) => {
      read.push(id);
      return { center: { lat: 0, lng: 0 }, radius_km: r, total: 0, features: [], timing_ms: 1, _source: 'parquet-bbox', rows_scanned: 0 };
    },
    nearbyByGeometry: async (_lat, _lng, _r, id) => { read.push(id); return { features: [], total: 0, capped: false }; },
    nearbyFromTiles: async (_lat, _lng, _r, id) => { read.push(id); return { features: [], total: 0, capped: false }; },
    pixels: Object.fromEntries(['worldcover', 'dem', 'worldpop'].map((id) => [id, async () => { read.push(id); return { status: 'ok' as const, data: { v: 1 } }; }])),
  };
  return { read, deps };
}

describe('a filtered lookup', () => {
  it('reads only the asked sections and layers, and says what it was asked', async () => {
    const { read, deps } = recordingDeps();
    const s = await surfaceAt(22.57, 88.36, catalog, {} as R2Bucket, deps, { filter: { sections: ['access'], layers: ['dem'] } });
    const access = SURFACE_LAYERS.filter((l) => l.section === 'access').map((l) => l.id);
    expect(new Set(read)).toEqual(new Set([...access, 'dem'])); // a layer with nothing near may read twice (its coverage)
    expect(Object.keys(s.sections)).toEqual(['land', 'access']);
    expect(Object.keys(s.sections.land)).toEqual(['dem']);
    expect(s.filter).toEqual({ sections: ['access'], layers: ['dem'] });
    expect(Object.keys(s.layer_timing_ms).sort()).toEqual([...access, 'dem'].sort());
  });

  it('unfiltered, it reads every layer and says no filter', async () => {
    const { read, deps } = recordingDeps();
    const s = await profileAt(SURFACE_PROFILE, 22.57, 88.36, catalog, {} as R2Bucket, deps);
    const wards = SURFACE_PROFILE.expand!(22.57, 88.36, catalog).map((l) => l.id);
    expect(new Set(read)).toEqual(new Set([...SURFACE_LAYERS.map((l) => l.id), ...wards, 'worldcover', 'dem', 'worldpop']));
    expect(Object.keys(s.sections)).toEqual([...SURFACE_SECTIONS]);
    expect(s.filter).toBeUndefined();
  });
});

// ── the endpoint: 400s, and the filter in the edge-cache key ─────────────────

function memoryCache() {
  const store = new Map<string, Response>();
  return { store, default: { async match(k: string) { return store.get(String(k))?.clone(); }, async put(k: string, r: Response) { store.set(String(k), r); } } };
}

describe('the lookup endpoint with filters', () => {
  let cache: ReturnType<typeof memoryCache>;
  beforeEach(() => { cache = memoryCache(); vi.stubGlobal('caches', cache); __resetCatalogForTest(); });
  afterEach(() => vi.unstubAllGlobals());

  const runs: unknown[] = [];
  const handler = profileHandler('ground', GROUND_PROFILE, async (lat, lng, _c, _r2, opts) => {
    runs.push(opts.filter);
    return { point: { lat, lng }, summary: '', disclaimer: '', sections: {}, unavailable: [], attribution: [], timing_ms: 0, layer_timing_ms: {} };
  }, 'v');
  const ASSETS = { fetch: async (u: string) => (u.endsWith('catalog.json') ? new Response('{"layers":[]}') : new Response('', { status: 404 })) };
  const call = async (q: string) => {
    const waits: Promise<unknown>[] = [];
    const res = await handler({
      request: new Request(`https://bharatlas.com/api/v1/ground?lat=28.5&lng=77.1&${q}`),
      env: { ASSETS, R2: {}, POINT_PROFILES: 'on' }, params: {}, waitUntil: (p: Promise<unknown>) => waits.push(p),
    } as never);
    await Promise.all(waits);
    return res;
  };

  it('400 for an unknown section or a layer it does not read, naming the valid ones', async () => {
    const a = await call('sections=weather');
    expect(a.status).toBe(400);
    expect((await a.json() as { error: string }).error).toMatch(/Valid sections: seismic, geology/);
    const b = await call('layers=airports');
    expect(b.status).toBe(400);
    expect((await b.json() as { error: string }).error).toMatch(/Valid layers: .*seismic_zones/);
  });

  it('the same filter written differently is one cached answer; a different filter is another', async () => {
    runs.length = 0;
    expect((await call('sections=soil,seismic')).status).toBe(200);
    expect((await call('sections=seismic,soil,soil')).status).toBe(200);
    expect(runs).toEqual([{ sections: ['seismic', 'soil'] }]);
    await call('sections=soil');
    await call('');
    expect(runs).toEqual([{ sections: ['seismic', 'soil'] }, { sections: ['soil'] }, undefined]);
    const keys = [...cache.store.keys()].filter((k) => k.includes('/api/v1/ground'));
    expect(keys.some((k) => k.includes('sections=seismic%2Csoil'))).toBe(true);
  });
});

// ── the layer listings ───────────────────────────────────────────────────────

describe('the layer listings say realm and lookups', () => {
  const CATALOG = {
    categories: { boundaries: 'Boundaries', environment: 'Environment', 'city-wards': 'City wards' }, level_meta: {}, levels: {},
    layers: [
      { id: 'lgd_villages', level: 'village', category: 'boundaries', source: 'LGD', rows: 1, provenance: 'curated' },
      { id: 'seismic_zones', level: 'seismic_zone', category: 'environment', source: 'BIS', rows: 5, provenance: 'curated' },
      { id: 'ndem_cyclone_tracks', level: 'cyclone', category: 'environment', source: 'NDEM', rows: 5, provenance: 'curated' },
      { id: 'wards_chennai', level: 'wards_chennai', category: 'city-wards', source: 'GCC', rows: 200, provenance: 'curated' },
    ],
  };
  const assets = { fetch: async (u: string) => (new URL(u).pathname === '/catalog.json' ? new Response(JSON.stringify(CATALOG)) : new Response('', { status: 404 })) };
  beforeEach(() => { vi.stubGlobal('caches', memoryCache()); __resetCatalogForTest(); });
  afterEach(() => vi.unstubAllGlobals());
  const get = async (handler: typeof layersIndex, path: string, env: Record<string, unknown> = { POINT_PROFILES: 'on' }, p: Record<string, string> = {}) => {
    const waits: Promise<unknown>[] = [];
    const res = await handler({
      request: new Request(`https://bharatlas.com${path}`), env: { ASSETS: assets, ...env }, params: p, waitUntil: (x: Promise<unknown>) => waits.push(x),
    } as never);
    await Promise.all(waits);
    return { status: res.status, body: await res.json() as { data: Array<Record<string, unknown>> } & Record<string, unknown> };
  };

  it('every layer has its realm; lookup layers say lookups', async () => {
    const { body } = await get(layersIndex, '/api/v1/layers');
    const by = Object.fromEntries(body.data.map((l) => [l.id, l]));
    expect(by.lgd_villages).toMatchObject({ realm: 'ground' });
    expect(by.lgd_villages.lookups).toBeUndefined();
    expect(by.seismic_zones).toMatchObject({ realm: 'below', lookups: { ground: 'seismic', surface: 'hazards' } });
    expect(by.ndem_cyclone_tracks).toMatchObject({ realm: 'air', lookups: { surface: 'hazards' } });
    expect(by.wards_chennai).toMatchObject({ realm: 'ground', lookups: { surface: 'place' } });
  });

  it('realm= filters, and an unknown realm is a 400 naming the valid ones', async () => {
    const { body } = await get(layersIndex, '/api/v1/layers?realm=below');
    expect(body.data.map((l) => l.id)).toEqual(['seismic_zones']);
    const bad = await get(layersIndex, '/api/v1/layers?realm=sky');
    expect(bad.status).toBe(400);
    expect((bad.body as unknown as { error: string }).error).toMatch(/below, ground, air/);
  });

  it('while the lookups are unpublished, listings do not mention them', async () => {
    const { body } = await get(layersIndex, '/api/v1/layers', { POINT_PROFILES: 'off' });
    expect(body.data.find((l) => l.id === 'seismic_zones')).not.toHaveProperty('lookups');
  });

  it('the layer detail says realm and lookups too', async () => {
    const { body } = await get(layerDetail as typeof layersIndex, '/api/v1/layers/seismic_zones', { POINT_PROFILES: 'on' }, { id: 'seismic_zones' });
    expect(body.data).toMatchObject({ realm: 'below', lookups: { ground: 'seismic', surface: 'hazards' } });
  });
});

// The MCP package stands alone (npm), so its section enums are written out: held equal here.
describe('the MCP lookup tools name the lookups\' own sections', () => {
  it('ground_at and surface_at offer exactly the sections the profiles have; list_layers the realms', async () => {
    const { READ_TOOLS } = await import('../../mcp/read-tools.js');
    const enumOf = (tool: string) => (READ_TOOLS.find((t: { name: string }) => t.name === tool) as { inputSchema: { properties: { sections: { items: { enum: string[] } } } } }).inputSchema.properties.sections.items.enum;
    expect(enumOf('ground_at')).toEqual([...SECTIONS]);
    expect(enumOf('surface_at')).toEqual([...SURFACE_SECTIONS]);
    const { REALM_IDS } = await import('../../shared/realms.mjs');
    expect((READ_TOOLS.find((t: { name: string }) => t.name === 'list_layers') as { inputSchema: { properties: { realm: { enum: string[] } } } }).inputSchema.properties.realm.enum).toEqual(REALM_IDS);
  });
});
