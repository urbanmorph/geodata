import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SURFACE_LAYERS, SURFACE_SECTIONS, SURFACE_PROFILE, surfaceAt, airPointer } from '../functions/lib/surface';
import type { CatalogData, CatalogLayer } from '../functions/lib/catalog-api';
import type { ProfileDeps } from '../functions/lib/profile';
import type { LocateResponse } from '../functions/lib/locate';
import type { NearbyResult } from '../functions/lib/nearby';

const CATALOG = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'catalog.json'), 'utf8')) as CatalogData;

describe('the surface layer table', () => {
  it('names each entry once, in a known section, with a known match', () => {
    const keys = SURFACE_LAYERS.map((l) => l.key ?? l.id);
    expect(new Set(keys).size).toBe(keys.length);
    for (const l of SURFACE_LAYERS) {
      expect(SURFACE_SECTIONS).toContain(l.section);
      if (l.match === 'nearest') expect(l.radiusKm).toBeGreaterThan(0);
      if (l.coverageKm) expect(l.coverageKm).toBeGreaterThan(l.radiusKm!);
    }
  });

  it('names only layers the site has, contains on tiles and nearest on parquet', () => {
    const byId = new Map(CATALOG.layers.map((l) => [l.id, l]));
    for (const l of SURFACE_LAYERS) {
      const c = byId.get(l.id);
      expect(c, l.id).toBeTruthy();
      if (l.match === 'contains') expect(c!.pmtiles, l.id).toBeTruthy();
      else expect(c!.parquet, l.id).toBeTruthy();
    }
  });

  it('measures lines and polygons by true distance', () => {
    const shaped = SURFACE_LAYERS.filter((l) => l.shape).map((l) => l.id);
    for (const id of ['wris_rivers', 'wris_waterbodies', 'gs_highways', 'gs_wildlife', 'vedas_transmission_lines', 'india_boundary']) {
      expect(shaped).toContain(id);
    }
    expect(SURFACE_LAYERS.find((l) => l.id === 'india_boundary')!.edge).toBe(true);
  });

  it('leaves "non-wetland area" outlines out of the nearest wetland', () => {
    const keep = SURFACE_LAYERS.find((l) => l.id === 'bp_wetlands')!.keep!;
    expect(keep({ descr: 'Others (non-wetland area)' })).toBe(false);
    expect(keep({ descr: 'Lake/Pond' })).toBe(true);
  });

  it('adds the city ward layer covering the point, or the national one', () => {
    const ids = (lat: number, lng: number) => SURFACE_PROFILE.expand!(lat, lng, CATALOG).map((l) => l.id);
    expect(ids(12.9716, 77.5946).some((id) => id.startsWith('wards_bengaluru'))).toBe(true);
    expect(ids(26.915, 70.908)).toEqual(['sbm_wards']);
  });
});

// ── the runner, with fake engines ────────────────────────────────────────────

const layer = (id: string): CatalogLayer => ({
  id, level: id, source: 'S', rows: 1, category: 'x', provenance: 'p', licence: 'CC0-1.0',
  attribution: { primary: { name: `Pub ${id}`, url: `https://pub/${id}` } },
  pmtiles: { url: `https://r2/${id}.pmtiles`, bytes: 1 }, parquet: { url: `https://r2/${id}.parquet`, bytes: 1 },
});
const catalog = { layers: [...new Set([...SURFACE_LAYERS.map((l) => l.id), 'sbm_wards'])].map(layer), categories: {}, levels: {}, level_meta: {}, level_order: [] } as unknown as CatalogData;
const near = (features: Array<{ p: Record<string, unknown>; d: number }>, total = features.length): NearbyResult => ({
  center: { lat: 0, lng: 0 }, radius_km: 1, total, timing_ms: 1, _source: 'parquet-bbox', rows_scanned: 1,
  features: features.map((f) => ({ properties: f.p, _lat: 1, _lng: 2, _distance_km: f.d })),
});

