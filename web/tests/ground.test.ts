import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GROUND_LAYERS, SECTIONS, DECODERS, SEISMIC_ABOUT, groundAt,
} from '../functions/lib/ground';
import { dedupeFeatures, median, snapPoint, cleanText, partialByChance, LAYER_BUDGET_MS } from '../functions/lib/profile';
type GroundDeps = ProfileDeps & { soil: (r2: R2Bucket, lat: number, lng: number) => Promise<PixelResult> };
import type { CatalogData, CatalogLayer } from '../functions/lib/catalog-api';
import type { NearbyResult } from '../functions/lib/nearby';
import type { PixelResult, ProfileDeps } from '../functions/lib/profile';
import type { LocateResponse } from '../functions/lib/locate';

const CATALOG = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'catalog.json'), 'utf8')) as CatalogData;

describe('the ground layer table', () => {
  it('names each layer once, with a known section and match', () => {
    const ids = GROUND_LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of GROUND_LAYERS) {
      expect(['contains', 'nearest']).toContain(l.match);
      expect(SECTIONS).toContain(l.section);
      if (l.match === 'nearest') expect(l.radiusKm).toBeGreaterThan(0);
      if (l.coverageKm) expect(l.coverageKm).toBeGreaterThan(l.radiusKm!);
      if (l.decode) expect(l.decode).toBeTypeOf('function');
    }
  });

  it('names only layers the site has', () => {
    const known = new Set(CATALOG.layers.map((l) => l.id));
    expect(GROUND_LAYERS.map((l) => l.id).filter((id) => !known.has(id))).toEqual([]);
  });

  it('asks contains of polygon layers with tiles and nearest of layers with parquet', () => {
    const byId = new Map(CATALOG.layers.map((l) => [l.id, l]));
    for (const l of GROUND_LAYERS) {
      const c = byId.get(l.id)!;
      if (l.match === 'contains') expect(c.pmtiles, l.id).toBeTruthy();
      else expect(c.parquet, l.id).toBeTruthy();
    }
  });
});

describe('dedupeFeatures', () => {
  it('drops features whose properties are identical (gsi_lithology_50k answered 11 copies)', () => {
    const a = { lithologic: 'SILT', age: 'PLEISTOCENE' };
    expect(dedupeFeatures([a, { ...a }, { age: 'PLEISTOCENE', lithologic: 'SILT' }, { lithologic: 'SAND' }]))
      .toEqual([a, { lithologic: 'SAND' }]);
  });
});

describe('decoders', () => {
  // Plan B2: GLHYMPS is global and coarse (one polygon of GUM sediments holds Delhi, Majuli
  // and Kolkata alike, logK_Ferr_ -1052, Porosity_x 0 as published), so ground_at gives
  // only a permeability class (Bear 1972) from log10 k = logK_Ferr_ / 100, not site numbers.
  it('GLHYMPS: a permeability class from log10 permeability x 100, and no site numbers', () => {
    expect(DECODERS.glhymps({ logK_Ferr_: -1052, Porosity_x: 0 })).toEqual({ log10_permeability_m2: -10.52, permeability_class: 'pervious' });
    expect(DECODERS.glhymps({ logK_Ferr_: -1100 }).permeability_class).toBe('pervious');
    expect(DECODERS.glhymps({ logK_Ferr_: -1250, Porosity_x: 9 })).toEqual({ log10_permeability_m2: -12.5, permeability_class: 'semi-pervious' });
    expect(DECODERS.glhymps({ logK_Ferr_: -1650, Porosity_x: 1 }).permeability_class).toBe('impervious');
  });

  it('GLHYMPS: permeability 0 is no value (GUM_K 0)', () => {
    expect(DECODERS.glhymps({ logK_Ferr_: 0, Porosity_x: 0 })).toEqual({ log10_permeability_m2: null, permeability_class: null });
  });

  it('monsoon depths: the latest pre- and post-monsoon readings, in metres below ground', () => {
    const d = DECODERS.monsoon_depths({
      'Pre-monsoon_2021 (meters below ground level)': 12.5,
      'Pre-monsoon_2022 (meters below ground level)': '14.1',
      'Post-monsoon_2021 (meters below ground level)': 8,
      'Post-monsoon_2022 (meters below ground level)': null,
      'Post-monsoon_2020 (meters below ground level)': 7,
    });
    expect(d).toEqual({
      latest_pre_monsoon: { year: 2022, depth_m_below_ground: 14.1 },
      latest_post_monsoon: { year: 2021, depth_m_below_ground: 8 },
    });
    expect(DECODERS.monsoon_depths({ a: 1 })).toEqual({ latest_pre_monsoon: null, latest_post_monsoon: null });
  });
});

