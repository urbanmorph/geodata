// Nearest lines and polygons by true distance, read from the layer's map tiles.
//
// nearby-geometry.ts reads shapes from the parquet, but a heavy layer keeps tens
// of MB of geometry in each row group (wris_rivers: 40 MB) and the parquet has no
// page index, so one river read pulls a whole row group: over a minute through a
// remote R2 binding. The tiles hold the same shapes cut into small squares: the
// handful of tiles covering the search radius at the layer's top zoom (all of its
// features, quantised to about 2 m at z12) answer in a few small reads, and the
// tile cache (locate.ts) keeps them for the next point. Properties are the
// tiles' popup fields. A feature cut across tiles is one feature (same id or
// properties): its nearest piece wins.
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { CatalogData } from './catalog-api';
import { pmtilesFor, tileAt } from './locate';
import { lngLatToTile, tileBounds } from './tile-math';
import { r2KeyFromUrl } from './r2-keys';
import { queryBbox } from './nearby';
import { closestOnGeometry, type GeomHit, type NearestShapeOpts } from './nearby-geometry';
import { mapConcurrent, R2_CONCURRENCY } from './concurrency';
import { GIS_ARTEFACT_COLUMNS } from './junk-columns';

/** Most tiles one search reads; past this it steps down a zoom (and says the count may be short). */
export const MAX_TILES = 36;

export interface TileData { z: number; x: number; y: number; data: ArrayBuffer }

type Coord = [number, number];

/** The tiles at zoom z covering the bbox, as x/y ranges. */
export function tilesCovering(bbox: { xmin: number; ymin: number; xmax: number; ymax: number }, z: number): Array<{ x: number; y: number }> {
  const a = lngLatToTile(bbox.xmin, bbox.ymax, z), b = lngLatToTile(bbox.xmax, bbox.ymin, z);
  const out = [];
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) out.push({ x, y });
  return out;
}

function signedArea(ring: Coord[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return sum;
}

/** MVT rings as polygons: an outer ring (negative area once in lng/lat) starts each polygon. */
function polygonsOf(rings: Coord[][]): Coord[][][] {
  const polys: Coord[][][] = [];
  for (const ring of rings) {
    if (signedArea(ring) < 0 || !polys.length) polys.push([ring]);
    else polys[polys.length - 1].push(ring);
  }
  return polys;
}

const canonical = (layer: string, p: Record<string, unknown>) => layer + JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]));

/** Every feature of these tiles within radiusKm of the point, nearest first, one per feature. */
export function nearestInTiles(
  tiles: TileData[], lat: number, lng: number, radiusKm: number, opts: Pick<NearestShapeOpts, 'limit' | 'keep' | 'edge'>,
): { features: GeomHit[]; total: number } {
  const best = new Map<string, GeomHit>();
  for (const { z, x, y, data } of tiles) {
    const tile = new VectorTile(new Pbf(data));
    const b = tileBounds(x, y, z);
    for (const name of Object.keys(tile.layers)) {
      const layer = tile.layers[name];
      const toLngLat = ({ x: px, y: py }: { x: number; y: number }): Coord =>
        [b.west + (px / layer.extent) * (b.east - b.west), b.north - (py / layer.extent) * (b.north - b.south)];
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const parts = f.loadGeometry().map((ring) => ring.map(toLngLat));
        const geo = f.type === 1 ? { type: 'MultiPoint', coordinates: parts.flat() }
          : f.type === 2 ? { type: 'MultiLineString', coordinates: parts }
            : { type: 'MultiPolygon', coordinates: polygonsOf(parts) };
        const near = closestOnGeometry(lat, lng, geo, opts.edge);
        if (!near || near.km > radiusKm) continue;
        const properties: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(f.properties)) if (!GIS_ARTEFACT_COLUMNS.has(k.toLowerCase())) properties[k] = v;
        if (opts.keep && !opts.keep(properties)) continue;
        const id = f.id !== undefined ? `${name}#${f.id}` : canonical(name, properties);
        const hit = { properties, lat: Math.round(near.lat * 1e5) / 1e5, lng: Math.round(near.lng * 1e5) / 1e5, distance_km: Math.round(near.km * 100) / 100 };
        const had = best.get(id);
        if (!had || hit.distance_km < had.distance_km) best.set(id, hit);
      }
    }
  }
  const all = [...best.values()].sort((a, b) => a.distance_km - b.distance_km);
  return { features: all.slice(0, opts.limit), total: all.length };
}

/** nearestInTiles over a catalog layer's PMTiles on R2, at its top zoom (or lower, to stay within MAX_TILES). */
export async function nearbyFromTiles(
  lat: number, lng: number, radiusKm: number, layerId: string, catalog: CatalogData, r2: R2Bucket, opts: NearestShapeOpts,
): Promise<{ features: GeomHit[]; total: number; capped: boolean }> {
  const layer = catalog.layers.find((l) => l.id === layerId);
  const key = r2KeyFromUrl(layer?.pmtiles?.url);
  if (!key) throw new Error(`${layerId}: no map tiles`);
  const pm = pmtilesFor(r2, key);
  const header = await pm.getHeader();
  const bbox = queryBbox(lat, lng, radiusKm);
  let z = header.maxZoom;
  let cover = tilesCovering(bbox, z);
  while (cover.length > MAX_TILES && z > header.minZoom) cover = tilesCovering(bbox, --z);
  const tiles = (await mapConcurrent(cover, R2_CONCURRENCY, async ({ x, y }) => {
    const data = await tileAt(pm, key, z, x, y);
    return data ? { z, x, y, data } : null;
  })).filter((t): t is TileData => !!t);
  return { ...nearestInTiles(tiles, lat, lng, radiusKm, opts), capped: z < header.maxZoom };
}