const deps: ProfileDeps = {
  locate: async (_lat, _lng, ids) => ({
    point: { lat: 0, lng: 0 }, zoom: 14, queried_layers: ids, timing_ms: 1,
    results: { x: ids.flatMap((id) => (id === 'lgd_districts' ? [{ layer_id: id, level: id, category: 'x', feature: { properties: { dtname: 'Kolkata' } } }] : [])) },
  }) as LocateResponse,
  nearby: async (_lat, _lng, _r, id) => {
    if (id === 'nhp_hospitals') return near([{ p: { Hospital_Name: 'Far Hospital' }, d: 9 }]);
    if (id === 'nin_health_facilities') return near([{ p: { health_facility_name: 'Near PHC' }, d: 1.2 }]);
    if (id === 'overture_places_india') return near([], 1234);
    return near([]);
  },
  nearbyFromTiles: async (...a) => deps.nearbyByGeometry(...a),
  nearbyByGeometry: async (_lat, _lng, _r, id) => (id === 'wris_rivers'
    ? { features: [{ properties: { rivname: 'Hooghly' }, lat: 22.57, lng: 88.34, distance_km: 1.5 }], total: 1, capped: false }
    : { features: [], total: 0, capped: false }),
  pixels: {
    dem: async () => ({ status: 'ok', data: { elevation_m: 9, slope_deg: 0.4, slope_pct: 0.7 } }),
    worldpop: async () => ({ status: 'ok', data: { population_per_km2: 24000, people_in_pixel: 206 } }),
    worldcover: async () => ({ status: 'unavailable', reason: 'the land cover file is not published yet' }),
  },
};

describe('surfaceAt', () => {
  it('finds the river by true distance and says it', async () => {
    const s = await surfaceAt(22.57, 88.36, catalog, {} as R2Bucket, deps);
    expect(s.sections.water.wris_rivers).toMatchObject({ status: 'found', distance_to: 'shape', nearest: [{ distance_km: 1.5 }] });
    expect(s.summary).toMatch(/Nearest river 1.5 km away \(Hooghly\)/);
  });

  it('reads the rasters into values with their credits, and lists an unpublished one as unavailable', async () => {
    const s = await surfaceAt(22.57, 88.36, catalog, {} as R2Bucket, deps);
    expect(s.sections.land.dem).toMatchObject({ match: 'pixel', status: 'found', values: { elevation_m: 9 } });
    expect(s.sections.land.dem.credit.notice).toMatch(/WorldDEM-90/);
    expect(s.sections.land.worldpop.credit.licence).toBe('CC-BY-4.0');
    expect(s.unavailable).toContainEqual({ layer_id: 'worldcover', reason: 'the land cover file is not published yet' });
    expect(s.summary).toMatch(/Elevation 9 m, slope 0.4 degrees/);
    expect(s.summary).toMatch(/24,000 people per km2/);
  });

  it('names the nearest health facility across the three sources', async () => {
    const s = await surfaceAt(22.57, 88.36, catalog, {} as R2Bucket, deps);
    expect(s.summary).toMatch(/Nearest health facility 1.2 km away \(Near PHC, nin_health_facilities\)/);
  });

  it('counts places within 1 km', async () => {
    const s = await surfaceAt(22.57, 88.36, catalog, {} as R2Bucket, deps);
    expect(s.sections.services.overture_places_india).toMatchObject({ count: 1234, nearest: [] });
    expect(s.summary).toMatch(/1,234 mapped places within 1 km/);
  });

  it('points to mugilu for the air above, with the same point', async () => {
    const s = await surfaceAt(22.57, 88.36, catalog, {} as R2Bucket, deps);
    expect(s.air).toEqual(airPointer(22.57, 88.36));
    expect(s.air.mcp).toEqual({ server: 'https://mugilu.live/mcp', tool: 'conditions_at', arguments: { lat: 22.57, lng: 88.36 } });
  });

  it('carries the disclaimer and the place', async () => {
    const s = await surfaceAt(22.57, 88.36, catalog, {} as R2Bucket, deps);
    expect(s.disclaimer).toMatch(/not for legal, engineering/);
    expect(s.summary).toMatch(/District: Kolkata/);
    expect(s.summary).not.toMatch(/—/);
  });
});
