import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parquetMetadataAsync } from 'hyparquet';
import { closestOnGeometry, bboxDistanceKm, nearestByGeometry } from '../functions/lib/nearby-geometry';

// Fixture (duckdb spatial, GeoParquet, 4 rows per row group): a 4-degree
// north-south line 'long' at 77.0E (26-30N, its bbox centre 55 km from the test
// point), a short line 'short_near' at 28.5N (77.02-77.03E), a 'far' line at
// 78.5E, a square 'poly' (76.9-76.95E, 28.6-28.65N) and 50 points at 20N.
const buf = readFileSync(new URL('./fixtures/nearby-lines.parquet', import.meta.url));
const file = {
  byteLength: buf.byteLength,
  slice: async (s: number, e?: number) => buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + (e ?? buf.byteLength)) as ArrayBuffer,
};
const LAT = 28.5, LNG = 77.012;

describe('closestOnGeometry', () => {
  const line = { type: 'LineString', coordinates: [[77.0, 28.0], [77.0, 29.0]] };
  it('is the distance to the nearest segment, not to the centre', () => {
    // 0.01 degree of longitude east of a north-south line at 28.9N: ~0.97 km
    expect(closestOnGeometry(28.9, 77.01, line)!.km).toBeCloseTo(0.974, 2);
    expect(closestOnGeometry(28.9, 77.01, line)).toMatchObject({ lat: 28.9, lng: 77.0 });
    expect(closestOnGeometry(28.5, 77.0, line)!.km).toBeCloseTo(0, 5);
    // past the end: distance to the end point
    expect(closestOnGeometry(29.01, 77.0, line)!.km).toBeCloseTo(1.112, 2);
  });

  it('reads WKB bytes and multi geometries', () => {
    const wkb = new Uint8Array(1 + 4 + 4 + 2 * 16);
    const dv = new DataView(wkb.buffer);
    dv.setUint8(0, 1); dv.setUint32(1, 2, true); dv.setUint32(5, 2, true);
    dv.setFloat64(9, 77, true); dv.setFloat64(17, 28, true); dv.setFloat64(25, 77, true); dv.setFloat64(33, 29, true);
    expect(closestOnGeometry(28.9, 77.01, wkb)!.km).toBeCloseTo(0.974, 2);
    const multi = { type: 'MultiLineString', coordinates: [[[80, 20], [80, 21]], line.coordinates] };
    expect(closestOnGeometry(28.9, 77.01, multi)!.km).toBeCloseTo(0.974, 2);
    expect(closestOnGeometry(28.9, 77.01, null)).toBeNull();
  });

  it('is 0 inside a polygon and the distance to its edge outside', () => {
    const sq = { type: 'Polygon', coordinates: [[[76.9, 28.6], [76.95, 28.6], [76.95, 28.65], [76.9, 28.65], [76.9, 28.6]]] };
    expect(closestOnGeometry(28.62, 76.92, sq)!.km).toBe(0);
    expect(closestOnGeometry(28.62, 76.96, sq)!.km).toBeCloseTo(0.01 * 111.195 * Math.cos(28.62 * Math.PI / 180), 2);
  });
});

describe('bboxDistanceKm', () => {
  it('is 0 inside the box and the gap to its nearest edge outside', () => {
    expect(bboxDistanceKm(28.5, 77, { xmin: 76, ymin: 28, xmax: 78, ymax: 29 })).toBe(0);
    expect(bboxDistanceKm(29.1, 77, { xmin: 76, ymin: 28, xmax: 78, ymax: 29 })).toBeCloseTo(11.12, 1);
  });
});

describe('nearestByGeometry', () => {
  it('finds a long line whose bbox centre is far away, ranked by true distance', async () => {
    const md = await parquetMetadataAsync(file);
    const r = await nearestByGeometry(file, md, LAT, LNG, 5, { limit: 10 });
    expect(r.features.map((f) => f.properties.name)).toEqual(['short_near', 'long']);
    expect(r.total).toBe(2);
    expect(r.capped).toBe(false);
    expect(r.features[0].distance_km).toBeCloseTo(0.78, 1);
    expect(r.features[1].distance_km).toBeCloseTo(1.17, 1);
    // the closest point on the line, not its bbox centre
    expect(r.features[1].lat).toBeCloseTo(28.5, 4);
    expect(r.features[1].lng).toBeCloseTo(77.0, 4);
    expect(r.features[1].properties).toEqual({ name: 'long', kind: 'river' }); // no geometry or bbox columns
  });

  it('measures polygons to their edge and keeps the radius', async () => {
    const md = await parquetMetadataAsync(file);
    const r = await nearestByGeometry(file, md, LAT, LNG, 20, { limit: 10 });
    expect(r.features.map((f) => f.properties.name)).toEqual(['short_near', 'long', 'poly']);
    expect(r.features[2].distance_km).toBeGreaterThan(10);
    expect((await nearestByGeometry(file, md, 28.62, 76.92, 1, { limit: 10 })).features[0]).toMatchObject({ distance_km: 0 });
  });

  it('limits what it returns but counts all within the radius', async () => {
    const md = await parquetMetadataAsync(file);
    const r = await nearestByGeometry(file, md, LAT, LNG, 20, { limit: 1 });
    expect(r.features).toHaveLength(1);
    expect(r.total).toBe(3);
  });

  it('reads at most maxCandidates shapes (nearest boxes first) and says it was capped', async () => {
    const md = await parquetMetadataAsync(file);
    const r = await nearestByGeometry(file, md, LAT, LNG, 20, { limit: 10, maxCandidates: 2 });
    expect(r.capped).toBe(true);
    expect(r.features.map((f) => f.properties.name)).toEqual(['short_near', 'long']);
  });

  it('with edge, measures to the outline from inside a polygon (distance to a coast or border)', async () => {
    const md = await parquetMetadataAsync(file);
    const r = await nearestByGeometry(file, md, 28.62, 76.92, 5, { limit: 10, edge: true });
    const poly = r.features.find((f) => f.properties.name === 'poly')!;
    // 76.92 is 0.02 degrees of longitude from the west edge (76.9), nearer than the south edge (0.02 of latitude)
    expect(poly.distance_km).toBeCloseTo(0.02 * 111.195 * Math.cos(28.62 * Math.PI / 180), 1);
    expect(poly.lng).toBeCloseTo(76.9, 4);
  });

  it('counts only the rows `keep` keeps', async () => {
    const md = await parquetMetadataAsync(file);
    const r = await nearestByGeometry(file, md, LAT, LNG, 20, { limit: 10, keep: (p) => p.kind !== 'river' });
    expect(r.features.map((f) => f.properties.name)).toEqual(['short_near', 'poly']);
    expect(r.total).toBe(2);
  });

  it('answers nothing, not an error, far from every feature', async () => {
    const md = await parquetMetadataAsync(file);
    expect(await nearestByGeometry(file, md, 10, 90, 5, { limit: 3 })).toEqual({ features: [], total: 0, capped: false });
  });
});
