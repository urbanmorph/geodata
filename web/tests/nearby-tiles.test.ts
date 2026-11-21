import { describe, it, expect } from 'vitest';
// geojson-vt and vt-pbf come with maplibre-gl; they cut and encode test tiles the way tippecanoe's do.
// @ts-expect-error no types
import geojsonvt from 'geojson-vt';
// @ts-expect-error no types
import vtpbf from 'vt-pbf';
import { nearestInTiles, tilesCovering, type TileData } from '../functions/lib/nearby-tiles';
import { lngLatToTile } from '../functions/lib/tile-math';

const Z = 12;
const fc = {
  type: 'FeatureCollection',
  features: [
    // a long north-south river at 88.34E: its centre is far, it passes 2 km west of the point
    { type: 'Feature', properties: { rivname: 'Hooghly' }, geometry: { type: 'LineString', coordinates: [[88.34, 21.5], [88.34, 23.5]] } },
    { type: 'Feature', properties: { rivname: 'Far' }, geometry: { type: 'LineString', coordinates: [[88.6, 22.5], [88.6, 22.7]] } },
    { type: 'Feature', properties: { wetname: 'Pond', descr: 'Lake/Pond' }, geometry: { type: 'Polygon', coordinates: [[[88.355, 22.565], [88.365, 22.565], [88.365, 22.575], [88.355, 22.575], [88.355, 22.565]]] } },
    { type: 'Feature', properties: { wetname: 'X', descr: 'Others (non-wetland area)' }, geometry: { type: 'Polygon', coordinates: [[[88.37, 22.565], [88.38, 22.565], [88.38, 22.575], [88.37, 22.575], [88.37, 22.565]]] } },
  ],
};
const index = geojsonvt(fc, { maxZoom: Z, indexMaxZoom: Z, buffer: 64, tolerance: 0 });

function tiles(lat: number, lng: number, km: number): TileData[] {
  const d = km / 111;
  return tilesCovering({ xmin: lng - d, ymin: lat - d, xmax: lng + d, ymax: lat + d }, Z).flatMap(({ x, y }) => {
    const t = index.getTile(Z, x, y);
    if (!t) return [];
    const buf: Uint8Array = vtpbf.fromGeojsonVt({ layer: t });
    return [{ z: Z, x, y, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer }];
  });
}

describe('tilesCovering', () => {
  it('lists every tile of the bbox at a zoom', () => {
    const t = tilesCovering({ xmin: 88.3, ymin: 22.5, xmax: 88.4, ymax: 22.6 }, Z);
    const a = lngLatToTile(88.3, 22.6, Z), b = lngLatToTile(88.4, 22.5, Z);
    expect(t).toHaveLength((b.x - a.x + 1) * (b.y - a.y + 1));
  });
});

describe('nearestInTiles', () => {
  const LAT = 22.57, LNG = 88.36;

  it('finds a long river by its distance, not its centre, once across tiles', () => {
    const r = nearestInTiles(tiles(LAT, LNG, 10), LAT, LNG, 10, { limit: 5, keep: (p) => !!p.rivname });
    expect(r.features.map((f) => f.properties.rivname)).toEqual(['Hooghly']);
    expect(r.total).toBe(1);
    expect(r.features[0].distance_km).toBeCloseTo(0.02 * 111.195 * Math.cos(LAT * Math.PI / 180), 1);
    expect(r.features[0].lng).toBeCloseTo(88.34, 3);
  });

  it('is 0 inside a polygon, and keep drops the rows it rejects', () => {
    const r = nearestInTiles(tiles(LAT, LNG, 5), LAT, LNG, 5, { limit: 5, keep: (p) => p.descr !== undefined && !/non-wetland/.test(String(p.descr)) });
    expect(r.features.map((f) => [f.properties.wetname, f.distance_km])).toEqual([['Pond', 0]]);
  });

  it('keeps to the radius', () => {
    const r = nearestInTiles(tiles(LAT, LNG, 1), LAT, LNG, 1, { limit: 5 });
    expect(r.features.map((f) => f.properties.rivname ?? f.properties.wetname)).toEqual(['Pond']);
  });
});