describe('median', () => {
  it('of odd and even counts, skipping non-numbers', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([null, 'x', 5])).toBe(5);
    expect(median([])).toBeNull();
  });
});

// ── the runner, with fake engines ────────────────────────────────────────────

function layer(id: string, extra: Partial<CatalogLayer> = {}): CatalogLayer {
  return {
    id, level: id, source: 'S', rows: 1, category: 'environment', provenance: 'p',
    licence: 'CC0-1.0', attribution: { primary: { name: `Pub ${id}`, url: `https://pub/${id}` } },
    pmtiles: { url: `https://r2/${id}.pmtiles`, bytes: 1 }, parquet: { url: `https://r2/${id}.parquet`, bytes: 1 },
    ...extra,
  };
}

const IDS = GROUND_LAYERS.map((l) => l.id);
const catalog = {
  layers: IDS.map((id) => layer(id, id === 'bhuvan_geomorphology_50k' ? { licence: 'NRSC terms', non_commercial: true } : {})),
  categories: {}, levels: {}, level_meta: {}, level_order: [],
} as unknown as CatalogData;

function nearbyResult(features: Array<{ props: Record<string, unknown>; d: number }>, total = features.length): NearbyResult {
  return {
    center: { lat: 0, lng: 0 }, radius_km: 1, total, timing_ms: 1, _source: 'parquet-bbox', rows_scanned: 1,
    features: features.map((f) => ({ properties: f.props, _lat: 28.5, _lng: 77.1, _distance_km: f.d })),
  };
}

function deps(over: Partial<GroundDeps> = {}): GroundDeps {
  return {
    locate: async (_lat, _lng, ids) => ({
      point: { lat: 0, lng: 0 }, zoom: 14, queried_layers: ids, timing_ms: 1,
      results: {
        environment: ids.flatMap((id) => id === 'seismic_zones'
          ? [{ layer_id: id, level: id, category: 'environment', feature: { properties: { seismic_zo: 'Seismic Zone-IV', intensity_: 'Severe Intensity Zone' } } }]
          : id === 'gsi_lithology_50k'
            ? Array.from({ length: 11 }, () => ({ layer_id: id, level: id, category: 'environment', feature: { properties: { lithologic: 'SILT-CLAY', age: 'PLEISTOCENE' } } }))
            : id === 'glhymps_permeability'
              ? [{ layer_id: id, level: id, category: 'environment', feature: { properties: { logK_Ferr_: -1052, Porosity_x: 0 } } }]
              : []),
      },
    }) as LocateResponse,
    nearby: async (_lat, _lng, _r, id) => {
      if (id === 'subsidence_megacities') {
        // the last two readings share a coordinate, as some Delhi and Kolkata points do
        return nearbyResult([1, 2, 3, 4, 5].map((i) => ({
          props: { VLM_cm_per_yr: -i, city: 'Delhi', Longitude: 77 + Math.min(i, 4) / 1000, Latitude: 28.5 }, d: i / 10,
        })));
      }
      if (id === 'ngdr_earthquakes') return nearbyResult([{ props: { mw: '4.10000000', yr: '1998.00000000' }, d: 12.3 }], 7);
      // atal_bhujal_wells: a well 30 km off, so the point is covered but none is within 10 km
      if (id === 'atal_bhujal_wells' && _r > 10) return nearbyResult([{ props: {}, d: 30 }]);
      return nearbyResult([]);
    },
    nearbyFromTiles: (...a) => deps().nearbyByGeometry(...a),
    nearbyByGeometry: async (_lat, _lng, _r, id) => (id === 'gem_active_faults'
      ? { features: [{ properties: { name: 'Main Boundary Thrust' }, lat: 28.5, lng: 77.0, distance_km: 0.98 }], total: 1, capped: false }
      : { features: [], total: 0, capped: false }),
    soil: async () => ({ status: 'ok', data: { depths: { '0-5cm': { clay_pct: 24.7, ph_water: 7.8 } }, wrb_class: 'Cambisols' } }),
    pixels: {},
    ...over,
  };
}

