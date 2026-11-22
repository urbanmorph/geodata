import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { nearbyTrueDistance } from '../functions/lib/nearby-true-distance';
import { clearTileCache } from '../functions/lib/locate';
import { clearShapeCache } from '../functions/lib/nearby-geometry';
import type { CatalogData } from '../functions/lib/catalog-api';
import { fakeR2 } from './helpers/fake-r2';

// /api/v1/nearby measured lines and polygons to their bbox centre (plan A1): a
// 4-degree line passing 1.2 km from a point showed as 55 km away, or not at all.
// It now measures to the shape, as /ground and /surface do; points are unchanged.
//
// Fixtures: nearby-lines.parquet (duckdb spatial; a 4-degree north-south line
// 'long' at 77.0E, a short line 'short_near' at 28.5N, a 'far' line, a square
// 'poly' and 50 points at 20N; columns name and kind) and nearby-lines-name.pmtiles
// (tippecanoe z8-12 of the same features, with only `name`, as map tiles keep
// only popup fields).
const parquet = readFileSync(new URL('./fixtures/nearby-lines.parquet', import.meta.url));
const tiles = readFileSync(new URL('./fixtures/nearby-lines-name.pmtiles', import.meta.url));
const r2 = () => fakeR2({ 't/lines.parquet': parquet, 't/lines.pmtiles': tiles });
const catalog = {
  layers: [{
    id: 'lines',
    parquet: { url: 'https://pub-x.r2.dev/t/lines.parquet', bytes: parquet.byteLength },
    pmtiles: { url: 'https://pub-x.r2.dev/t/lines.pmtiles', bytes: tiles.byteLength },
  }],
} as unknown as CatalogData;
const LAT = 28.5, LNG = 77.012;

beforeEach(() => { clearTileCache(); clearShapeCache(); });

describe('nearbyTrueDistance', () => {
  it('measures a line to its nearest segment, not its bbox centre 55 km away', async () => {
    const r = await nearbyTrueDistance(LAT, LNG, 5, 'lines', catalog, r2(), 10);
    expect(r.features.map((f) => f.properties.name)).toEqual(['short_near', 'long']);
    expect(r.total).toBe(2);
    expect(r._distance_to).toBe('shape');
    expect(r._source).toBe('parquet-shape');
    expect(r.features[1]._distance_km).toBeCloseTo(1.17, 1);
    // the nearest point of the line, and every column but the geometry and bbox
    expect(r.features[1]).toMatchObject({ _lat: 28.5, _lng: 77 });
    expect(r.features[1].properties).toEqual({ name: 'long', kind: 'river' });
  });

  it('is 0 inside a polygon', async () => {
    const r = await nearbyTrueDistance(28.62, 76.92, 1, 'lines', catalog, r2(), 10);
    expect(r.features[0]).toMatchObject({ _distance_km: 0, properties: { name: 'poly' } });
  });

  it('leaves a point layer as it was: distance to the point', async () => {
    const r = await nearbyTrueDistance(20, 80.0104, 0.5, 'lines', catalog, r2(), 3);
    expect(r._distance_to).toBe('point');
    expect(r._source).toBe('parquet-bbox');
    expect(r.features.map((f) => f.properties.name)).toEqual(['pt10', 'pt11', 'pt9']);
  });

  it('reads a layer too heavy for its shapes from the map tiles, with every column from the parquet', async () => {
    const r = await nearbyTrueDistance(LAT, LNG, 5, 'lines', catalog, r2(), 10, { parquetShapeBytes: 0 });
    expect(r._source).toBe('tiles-shape');
    expect(r.features.map((f) => f.properties.name)).toEqual(['short_near', 'long']);
    expect(r.features[1]._distance_km).toBeCloseTo(1.17, 1);
    // `kind` is not in the tiles: it comes from the parquet row that matches
    expect(r.features.map((f) => f.properties)).toEqual([{ name: 'short_near', kind: 'tunnel' }, { name: 'long', kind: 'river' }]);
  });

  it('answers nothing, not an error, far from every feature', async () => {
    const r = await nearbyTrueDistance(10, 90, 5, 'lines', catalog, r2(), 3);
    expect(r).toMatchObject({ total: 0, features: [] });
  });
});
