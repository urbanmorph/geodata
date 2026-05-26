import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { tileBounds } from './tile-math';
import { pointInPolygon } from './point-in-polygon';

export interface LocateHit {
  layer_name: string;
  properties: Record<string, unknown>;
}

export function findFeaturesAtPoint(
  tileData: ArrayBuffer,
  z: number, x: number, y: number,
  lng: number, lat: number,
): LocateHit[] {
  const tile = new VectorTile(new Pbf(tileData));
  const bounds = tileBounds(x, y, z);
  const hits: LocateHit[] = [];

  for (const layerName of Object.keys(tile.layers)) {
    const layer = tile.layers[layerName];
    for (let i = 0; i < layer.length; i++) {
      const feat = layer.feature(i);
      if (feat.type !== 3) continue; // only polygons

      const rings = toGeoRings(feat, bounds, layer.extent);
      if (!rings.length) continue;

      // MultiPolygon: test each polygon separately
      const polys = splitMultiPolygon(rings);
      for (const poly of polys) {
        if (pointInPolygon([lng, lat], poly)) {
          hits.push({ layer_name: layerName, properties: feat.properties });
          break;
        }
      }
    }
  }

  return hits;
}

function toGeoRings(
  feat: { loadGeometry(): { x: number; y: number }[][] },
  bounds: { west: number; south: number; east: number; north: number },
  extent: number,
): [number, number][][] {
  const geom = feat.loadGeometry();
  return geom.map((ring) =>
    ring.map(({ x, y }) => [
      bounds.west + (x / extent) * (bounds.east - bounds.west),
      bounds.north - (y / extent) * (bounds.north - bounds.south),
    ] as [number, number]),
  );
}

/**
 * MVT packs MultiPolygons as a flat list of rings. After conversion to
 * geographic coordinates, outer rings have negative signed area (CCW in
 * screen space becomes CW in lng/lat). Split into separate polygons at
 * each outer ring boundary.
 */
function splitMultiPolygon(rings: [number, number][][]): [number, number][][][] {
  const polys: [number, number][][][] = [];
  let current: [number, number][][] | null = null;
  for (const ring of rings) {
    if (signedArea(ring) < 0) {
      if (current) polys.push(current);
      current = [ring];
    } else if (current) {
      current.push(ring);
    }
  }
  if (current) polys.push(current);
  return polys;
}

function signedArea(ring: [number, number][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum;
}
