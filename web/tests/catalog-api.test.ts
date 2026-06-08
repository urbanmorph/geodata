import { describe, it, expect } from 'vitest';
import {
  filterLayers,
  paginateResults,
  toApiLayer,
  toApiCategory,
  toApiLevel,
  type CatalogData,
} from '../functions/lib/catalog-api';

const SAMPLE_CATALOG: CatalogData = {
  layers: [
    {
      id: 'lgd_states', level: 'state', source: 'LGD', rows: 36,
      parquet: { url: 'https://r2.dev/states.parquet', bytes: 7000000 },
      pmtiles: { url: 'https://r2.dev/states.pmtiles', bytes: 3000000 },
      geojson: { url: 'https://r2.dev/states.geojson', bytes: 27000000 },
      kml: { url: 'https://r2.dev/states.kml', bytes: 21000000 },
      shapefile: { url: 'https://r2.dev/states.shp.zip', bytes: 11000000 },
      licence: 'CC0-1.0', attribution: { primary: { name: 'LGD', url: 'https://lgd.gov.in' } },
      category: 'boundaries', provenance: 'curated', notes: 'State boundaries',
    },
    {
      id: 'wards_chennai', level: 'wards_chennai', source: 'OpenCity', rows: 200,
      parquet: { url: 'https://r2.dev/chennai.parquet', bytes: 699072 },
      pmtiles: { url: 'https://r2.dev/chennai.pmtiles', bytes: 214930 },
      geojson: null, kml: null, shapefile: null,
      licence: 'ODbL-1.0', attribution: { primary: { name: 'OpenCity', url: 'https://data.opencity.in' } },
      category: 'city-wards', provenance: 'curated', notes: 'Chennai wards',
    },
    {
      id: 'seismic_zones', level: 'seismic_zone', source: 'data.gov.in', rows: 5,
      parquet: { url: 'https://r2.dev/seismic.parquet', bytes: 50000 },
      pmtiles: { url: 'https://r2.dev/seismic.pmtiles', bytes: 30000 },
      geojson: { url: 'https://r2.dev/seismic.geojson', bytes: 120000 },
      kml: null, shapefile: null,
      licence: 'GODL-India', attribution: { primary: { name: 'data.gov.in', url: 'https://data.gov.in' } },
      category: 'environment', provenance: 'curated', notes: 'BIS seismic zones',
      tags: ['hazard', 'earthquake', 'tremor'],
    },
  ],
  categories: {
    'boundaries': 'Boundaries',
    'city-wards': 'City wards',
    'environment': 'Environment',
  },
  levels: {
    'state': { order: 1, plural: 'states', path: 'admin/states', category: 'boundaries' },
    'seismic_zone': { order: 30, plural: 'seismic zones', path: 'environment/seismic', category: 'environment' },
  },
  level_meta: {
    'lgd_states': { label: 'States (2024)', unit: 'states & UTs', description: 'All 36 states and UTs' },
    'wards_chennai': { label: 'Chennai (GCC) Wards', unit: 'wards', description: '200 ward boundaries' },
  },
  level_order: ['state', 'seismic_zone'],
  filter_stats: {
    'lgd_states': { columns: [{ column_name: 'stname', kind: 'categorical' }] },
  },
};

