// The merged point index (scripts/bake_point_index.py, lib/point-index.ts): locate answers
// the layers it covers from one tile of each merged archive instead of one tile of every
// layer, and falls back to a layer's own tiles whenever the index cannot answer for it
// (a layer rebaked since the index, one not in it, a coarser zoom, a failed read).
// Fixtures: tests/fixtures/make-point-index.py (the bake's own tippecanoe command and sidecar).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { locate, clearTileCache, type LocateResponse } from '../functions/lib/locate';
import { clearPointIndexCache, type PointIndexManifest } from '../functions/lib/point-index';
import { profileAt, BASE_DEPS, type ProfileDeps, type ProfileSpec } from '../functions/lib/profile';
import type { CatalogData, CatalogLayer } from '../functions/lib/catalog-api';
import { fakeR2 } from './helpers/fake-r2';

const F = (n: string) => readFileSync(new URL(`./fixtures/point-index/${n}`, import.meta.url));
const BASE = 'https://data.bharatlas.com';
const OBJECTS: Record<string, Buffer> = {
  't/pa.pmtiles': F('pa.pmtiles'), 't/pb.pmtiles': F('pb.pmtiles'), 't/zz.pmtiles': F('zz.pmtiles'),
  'point-index/place.pmtiles': F('place.pmtiles'), 'point-index/zones.pmtiles': F('zones.pmtiles'),
  'point-index/props/zz.json': F('zz.props.json'),
};

const layer = (id: string, category: string, file = id): CatalogLayer => ({
  id, name: id, level: category, category, source: 'Test', licence: 'CC0-1.0',
  parquet: { url: `${BASE}/t/${file}.parquet`, bytes: 100 }, pmtiles: { url: `${BASE}/t/${file}.pmtiles`, bytes: 1 },
} as CatalogLayer);
const catalogOf = (...layers: CatalogLayer[]) => ({ categories: {}, levels: {}, level_meta: {}, layers } as unknown as CatalogData);
const CATALOG = catalogOf(layer('pa', 'boundaries'), layer('pb', 'wards'), layer('zz', 'hazards'), layer('other', 'boundaries', 'pa'));

const entry = (id: string, archive: string, extra = {}) => ({
  archive, parquet: { url: `${BASE}/t/${id}.parquet`, bytes: 100 }, etag: `e-${id}`, pmtiles: `${BASE}/t/${id}.pmtiles`, ...extra,
});
function indexWith(place = 'place', zones = 'zones'): PointIndexManifest {
  return {
    zoom: 12,
    archives: {
      place: { url: `${BASE}/point-index/${place}.pmtiles`, bytes: 1 },
      zones: { url: `${BASE}/point-index/${zones}.pmtiles`, bytes: 1 },
    },
    layers: {
      pa: entry('pa', 'place'), pb: entry('pb', 'place'),
      zz: entry('zz', 'zones', { props: { url: `${BASE}/point-index/props/zz.json`, bytes: OBJECTS['point-index/props/zz.json'].byteLength } }),
    },
  };
}
const INDEX = indexWith();
const NO_INDEX: PointIndexManifest = { zoom: 12, archives: {}, layers: {} };

// [lng, lat]: inside each layer's shapes, away from their edges
const POINTS: Array<[number, number]> = [
  [77.52, 12.95], // pa west, pb, zz III (row 0, the first strip)
  [77.58, 12.95], // pa west, pb, zz IV
  [77.66, 12.95], // pa east, pb's hole, zz III (the second strip)
  [77.62, 12.99], // pa east, pb (north of the hole), zz IV
  [77.72, 12.95], // pb only
  [77.40, 12.95], // nothing
];
const LAYERS = ['pa', 'pb', 'zz'];

const answer = (r: LocateResponse) => ({ ...r, timing_ms: 0 });
function bucket(objects = OBJECTS) {
  const gets: Array<[string, number, number]> = [];
  return { r2: fakeR2(objects, gets), gets, keys: () => [...new Set(gets.map(([k]) => k))].sort() };
}
const run = (lng: number, lat: number, opts: { index: PointIndexManifest; scope?: object }, r2: R2Bucket, catalog = CATALOG, layers = LAYERS, zoom = 14) =>
  locate(lat, lng, layers, zoom, catalog, r2, opts);

beforeEach(() => {
  clearTileCache();
  clearPointIndexCache();
});

