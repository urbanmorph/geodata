import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GROUND_LAYERS } from '../functions/lib/ground';
import { SURFACE_LAYERS } from '../functions/lib/surface';
import type { CatalogData } from '../functions/lib/catalog-api';
import { layerIsNonCommercial } from '../../shared/licences.mjs';
import { profileAt, UNDATED, type ProfileSpec } from '../functions/lib/profile';

// Release gate 7 (plan F3, F5, F6): every section of /ground and /surface says its
// scale or resolution, the period its data describe (or that the source gives none,
// with the date bharatlas fetched it), and its licence; non-commercial layers say so.
const CATALOG = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'catalog.json'), 'utf8')) as CatalogData;
const byId = new Map(CATALOG.layers.map((l) => [l.id, l]));

describe.each([['ground', GROUND_LAYERS], ['surface', SURFACE_LAYERS]] as const)('the %s table', (_name, rows) => {
  it.each(rows.map((r) => [r.key ?? r.id, r]))('%s says its scale, its licence and when it was fetched', (_k, r) => {
    expect(r.about?.scale, 'about.scale').toBeTruthy();
    const c = byId.get(r.id)!;
    expect(c.licence, 'catalog licence').toBeTruthy();
    expect(c.fetched_at, 'catalog fetched_at').toBeTruthy();
  });

  it('flags the NRSC layers it reads as non-commercial', () => {
    for (const r of rows.filter((x) => /^(bhuvan|ndem|gw_quality)_/.test(x.id))) {
      expect(layerIsNonCommercial(byId.get(r.id)!), r.id).toBe(true);
    }
  });
});

// Release gate 8 (plan F1, F4).
describe('the labels the gate asks for', () => {
  const row = (rows: typeof GROUND_LAYERS, id: string) => rows.find((r) => r.id === id)!;

  it('labels the seismic zones with their 2016 vintage in both lookups', () => {
    for (const rows of [GROUND_LAYERS, SURFACE_LAYERS]) {
      expect(row(rows, 'seismic_zones').about).toMatchObject({ vintage: 'BIS IS 1893 (Part 1):2016', note: expect.stringMatching(/2025.*withdrawn/) });
    }
  });

  it('explains the repeated subsidence coordinates and takes their median', () => {
    const s = row(GROUND_LAYERS, 'subsidence_megacities');
    expect(s.about?.note).toMatch(/Delhi and Kolkata.*repeat/);
    expect(s.median?.perPoint).toEqual(['Longitude', 'Latitude']);
  });
});

describe('every entry carries its year', () => {
  const layer = (id: string, fetched?: string) => ({
    id, level: id, source: 'S', rows: 1, category: 'x', provenance: 'p', licence: 'CC0-1.0',
    ...(fetched ? { fetched_at: fetched } : {}),
    pmtiles: { url: `https://r2/${id}.pmtiles`, bytes: 1 }, parquet: { url: `https://r2/${id}.parquet`, bytes: 1 },
  });
  const spec: ProfileSpec = {
    layers: [
      { id: 'dated', section: 's', match: 'contains', about: { scale: '1:50,000', vintage: '2015-16' } },
      { id: 'undated', section: 's', match: 'contains', about: { scale: '1:50,000' } },
    ],
    sections: ['s'], pixels: [], disclaimer: 'd', nothing: 'n',
  };
  const catalog = { layers: [layer('dated', '2026-05-28T00:00:00Z'), layer('undated', '2026-11-15T10:00:00Z')] } as unknown as CatalogData;
  const deps = {
    locate: async () => ({ point: { lat: 0, lng: 0 }, zoom: 14, queried_layers: [], timing_ms: 1, results: {} }),
    nearby: async () => { throw new Error('unused'); }, nearbyByGeometry: async () => { throw new Error('unused'); },
    nearbyFromTiles: async () => { throw new Error('unused'); }, pixels: {},
  } as unknown as Parameters<typeof profileAt>[5];

  it('the source\'s period where it gives one, else says it is undated, with the fetch date either way', async () => {
    expect(UNDATED).toMatch(/not dated/);
    const r = await profileAt(spec, 28.5, 77.1, catalog, {} as R2Bucket, deps);
    expect(r.sections.s.dated.about).toEqual({ scale: '1:50,000', vintage: '2015-16', fetched_at: '2026-05-28' });
    expect(r.sections.s.undated.about).toEqual({ scale: '1:50,000', vintage: UNDATED, fetched_at: '2026-11-15' });
  });
});