describe('filterLayers', () => {
  it('returns all layers with no filters', () => {
    const result = filterLayers(SAMPLE_CATALOG.layers, {});
    expect(result).toHaveLength(3);
  });

  it('filters by category', () => {
    const result = filterLayers(SAMPLE_CATALOG.layers, { category: 'boundaries' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('lgd_states');
  });

  it('filters by level', () => {
    const result = filterLayers(SAMPLE_CATALOG.layers, { level: 'state' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('lgd_states');
  });

  it('filters by source', () => {
    const result = filterLayers(SAMPLE_CATALOG.layers, { source: 'OpenCity' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('wards_chennai');
  });

  it('filters by text query (case-insensitive)', () => {
    const result = filterLayers(SAMPLE_CATALOG.layers, { q: 'chennai' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('wards_chennai');
  });

  it('text query matches id, notes, and source', () => {
    expect(filterLayers(SAMPLE_CATALOG.layers, { q: 'seismic' })).toHaveLength(1);
    expect(filterLayers(SAMPLE_CATALOG.layers, { q: 'LGD' })).toHaveLength(1);
    expect(filterLayers(SAMPLE_CATALOG.layers, { q: 'State boundaries' })).toHaveLength(1);
  });

  it('text query matches per-layer tags (e.g. groundwater finds an aquifer layer)', () => {
    // "earthquake"/"tremor" appear only in tags, not id/source/notes/category/level.
    expect(filterLayers(SAMPLE_CATALOG.layers, { q: 'earthquake' })).toHaveLength(1);
    expect(filterLayers(SAMPLE_CATALOG.layers, { q: 'tremor' })[0].id).toBe('seismic_zones');
  });

  it('combines multiple filters (AND)', () => {
    const result = filterLayers(SAMPLE_CATALOG.layers, { category: 'boundaries', q: 'state' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('lgd_states');
  });

  it('returns empty for no matches', () => {
    expect(filterLayers(SAMPLE_CATALOG.layers, { q: 'nonexistent' })).toHaveLength(0);
  });
});

describe('paginateResults', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: `item_${i}` }));

  it('returns first page with defaults', () => {
    const result = paginateResults(items, {});
    expect(result.data).toHaveLength(25);
    expect(result.total).toBe(25);
    expect(result.limit).toBe(100);
    expect(result.offset).toBe(0);
  });

  it('respects limit', () => {
    const result = paginateResults(items, { limit: 10 });
    expect(result.data).toHaveLength(10);
    expect(result.total).toBe(25);
  });

  it('respects offset', () => {
    const result = paginateResults(items, { limit: 10, offset: 20 });
    expect(result.data).toHaveLength(5);
    expect(result.offset).toBe(20);
  });

  it('clamps limit to 1-500', () => {
    expect(paginateResults(items, { limit: 0 }).limit).toBe(1);
    expect(paginateResults(items, { limit: -5 }).limit).toBe(1);
    expect(paginateResults(items, { limit: 1000 }).limit).toBe(500);
  });

  it('clamps offset to >= 0', () => {
    expect(paginateResults(items, { offset: -10 }).offset).toBe(0);
  });
});

describe('toApiLayer', () => {
  it('transforms a catalog layer to the API shape', () => {
    const api = toApiLayer(SAMPLE_CATALOG.layers[0], SAMPLE_CATALOG);
    expect(api.id).toBe('lgd_states');
    expect(api.downloads.parquet).toEqual({ url: 'https://r2.dev/states.parquet', bytes: 7000000 });
    expect(api.downloads.kml).toEqual({ url: 'https://r2.dev/states.kml', bytes: 21000000 });
    expect(api.level_meta?.label).toBe('States (2024)');
    expect(api).not.toHaveProperty('parquet');
    expect(api).not.toHaveProperty('pmtiles');
  });

  it('omits null download formats', () => {
    const api = toApiLayer(SAMPLE_CATALOG.layers[1], SAMPLE_CATALOG);
    expect(api.downloads.parquet).toBeTruthy();
    expect(api.downloads.geojson).toBeUndefined();
    expect(api.downloads.kml).toBeUndefined();
  });

  it('includes filter_stats on detail view', () => {
    const api = toApiLayer(SAMPLE_CATALOG.layers[0], SAMPLE_CATALOG, true);
    expect(api.filter_stats).toBeTruthy();
    expect(api.filter_stats?.columns[0].column_name).toBe('stname');
  });

  it('excludes filter_stats on list view', () => {
    const api = toApiLayer(SAMPLE_CATALOG.layers[0], SAMPLE_CATALOG, false);
    expect(api.filter_stats).toBeUndefined();
  });
});

describe('toApiCategory', () => {
  it('produces category with layer count', () => {
    const cats = toApiCategory(SAMPLE_CATALOG);
    expect(cats).toHaveLength(3);
    const boundaries = cats.find((c) => c.id === 'boundaries');
    expect(boundaries?.label).toBe('Boundaries');
    expect(boundaries?.layer_count).toBe(1);
  });
});

describe('toApiLevel', () => {
  it('produces ordered levels', () => {
    const levels = toApiLevel(SAMPLE_CATALOG);
    expect(levels[0].id).toBe('state');
    expect(levels[0].order).toBe(1);
    expect(levels[1].id).toBe('seismic_zone');
  });
});