/** The fake engines as the runner takes them: the soil answer as the soilgrids pixel source. */
function run(lat: number, lng: number, cat: typeof catalog, over: Partial<GroundDeps> = {}, opts = {}) {
  const d = deps(over);
  return groundAt(lat, lng, cat, {} as R2Bucket, { ...d, pixels: { soilgrids: d.soil as () => Promise<PixelResult> } }, opts);
}

describe('snapPoint', () => {
  it('snaps to 3 decimal places (about 100 m), the edge-cache key', () => {
    expect(snapPoint(28.52549, 77.08451)).toEqual({ lat: 28.525, lng: 77.085 });
    expect(snapPoint(12.97164, 77.59456)).toEqual({ lat: 12.972, lng: 77.595 });
  });
});

describe('groundAt', () => {
  it('groups every layer by section with its credit and licence', async () => {
    const g = await run(28.525, 77.085, catalog);
    expect(g.point).toEqual({ lat: 28.525, lng: 77.085 });
    const sz = g.sections.seismic.seismic_zones;
    expect(sz).toMatchObject({ layer_id: 'seismic_zones', match: 'contains', features: [{ seismic_zo: 'Seismic Zone-IV' }] });
    expect(sz.credit).toEqual({ name: 'Pub seismic_zones', url: 'https://pub/seismic_zones', licence: 'CC0-1.0', licence_url: 'https://creativecommons.org/publicdomain/zero/1.0/' });
    expect(g.unavailable).toEqual([]);
  });

  it('dedupes identical containing features', async () => {
    const g = await run(28.525, 77.085, catalog);
    expect(g.sections.geology.gsi_lithology_50k.features).toHaveLength(1);
  });

  it('flags a non-commercial layer the way other endpoints do', async () => {
    const g = await run(28.525, 77.085, catalog);
    expect(g.sections.geology.bhuvan_geomorphology_50k).toMatchObject({ non_commercial: true, licence_notice: expect.stringMatching(/Non-commercial/) });
    expect(g.sections.seismic.seismic_zones.non_commercial).toBeUndefined();
  });

  it('gives GLHYMPS as a permeability class, labelled global and coarse, and says it in the summary', async () => {
    const g = await run(28.525, 77.085, catalog);
    const e = g.sections.groundwater.glhymps_permeability;
    expect(e.decoded).toEqual({ log10_permeability_m2: -10.52, permeability_class: 'pervious' });
    expect(e.about?.scale).toMatch(/^global, coarse/);
    expect(Object.keys(e.units ?? {})).toEqual(['log10_permeability_m2', 'permeability_class']);
    expect(g.summary).toContain('Permeability class (GLHYMPS, global and coarse): pervious');
  });

  it('gives nearest features with distance and a count, and a median where the table asks', async () => {
    const g = await run(28.525, 77.085, catalog);
    const eq = g.sections.seismic.ngdr_earthquakes;
    expect(eq).toMatchObject({ match: 'nearest', radius_km: 50, count: 7 });
    expect(eq.nearest![0]).toMatchObject({ distance_km: 12.3, properties: { mw: '4.10000000' } });
    const sub = g.sections.subsidence.subsidence_megacities;
    expect(sub.count).toBe(5);
    // per-coordinate medians -1, -2, -3, -4.5: their median is -2.5, over 4 points and 5 readings
    expect(sub.stats).toEqual({ median_VLM_cm_per_yr: -2.5, points: 4, readings: 5 });
    expect(sub.nearest![0].properties).toEqual({ VLM_cm_per_yr: -1, city: 'Delhi' });
    expect(sub.status).toBe('found');
    expect(sub.nearest).toHaveLength(3);
  });

  it('asks line layers for the true distance to the line', async () => {
    const asked: string[] = [];
    const d = deps();
    const g = await groundAt(28.5, 77.01, catalog, {} as R2Bucket, { ...d, pixels: { soilgrids: d.soil }, nearbyFromTiles: async (...a) => { asked.push(a[3]); return d.nearbyByGeometry(...a); } });
    expect(asked.sort()).toEqual(['bhuvan_lineaments_50k', 'gem_active_faults', 'gsi_coal_blocks', 'gsi_hydrocarbon_blocks',
      'gsi_lineaments_250k', 'osm_tunnels', 'osm_underground_utilities']);
    const f = g.sections.seismic.gem_active_faults;
    expect(f).toMatchObject({ distance_to: 'shape', count: 1, status: 'found', nearest: [{ distance_km: 0.98, properties: { name: 'Main Boundary Thrust' } }] });
    expect(g.sections.seismic.ngdr_earthquakes.distance_to).toBe('point');
  });

  it('decodes only the columns an entry shows (Soil Health Cards: 15 of 50), all of them for a decoder', async () => {
    // Decoding every column of a 122,880-row group cost ~800 ms of CPU per call.
    const asked: Record<string, string[] | undefined> = {};
    await run(28.525, 77.085, catalog, {
      nearby: async (lat, lng, r, id, cat, r2, limit, columns) => {
        if (r <= 10 || !(id in asked)) asked[id] = columns;
        return deps().nearby(lat, lng, r, id, cat, r2, limit, columns);
      },
    });
    const slusi = GROUND_LAYERS.find((l) => l.id === 'slusi_soil_health')!;
    expect(asked.slusi_soil_health).toEqual(slusi.fields);
    expect(asked.subsidence_megacities).toEqual(['VLM_cm_per_yr', 'city', 'Longitude', 'Latitude']); // the median's too
    expect(asked.atal_bhujal_wells).toBeUndefined(); // its decoder reads columns it does not show
  });

  it('the wider "is it covered" search decodes no properties', async () => {
    const wide: Array<string[] | undefined> = [];
    await run(28.525, 77.085, catalog, {
      nearby: async (lat, lng, r, id, cat, r2, limit, columns) => {
        if (id === 'slusi_soil_health' && r === 25) wide.push(columns);
        return deps().nearby(lat, lng, r, id, cat, r2, limit, columns);
      },
    });
    expect(wide).toEqual([[]]);
  });

  it('tells "not covered" from "none within the radius"', async () => {
    const g = await run(28.525, 77.085, catalog);
    // atal_bhujal_wells has a well 30 km off: covered, none within 10 km
    expect(g.sections.groundwater.atal_bhujal_wells).toMatchObject({ status: 'none_within_radius', count: 0 });
    // slusi_soil_health has nothing within 25 km: not covered
    expect(g.sections.soil.slusi_soil_health.status).toBe('not_covered');
    // a national layer with nothing near is "none within the radius"
    expect(g.sections.underground.osm_mines_caves.status).toBe('none_within_radius');
    // a contains layer with no polygon here does not reach the point
    expect(g.sections.watershed.core_mws_water_balance).toMatchObject({ status: 'not_covered', features: [] });
    expect(g.sections.seismic.seismic_zones.status).toBe('found');
    // an all-India inventory (NDEM's 1998-2022 flood map) with no polygon here: none here, not a gap
    expect(g.sections.watershed.ndem_floods_1998_2022).toMatchObject({ status: 'none_within_radius', radius_km: 0, features: [] });
  });

  it('says no extraction percentage where CGWB did not assess the unit (-9999 as published)', () => {
    const say = GROUND_LAYERS.find((l) => l.id === 'cgwb_gw_extraction')!.say!;
    const entry = (p: Record<string, unknown>) => ({ layer_id: 'x', match: 'contains', status: 'found', credit: { name: 'c' }, features: [p] }) as never;
    expect(say(entry({ class: 'Not Assessed', sgw_dev_pe: -9999, block: 'Kolkata' }))).toBe('Groundwater extraction: Not Assessed');
    expect(say(entry({ class: 'Safe', sgw_dev_pe: 41.6, block: 'Latur' }))).toBe('Groundwater extraction: Safe (42% of the annual extractable resource, Latur block)');
  });

  it('says no percentage for a unit not assessed, even where the file has 0 (Joshimath, Jharia)', () => {
    const say = GROUND_LAYERS.find((l) => l.id === 'cgwb_gw_extraction')!.say!;
    const entry = (p: Record<string, unknown>) => ({ layer_id: 'x', match: 'contains', status: 'found', credit: { name: 'c' }, features: [p] }) as never;
    expect(say(entry({ class: 'Not Assessed', sgw_dev_pe: 0, block: 'Joshimath' }))).toBe('Groundwater extraction: Not Assessed');
  });

  it('outside the five cities, says subsidence is not measured there (Joshimath, Jharia)', () => {
    const say = GROUND_LAYERS.find((l) => l.id === 'subsidence_megacities')!.say!;
    const entry = (status: string) => ({ layer_id: 'x', match: 'nearest', status, credit: { name: 'c' }, count: 0, nearest: [], stats: { median_VLM_cm_per_yr: null, points: 0, readings: 0 } }) as never;
    expect(say(entry('not_covered'))).toBe('Subsidence: not measured here (the satellite data covers Bengaluru, Chennai, Delhi, Kolkata and Mumbai only)');
    expect(say(entry('none_within_radius'))).toBeNull(); // inside a city, no point within 500 m: nothing to say
  });

  it('a groundwater sample with no year (0 in the file) is said without one (Jaisalmer)', () => {
    const say = GROUND_LAYERS.find((l) => l.id === 'gw_quality_postmonsoon')!.say!;
    const entry = (year: unknown) => ({ layer_id: 'x', match: 'nearest', status: 'found', credit: { name: 'c' },
      nearest: [{ distance_km: 3, lat: 0, lng: 0, properties: { GWQ: 'Potable', YEAR: year } }] }) as never;
    expect(say(entry('0'))).toBe('Post-monsoon groundwater sample 3.0 km away: Potable');
    expect(say(entry(null))).toBe('Post-monsoon groundwater sample 3.0 km away: Potable');
    expect(say(entry('2015'))).toBe('Post-monsoon groundwater sample 3.0 km away: Potable (2015)');
    expect(say(entry('2011-2012'))).toBe('Post-monsoon groundwater sample 3.0 km away: Potable (2011-2012)');
  });

  it('gives every partial-coverage layer of plan A2 a footprint (A2: not_covered vs none_within_radius)', () => {
    const row = (id: string) => GROUND_LAYERS.find((l) => l.id === id)!;
    for (const id of ['subsidence_megacities', 'atal_bhujal_wells', 'slusi_soil_health']) expect(row(id).coverageKm, id).toBeGreaterThan(row(id).radiusKm!);
    // contains layers that reach only part of India answer not_covered off their polygons; all-India ones say none
    for (const id of ['core_mws_water_balance', 'core_mws_drought']) expect(row(id).allIndia, id).toBeUndefined();
    expect(row('ndem_floods_1998_2022').allIndia).toBe(true);
  });

  it('adds SoilGrids with the ISRIC credit', async () => {
    const g = await run(28.525, 77.085, catalog);
    expect(g.sections.soil.soilgrids).toMatchObject({
      match: 'pixel', wrb_class: 'Cambisols', depths: { '0-5cm': { clay_pct: 24.7 } },
      credit: { name: 'ISRIC SoilGrids 2.0 (Poggio et al. 2021)', licence: 'CC-BY-4.0' },
    });
    expect(g.attribution).toContain('ISRIC SoilGrids 2.0 (Poggio et al. 2021) (CC-BY-4.0)');
  });

  it('a layer that fails or runs past its budget is listed as unavailable; the rest still answer', async () => {
    const g = await run(28.525, 77.085, catalog, ({
      nearby: async (lat, lng, r, id, ...rest) => {
        if (id === 'slusi_soil_health') return new Promise(() => {}); // never answers
        return deps().nearby(lat, lng, r, id, ...rest);
      },
      nearbyFromTiles: async (...a) => {
        if (a[3] === 'osm_tunnels') throw new Error('R2 down');
        return deps().nearbyByGeometry(...a);
      },
    }), { budgetMs: 50 });
    expect(g.unavailable).toEqual(expect.arrayContaining([
      { layer_id: 'osm_tunnels', reason: 'could not be read' },
      { layer_id: 'slusi_soil_health', reason: 'took longer than 50 ms' },
    ]));
    expect(g.sections.underground.osm_tunnels).toBeUndefined();
    expect(partialByChance(g)).toBe(true); // missed by chance: not cached
    expect(g.sections.seismic.seismic_zones.features).toHaveLength(1);
  });

  it('by default a layer gets 2.5 s, so one slow layer cannot hold an answer past the 3 s target', () => {
    // A cold read (a fresh isolate and colo) can take seconds; the answer names that layer
    // instead, is not cached, and the layer's reads still fill the colo's cache for the next ask.
    expect(LAYER_BUDGET_MS).toBe(2500);
  });

  it('keeps the request open (waitUntil) for a layer past its budget, so its reads settle in this request', async () => {
    const held: Promise<unknown>[] = [];
    await run(28.525, 77.085, catalog, ({
      nearby: async (lat, lng, r, id, ...rest) => (id === 'ngdr_earthquakes'
        ? new Promise((res) => setTimeout(() => res(deps().nearby(lat, lng, r, id, ...rest)), 80))
        : deps().nearby(lat, lng, r, id, ...rest)),
    }), { budgetMs: 20, waitUntil: (p) => held.push(p) });
    expect(held).toHaveLength(1);
    await Promise.all(held);
  });

  it('lists credits in the table order, however the layers finish', async () => {
    const late = (ms: number) => <T>(v: Promise<T>) => new Promise<T>((res) => setTimeout(() => res(v), ms));
    const fast = await run(28.525, 77.085, catalog, ({ soil: () => late(30)(deps().soil()) }));
    const slow = await run(28.525, 77.085, catalog, ({
      nearby: (...a: Parameters<GroundDeps['nearby']>) => late(30)(deps().nearby(...a)),
    }));
    expect(fast.attribution.length).toBeGreaterThan(2);
    expect(slow.attribution).toEqual(fast.attribution);
  });

  it('collapses line breaks a source put inside a text field', async () => {
    const g = await run(28.525, 77.085, catalog, ({
      locate: async (_lat, _lng, ids) => ({
        point: { lat: 0, lng: 0 }, zoom: 14, queried_layers: ids, timing_ms: 1,
        results: { water: ids.filter((id) => id === 'cgwb_aquifers').map((id) => ({ layer_id: id, level: id, category: 'water', feature: { properties: { aquifer0: 'Basalt', aquifers: 'Unconfined\nSemi-confined\nto Confined' } } })) },
      }),
    }));
    expect(g.summary).toContain('Aquifer: Basalt, Unconfined Semi-confined to Confined');
  });

  it('says each section\'s scale, vintage and fetch date, and the screening disclaimer once', async () => {
    const withDates = { ...catalog, layers: catalog.layers.map((l) => ({ ...l, fetched_at: '2026-05-25T17:02:55+00:00' })) };
    const g = await run(28.525, 77.085, withDates);
    expect(g.sections.seismic.seismic_zones.about).toEqual({ ...SEISMIC_ABOUT, vintage: 'BIS IS 1893 (Part 1):2016', fetched_at: '2026-05-25' });
    expect(g.sections.soil.soilgrids.about?.scale).toMatch(/250 m/);
    expect(g.disclaimer).toMatch(/not for engineering/);
  });

  it('open_only leaves out non-commercial layers and says which', async () => {
    const g = await run(28.525, 77.085, catalog, {}, { openOnly: true });
    expect(g.sections.geology.bhuvan_geomorphology_50k).toBeUndefined();
    expect(g.omitted_non_commercial).toEqual(['bhuvan_geomorphology_50k']);
    expect(JSON.stringify(g.sections)).not.toContain('"non_commercial":true');
    expect((await run(28.525, 77.085, catalog)).omitted_non_commercial).toBeUndefined();
  });

  it('SoilGrids without a published file is unavailable, not "not covered"', async () => {
    const g = await run(28.525, 77.085, catalog, ({ soil: async () => ({ status: 'unavailable', reason: 'the SoilGrids file is not published yet' }) }));
    expect(g.sections.soil.soilgrids).toBeUndefined();
    expect(g.unavailable).toContainEqual({ layer_id: 'soilgrids', reason: 'the SoilGrids file is not published yet' });
    expect(partialByChance(g)).toBe(false); // a lasting gap: the answer may be cached
  });

  it('a layer the site does not have yet is unavailable, not an error', async () => {
    const small = { ...catalog, layers: catalog.layers.filter((l) => l.id !== 'osm_mines_caves') };
    const g = await run(28.525, 77.085, small);
    expect(g.unavailable).toContainEqual({ layer_id: 'osm_mines_caves', reason: 'not published' });
  });

  it('soil with no prediction is null with its reason', async () => {
    const g = await run(20, 70, catalog, ({ soil: async () => ({ status: 'none', reason: 'no SoilGrids prediction here' }) }));
    expect(g.sections.soil.soilgrids).toMatchObject({ status: 'not_covered', depths: null, wrb_class: null, reason: 'no SoilGrids prediction here' });
  });

  it('says it in one readable line', async () => {
    const g = await run(28.525, 77.085, catalog);
    expect(g.summary).toMatch(/Seismic Zone-IV/);
    expect(g.summary).toMatch(/SILT-CLAY/);
    expect(g.summary).toMatch(/Cambisols/);
    expect(g.summary).toMatch(/24.7% clay/);
    expect(g.summary).toMatch(/sinking about 2.5 cm\/yr \(median of 4 satellite points within 500 m\)/);
    expect(g.summary).toMatch(/12.3 km away \(M 4.1, 1998\)/);
    expect(g.summary).not.toMatch(/—/);
  });
});