describe('locate with the merged point index', () => {
  it('answers exactly as the layers own tiles do, at every point', async () => {
    for (const [lng, lat] of POINTS) {
      const own = await run(lng, lat, { index: NO_INDEX }, bucket().r2);
      const merged = await run(lng, lat, { index: INDEX }, bucket().r2);
      expect(answer(merged)).toEqual(answer(own));
    }
  });

  it('the fixtures answer what they were drawn to (the parity above is not empty)', async () => {
    const r = await run(77.52, 12.95, { index: INDEX }, bucket().r2);
    expect(r.results.boundaries).toEqual([{ layer_id: 'pa', level: 'boundaries', category: 'boundaries', feature: { properties: { name: 'west', code: 1 } } }]);
    expect(r.results.wards?.[0].feature.properties).toEqual({ ward: 'W1', no: 7 });
    expect(r.results.hazards?.[0].feature.properties).toEqual({ zone: 'III', area: 1.5 }); // row 0 of the sidecar
    const hole = await run(77.66, 12.95, { index: INDEX }, bucket().r2);
    expect(hole.results.wards).toBeUndefined();
    expect(hole.results.hazards?.[0].feature.properties).toEqual({ zone: 'III', area: 1.5 });
  });

  it('reads the merged archives, not the layers own tiles', async () => {
    const b = bucket();
    await run(77.58, 12.95, { index: INDEX }, b.r2);
    expect(b.keys()).toEqual(['point-index/place.pmtiles', 'point-index/props/zz.json', 'point-index/zones.pmtiles']);
  });

  it('a layer whose parquet changed since the bake is read from its own tiles', async () => {
    const rebaked = catalogOf({ ...layer('pa', 'boundaries'), parquet: { url: `${BASE}/t/pa.parquet`, bytes: 101 } }, layer('pb', 'wards'), layer('zz', 'hazards'));
    const b = bucket();
    const r = await run(77.52, 12.95, { index: INDEX }, b.r2, rebaked);
    expect(b.keys()).toEqual(['point-index/place.pmtiles', 'point-index/props/zz.json', 'point-index/zones.pmtiles', 't/pa.pmtiles']);
    expect(answer(r)).toEqual(answer(await run(77.52, 12.95, { index: NO_INDEX }, bucket().r2, rebaked)));
  });

  it('so is one whose parquet or tiles moved to a new key', async () => {
    for (const moved of [
      { ...layer('pa', 'boundaries'), parquet: { url: `${BASE}/t/pa.1234abcd.parquet`, bytes: 100 } },
      { ...layer('pa', 'boundaries'), pmtiles: { url: `${BASE}/t/pa.1234abcd.pmtiles`, bytes: 1 } },
    ]) {
      const b = bucket({ ...OBJECTS, 't/pa.1234abcd.pmtiles': OBJECTS['t/pa.pmtiles'] });
      await run(77.52, 12.95, { index: INDEX }, b.r2, catalogOf(moved as CatalogLayer), ['pa']);
      expect(b.keys().filter((k) => k.startsWith('t/'))).toHaveLength(1);
      expect(b.keys()).not.toContain('point-index/place.pmtiles');
    }
  });

  it('the same file at the other public address is not a change', async () => {
    const legacy = { ...layer('pa', 'boundaries'), parquet: { url: 'https://pub-x.r2.dev/t/pa.parquet', bytes: 100 },
      pmtiles: { url: 'https://pub-x.r2.dev/t/pa.pmtiles', bytes: 1 } } as CatalogLayer;
    const b = bucket();
    await run(77.52, 12.95, { index: INDEX }, b.r2, catalogOf(legacy), ['pa']);
    expect(b.keys()).toEqual(['point-index/place.pmtiles']);
  });

  it('a layer not in the index reads its own tiles', async () => {
    const b = bucket();
    const r = await run(77.52, 12.95, { index: INDEX }, b.r2, CATALOG, ['other']);
    expect(b.keys()).toEqual(['t/pa.pmtiles']);
    expect(r.results.boundaries?.[0].layer_id).toBe('other');
  });

  it('a zoom coarser than the index reads the layers own tiles', async () => {
    const b = bucket();
    await run(77.52, 12.95, { index: INDEX }, b.r2, CATALOG, LAYERS, 10);
    expect(b.keys()).toEqual(['t/pa.pmtiles', 't/pb.pmtiles', 't/zz.pmtiles']);
  });

  it('when the index cannot be read, the layers own tiles answer (nothing reported failed)', async () => {
    const missing = { ...OBJECTS };
    delete missing['point-index/place.pmtiles'];
    delete missing['point-index/props/zz.json'];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run(77.58, 12.95, { index: INDEX }, bucket(missing).r2);
    expect(r.failed_layers).toBeUndefined();
    expect(answer(r)).toEqual(answer(await run(77.58, 12.95, { index: NO_INDEX }, bucket().r2)));
  });

  it('layers asked one at a time under one scope share the merged tile read', async () => {
    // fresh archive keys, so each starts with no header or directory cached
    const objects = { ...OBJECTS, 'point-index/place-b.pmtiles': OBJECTS['point-index/place.pmtiles'] };
    const cold = bucket(objects);
    await run(77.52, 12.95, { index: indexWith('place-b') }, cold.r2, CATALOG, ['pa']); // header, directory, tile
    const reads = cold.gets.length;
    clearTileCache();
    const objectsC = { ...OBJECTS, 'point-index/place-c.pmtiles': OBJECTS['point-index/place.pmtiles'] };
    const shared = bucket(objectsC);
    const scope = {};
    await Promise.all(['pa', 'pb', 'pa', 'pb'].map((id) => run(77.52, 12.95, { index: indexWith('place-c'), scope }, shared.r2, CATALOG, [id])));
    expect(shared.gets.length).toBe(reads);
  });
});

describe('the point profiles', () => {
  it('ask every contains layer of one answer under one scope', async () => {
    const scopes: unknown[] = [];
    const deps: ProfileDeps = {
      ...BASE_DEPS, pixels: {},
      locate: (lat, lng, ids, z, catalog, r2, opts) => {
        scopes.push(opts?.scope);
        return locate(lat, lng, ids, z, catalog, r2, { ...opts, index: INDEX });
      },
    };
    const spec: ProfileSpec = {
      layers: LAYERS.map((id) => ({ id, section: 's', match: 'contains' as const })), sections: ['s'], pixels: [],
      disclaimer: '', nothing: '',
    };
    const b = bucket();
    const p = await profileAt(spec, 12.95, 77.52, CATALOG, b.r2, deps);
    expect(scopes).toHaveLength(3);
    expect(scopes[0]).toBeTruthy();
    expect(new Set(scopes).size).toBe(1);
    expect(p.sections.s.pa.features).toEqual([{ name: 'west', code: 1 }]);
    expect(p.sections.s.zz.features).toEqual([{ zone: 'III', area: 1.5 }]);
    expect(b.keys()).toEqual(['point-index/place.pmtiles', 'point-index/props/zz.json', 'point-index/zones.pmtiles']);
  });
});
