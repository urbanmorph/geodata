// A vector tile's y is Mercator: the latitude of a point inside a tile is not a straight
// line between the tile's north and south edges. mvt-locate.ts and nearby-tiles.ts
// interpolated it linearly, which put borders up to ~12 m off in a zoom-10 tile and
// ~200 m off in a zoom-8 one (the aquifer layer's tiles), mid-tile, at Indian latitudes:
// the merged-index measurement (24 Nov 2026) found 99 wrong locate answers in 64,665.
import { describe, it, expect } from 'vitest';
// @ts-expect-error no types
import geojsonvt from 'geojson-vt';
// @ts-expect-error no types
import vtpbf from 'vt-pbf';
import { lngLatToTile, tilePointToLngLat } from '../functions/lib/tile-math';
import { findFeaturesAtPoint } from '../functions/lib/mvt-locate';
import { nearestInTiles } from '../functions/lib/nearby-tiles';

const R = 6371.0088;
const toRad = (d: number) => (d * Math.PI) / 180;
/** A tile point's latitude: the inverse of the Mercator y the tile stores. */
const worldY = (lat: number, z: number) => ((1 - Math.log(Math.tan(toRad(lat)) + 1 / Math.cos(toRad(lat))) / Math.PI) / 2) * 2 ** z;

describe('tilePointToLngLat', () => {
  it('is the inverse of the tile coordinates of a point, to a millionth of a degree', () => {
    for (const [lng, lat, z] of [[77.2167, 28.6315, 10], [88.36, 22.57, 8], [72.88, 19.07, 12], [76.95, 8.5, 6]]) {
      const n = 2 ** z;
      const wx = ((lng + 180) / 360) * n, wy = worldY(lat, z);
      const x = Math.floor(wx), y = Math.floor(wy);
      const [glng, glat] = tilePointToLngLat(z, x, y, (wx - x) * 4096, (wy - y) * 4096, 4096);
      expect(glng).toBeCloseTo(lng, 6);
      expect(glat).toBeCloseTo(lat, 6);
    }
  });
});

// A square whose southern border runs along the middle of a zoom-8 tile, where the linear
// error is largest.
const Z = 8;
const { x: TX, y: TY } = lngLatToTile(77.2, 28.6, Z);
const MID = tilePointToLngLat(Z, TX, TY, 2048, 2048, 4096)[1];
const DLAT = 0.1 / 111.2; // 100 m
function tileOf(geometry: unknown) {
  const index = geojsonvt({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'square' }, geometry }] },
    { maxZoom: Z, indexMaxZoom: Z, buffer: 64, tolerance: 0 });
  const buf: Uint8Array = vtpbf.fromGeojsonVt({ layer: index.getTile(Z, TX, TY) });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe('locate decodes a tile with Mercator latitudes', () => {
  const west = tilePointToLngLat(Z, TX, TY, 1000, 0, 4096)[0], east = tilePointToLngLat(Z, TX, TY, 3000, 0, 4096)[0];
  const tile = tileOf({ type: 'Polygon', coordinates: [[[west, MID], [east, MID], [east, MID + 0.3], [west, MID + 0.3], [west, MID]]] });
  const lng = (west + east) / 2;
  it('a point 100 m inside the border is inside, one 100 m outside is not', () => {
    expect(findFeaturesAtPoint(tile, Z, TX, TY, lng, MID + DLAT)).toHaveLength(1);
    expect(findFeaturesAtPoint(tile, Z, TX, TY, lng, MID - DLAT)).toHaveLength(0);
  });
});

describe('nearby measures to a tile shape with Mercator latitudes', () => {
  it('a line along the tile\'s middle, 1 km north of the point, is 1 km away (within the tile\'s rounding)', () => {
    const west = tilePointToLngLat(Z, TX, TY, 500, 0, 4096)[0], east = tilePointToLngLat(Z, TX, TY, 3500, 0, 4096)[0];
    const tile = tileOf({ type: 'LineString', coordinates: [[west, MID], [east, MID]] });
    const lat = MID - 1 / R * (180 / Math.PI);
    const got = nearestInTiles([{ z: Z, x: TX, y: TY, data: tile }], lat, (west + east) / 2, 5, { limit: 1 });
    expect(got.features[0].distance_km).toBeCloseTo(1, 1); // the linear decode said ~1.2 km
  });
});