describe('WRIS groundwater levels', () => {
  it('gives the nearest stations with their depths and trend, and links the readings', async () => {
    const url = 'https://pub-x.r2.dev/water/wris-groundwater-levels/WRIS_Groundwater_Manual_Readings.ab41da73.parquet';
    const cat = { ...catalog, layers: catalog.layers.map((l) => (l.id === 'wris_groundwater_levels' ? { ...l, notes: `The readings are a separate Parquet download: ${url}` } : l)) };
    const d = deps();
    const g = await run(28.525, 77.085, cat, {
      nearby: async (lat, lng, r, id, ...rest) => (id === 'wris_groundwater_levels'
        ? nearbyResult([{ props: { station_name: 'Kapashera', premonsoon_depth_m: 31.2, premonsoon_year: 2024, premonsoon_trend_m_per_yr: 0.85, last_depth_m: 30.1, objectid: 1 }, d: 1.4 }])
        : d.nearby(lat, lng, r, id, ...rest)),
    });
    const e = g.sections.groundwater.wris_groundwater_levels;
    expect(e).toMatchObject({ status: 'found', links: { readings: url }, nearest: [{ distance_km: 1.4, properties: { station_name: 'Kapashera', premonsoon_depth_m: 31.2 } }] });
    expect(e.nearest![0].properties).not.toHaveProperty('objectid');
    expect(g.summary).toMatch(/Water table 31.2 m below ground before the 2024 monsoon at a WRIS station 1.4 km away, falling 0.85 m\/yr/);
  });
});

describe('cleanText (summary only; the data stays as published)', () => {
  it('collapses line breaks, drops "-" and NA, decodes entities, says a same-ended range once', () => {
    expect(cleanText('Unconfined\nSemi-confined')).toBe('Unconfined Semi-confined');
    expect(cleanText('-')).toBeNull();
    expect(cleanText('NA')).toBeNull();
    expect(cleanText('Jammu &amp; Kashmir')).toBe('Jammu & Kashmir');
    expect(cleanText('05 °C To 05 °C')).toBe('5 °C');
    expect(cleanText('10 °C To 20 °C')).toBe('10 °C To 20 °C');
    expect(cleanText('4.77000000')).toBe('4.77');
  });
});
