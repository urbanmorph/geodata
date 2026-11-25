import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SURFACE_LAYERS, SURFACE_SECTIONS, SURFACE_PROFILE, surfaceAt, airPointer } from '../functions/lib/surface';
import type { CatalogData, CatalogLayer } from '../functions/lib/catalog-api';
import type { PixelResult, ProfileDeps } from '../functions/lib/profile';
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

  it('gives the partial-coverage layers a footprint and the all-India inventories a "none here" (plan A2)', () => {
    const row = (id: string) => SURFACE_LAYERS.find((l) => l.id === id)!;
    for (const id of ['bus_stops', 'urban_rail_stations', 'amrit_sarovar_ponds']) expect(row(id).coverageKm, id).toBeGreaterThan(row(id).radiusKm!);
    for (const id of ['ndem_floods_1998_2022', 'fsi_recorded_forest_area']) expect(row(id).allIndia, id).toBe(true);
    // CRZ maps and landslide zonation cover only some states: no polygon there is not "none"
    for (const id of ['crz2019_zones', 'ndem_landslide_hazard']) expect(row(id).allIndia, id).toBeUndefined();
    // ward layers come from the point's city (a ward layer that does not cover the point is not_covered)
    expect(SURFACE_PROFILE.expand!(12.9716, 77.5946, CATALOG).every((l) => l.match === 'contains' && !l.allIndia)).toBe(true);
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

  it('names each national ward layer by its own source: SBM, or WB AMRUT in West Bengal', () => {
    const scales = (lat: number, lng: number) => Object.fromEntries(SURFACE_PROFILE.expand!(lat, lng, CATALOG).map((l) => [l.id, l.about?.scale]));
    expect(scales(26.915, 70.908)).toEqual({ sbm_wards: 'national ward map (SBM)' });
    // Siliguri: inside West Bengal, no city ward layer there
    expect(scales(26.7271, 88.3953)).toEqual({ sbm_wards: 'national ward map (SBM)', wb_amrut_wards: 'West Bengal ward map (WB AMRUT)' });
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

describe('summary lines', () => {
  const say = (key: string, e: Record<string, unknown>) => SURFACE_LAYERS.find((l) => (l.key ?? l.id) === key)!.say!({ layer_id: 'x', credit: { name: 'c' }, ...e } as never);
  it('a basin whose sub-basin has its name says it once (Port Blair)', () => {
    const name = 'Drainage area of Andaman & Nicobar Islands';
    expect(say('wris_subbasin', { match: 'contains', status: 'found', features: [{ ba_name: name, sub_basin: name }] })).toBe(`River basin: ${name}`);
    expect(say('wris_subbasin', { match: 'contains', status: 'found', features: [{ ba_name: 'Ganga', sub_basin: 'Yamuna' }] })).toBe('River basin: Ganga, Yamuna');
    // a trailing "Basin" is not a different name (Jaisalmer)
    expect(say('wris_subbasin', { match: 'contains', status: 'found', features: [{ ba_name: 'Area of Inland drainage in Rajasthan Basin', sub_basin: 'Area of Inland drainage in Rajasthan' }] }))
      .toBe('River basin: Area of Inland drainage in Rajasthan Basin');
  });
  it('a protected area named only by its kind says where it is (Vapi)', () => {
    const near = (properties: Record<string, unknown>, d: number) => say('gs_wildlife_nearest', { match: 'nearest', status: 'found', nearest: [{ distance_km: d, lat: 0, lng: 0, properties }] });
    expect(near({ name: 'Wildlife Sanctuary', category: 'Sanctuary', state: 'Dadra & Nagar Haveli' }, 14.4))
      .toBe('Protected area 14.4 km away (Wildlife Sanctuary, Dadra & Nagar Haveli)');
    expect(near({ name: 'Gir', category: 'National Park', state: 'Gujarat' }, 3)).toBe('Protected area 3.0 km away (Gir)');
  });
  it('a recorded forest area says it is FSI\'s, and names it or its division (Dharavi)', () => {
    const inside = (p: Record<string, unknown>) => say('fsi_recorded_forest_area', { match: 'contains', status: 'found', features: [p] });
    expect(inside({ name: ' ', name_of_rf: ' ', division: 'DFO Mumbai Mangroves Conservation Unit' }))
      .toBe('Inside an FSI recorded forest area (DFO Mumbai Mangroves Conservation Unit)');
    expect(inside({ name: 'Nagla Block', division: 'Thane' })).toBe('Inside an FSI recorded forest area (Nagla Block)');
    expect(inside({})).toBe('Inside an FSI recorded forest area');
  });
});

describe('surfaceAt', () => {
  it('says the ward right after the sub-district, before the constituency', async () => {
    // Jaali, Karnataka: outside every city ward map, so the national SBM ward map answers.
    const at = (props: Record<string, Record<string, unknown>>): ProfileDeps => ({
      ...deps,
      locate: async (_lat, _lng, ids) => ({
        point: { lat: 0, lng: 0 }, zoom: 14, queried_layers: ids, timing_ms: 1,
        results: { x: ids.filter((id) => props[id]).map((id) => ({ layer_id: id, level: id, category: 'x', feature: { properties: props[id] } })) },
      }) as LocateResponse,
    });
    const s = await surfaceAt(13.993, 74.522, catalog, {} as R2Bucket, at({
      lgd_subdistricts: { sdtname: 'Bhatkal' }, sbm_wards: { wardcode: '8', wardname: 'Jali Dodmane' }, lgd_assembly: { ac_name: 'Bhatkal' },
    }));
    expect(s.summary).toMatch(/Sub-district: Bhatkal\. Ward 8, Jali Dodmane\. Assembly constituency Bhatkal/);
    expect(Object.keys(s.sections.place).indexOf('sbm_wards')).toBe(Object.keys(s.sections.place).indexOf('lgd_subdistricts') + 1);
  });

  it('two ward maps that say the same ward say it once (West Bengal: SBM and WB AMRUT)', async () => {
    const at = (props: Record<string, Record<string, unknown>>): ProfileDeps => ({
      ...deps,
      locate: async (_lat, _lng, ids) => ({
        point: { lat: 0, lng: 0 }, zoom: 14, queried_layers: ids, timing_ms: 1,
        results: { x: ids.filter((id) => props[id]).map((id) => ({ layer_id: id, level: id, category: 'x', feature: { properties: props[id] } })) },
      }) as LocateResponse,
    });
    const wbCatalog = { ...catalog, layers: [...catalog.layers, layer('wb_amrut_wards')] } as CatalogData;
    const s = await surfaceAt(22.75, 88.34, wbCatalog, {} as R2Bucket, at({
      sbm_wards: { wardcode: '6', wardname: 'WARD NO. 06' }, wb_amrut_wards: { Ward_No: 6, Name: 'Serampore' },
    }));
    expect(s.summary.match(/Ward 6/g)).toHaveLength(1);
  });

  it('with the sub-district filtered out, the ward still answers', async () => {
    const s = await surfaceAt(13.993, 74.522, catalog, {} as R2Bucket, deps, { filter: { layers: ['lgd_assembly', 'sbm_wards'] } });
    expect(Object.keys(s.sections.place)).toEqual(expect.arrayContaining(['sbm_wards']));
  });

  it('the nearest airport is one with an airport (IATA) code: helipads, closed fields and airstrips left out', async () => {
    let asked = 0;
    const s = await surfaceAt(26.912, 70.912, catalog, {} as R2Bucket, { ...deps, nearby: async (lat, lng, r, id, cat, r2, limit, cols) => {
      if (id !== 'airports') return deps.nearby(lat, lng, r, id, cat, r2, limit, cols);
      asked = limit ?? 0;
      return near([
        { p: { name: 'Jaisalmer Indira Helipad', type: 'heliport' }, d: 2.9 },
        { p: { name: 'Old Strip', type: 'closed' }, d: 5 },
        { p: { name: 'Flying Club Field', type: 'small_airport', iata_code: '' }, d: 8 }, // no airport code (Behala, Gauchar)
        { p: { name: 'Jaisalmer Airport', type: 'medium_airport', iata_code: 'JSA' }, d: 12.4 },
      ]);
    } });
    expect(asked).toBeGreaterThanOrEqual(100);
    expect(s.sections.access.airports).toMatchObject({ status: 'found', count: 1, nearest: [{ distance_km: 12.4, properties: { name: 'Jaisalmer Airport' } }] });
    expect(s.summary).toMatch(/Nearest airport 12.4 km away \(Jaisalmer Airport\)/);
    expect(s.summary).not.toMatch(/Helipad/);
  });

  it('with only helipads within the radius, no airport is near (not a gap)', async () => {
    const s = await surfaceAt(13.503, 75.093, catalog, {} as R2Bucket, { ...deps, nearby: async (lat, lng, r, id, cat, r2, limit, cols) =>
      (id === 'airports' ? near([{ p: { name: 'Koteshwara Heliport', type: 'heliport' }, d: 42.3 }]) : deps.nearby(lat, lng, r, id, cat, r2, limit, cols)) });
    expect(s.sections.access.airports).toMatchObject({ status: 'none_within_radius', count: 0, nearest: [] });
    expect(s.sections.access.airports.count_capped).toBeUndefined();
    expect(s.summary).not.toMatch(/airport|Heliport/i);
  });

  it('a point outside India says so first (Kathmandu); one just off the outline does not', async () => {
    const outline = (d: number): ProfileDeps => ({ ...deps,
      locate: async (_lat, _lng, ids) => ({ point: { lat: 0, lng: 0 }, zoom: 14, queried_layers: ids, timing_ms: 1, results: {} }) as LocateResponse,
      nearbyByGeometry: async (_lat, _lng, _r, id) => (id === 'india_boundary'
        ? { features: [{ properties: {}, lat: 27.3, lng: 84.6, distance_km: d }], total: 1, capped: false }
        : { features: [], total: 0, capped: false }) });
    const land = (d: number, cover: PixelResult): ProfileDeps => ({ ...outline(d), pixels: { ...deps.pixels, worldcover: async () => cover } });
    const s = await surfaceAt(27.7172, 85.324, catalog, {} as R2Bucket, land(80.97, { status: 'ok', data: { land_cover: 'Cropland', land_cover_code: 40 } }));
    expect(s.summary).toMatch(/^This point is outside India, 81\.0 km from its outline\./);
    // water in no state is not "outside India": the Gulf of Kutch, off Mumbai, Palk Bay are Indian waters
    for (const cover of [{ status: 'ok', data: { land_cover: 'Permanent water bodies', land_cover_code: 80 } }, { status: 'none', reason: 'no land cover at sea' }] as PixelResult[]) {
      const sea = await surfaceAt(22.6, 69.8, catalog, {} as R2Bucket, land(14.39, cover));
      expect(sea.summary).toMatch(/^At sea, 14\.4 km from India's coast or land border\./);
      expect(sea.summary).not.toMatch(/outside India/);
    }
    // said once, and no Indian services abroad (a mis-geocoded record put a Dhanbad hospital in Kathmandu)
    expect(s.summary).not.toMatch(/from India's outline \(coast or land border\)/);
    expect(s.summary).not.toMatch(/health facility|Near PHC/);
    const sea = await surfaceAt(15, 88, catalog, {} as R2Bucket, land(545, { status: 'none', reason: 'sea' }));
    expect(sea.summary.match(/545\.0 km/g)).toHaveLength(1);
    // inside India the outline line and the services stay
    const inIndia = await surfaceAt(22.57, 88.36, catalog, {} as R2Bucket, { ...land(3, { status: 'ok', data: { land_cover: 'Built-up', land_cover_code: 50 } }),
      locate: async (_lat, _lng, ids) => ({ point: { lat: 0, lng: 0 }, zoom: 14, queried_layers: ids, timing_ms: 1,
        results: { x: ids.filter((id) => id === 'lgd_states').map((id) => ({ layer_id: id, level: id, category: 'x', feature: { properties: { STNAME: 'WEST BENGAL' } } })) } }) as LocateResponse });
    expect(inIndia.summary).toMatch(/3\.0 km from India's outline/);
    expect(inIndia.summary).toMatch(/Nearest health facility 1\.2 km away/);
    // land cover unread (unavailable): nothing said either way
    expect((await surfaceAt(27.7, 85.3, catalog, {} as R2Bucket, outline(80))).summary).not.toMatch(/outside India|At sea/);
    const coast = await surfaceAt(7.01, 93.93, catalog, {} as R2Bucket, outline(0.4));
    expect(coast.summary).not.toMatch(/outside India/);
    const home = await surfaceAt(22.57, 88.36, catalog, {} as R2Bucket, { ...outline(80),
      locate: async (_lat, _lng, ids) => ({ point: { lat: 0, lng: 0 }, zoom: 14, queried_layers: ids, timing_ms: 1,
        results: { x: ids.filter((id) => id === 'lgd_states').map((id) => ({ layer_id: id, level: id, category: 'x', feature: { properties: { STNAME: 'WEST BENGAL' } } })) } }) as LocateResponse });
    expect(home.summary).not.toMatch(/outside India/); // inside a state: never outside
  });

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

  it('says the rasters in the table order, whichever answers first', async () => {
    // The 9-point comparison on the preview found land cover and elevation swapping places between calls.
    const later = (ms: number, r: PixelResult) => () => new Promise<PixelResult>((ok) => setTimeout(() => ok(r), ms));
    const s = await surfaceAt(22.57, 88.36, catalog, {} as R2Bucket, { ...deps, pixels: {
      worldcover: later(30, { status: 'ok', data: { land_cover: 'Built-up', land_cover_code: 50 } }),
      dem: later(10, { status: 'ok', data: { elevation_m: 9, slope_deg: 0.4, slope_pct: 0.7 } }),
      worldpop: later(0, { status: 'ok', data: { population_per_km2: 24000, people_in_pixel: 206 } }),
    } });
    expect(s.summary).toMatch(/Land cover: Built-up\. Elevation 9 m, slope 0.4 degrees\. About 24,000 people per km2/);
    expect(Object.keys(s.sections.land).slice(0, 3)).toEqual(['worldcover', 'dem', 'worldpop']);
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
    // mugilu's conditions_at takes one `place`: a name or "lat,lon" (it answered {lat, lng} with "place is required").
    expect(s.air.mcp).toEqual({ server: 'https://mugilu.live/mcp', tool: 'conditions_at', arguments: { place: '22.57,88.36' } });
  });

  it('carries the disclaimer and the place', async () => {
    const s = await surfaceAt(22.57, 88.36, catalog, {} as R2Bucket, deps);
    expect(s.disclaimer).toMatch(/not for legal, engineering/);
    expect(s.summary).toMatch(/District: Kolkata/);
    expect(s.summary).not.toMatch(/—/);
  });
});
