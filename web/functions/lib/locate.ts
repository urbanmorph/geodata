import { PMTiles } from 'pmtiles';
import { R2Source } from './r2-source';
import { lngLatToTile } from './tile-math';
import { findFeaturesAtPoint } from './mvt-locate';
import type { CatalogData, CatalogLayer } from './catalog-api';
import { r2KeyFromUrl } from './r2-keys';

export { DEFAULT_LOCATE_LAYERS } from './locate-layers';

export interface LocateResult {
  layer_id: string;
  level: string;
  category: string;
  feature: { properties: Record<string, unknown> };
}

export interface LocateResponse {
  point: { lat: number; lng: number };
  zoom: number;
  results: Record<string, LocateResult[]>;
  queried_layers: string[];
  /** Layers that could not be read (R2 or tile failure): their absence from
   *  `results` says nothing about the point. Absent when every layer answered. */
  failed_layers?: string[];
  timing_ms: number;
}

export async function locate(
  lat: number,
  lng: number,
  layerIds: string[],
  zoom: number,
  catalog: CatalogData,
  r2: R2Bucket,
): Promise<LocateResponse> {
  const start = Date.now();

  const layers = layerIds
    .map((id) => catalog.layers.find((l) => l.id === id))
    .filter((l): l is CatalogLayer => !!l && !!l.pmtiles);

  const settled = await Promise.allSettled(
    layers.map((layer) => queryLayer(layer, zoom, lng, lat, r2)),
  );

  const grouped: Record<string, LocateResult[]> = {};
  const failed: string[] = [];
  for (let i = 0; i < layers.length; i++) {
    const s = settled[i];
    if (s.status === 'rejected') {
      failed.push(layers[i].id);
      console.error(`locate: ${layers[i].id} failed:`, (s.reason as Error)?.message ?? s.reason);
      continue;
    }
    if (!s.value.length) continue;
    const layer = layers[i];
    for (const hit of s.value) {
      const cat = layer.category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push({
        layer_id: layer.id,
        level: layer.level,
        category: cat,
        feature: { properties: hit.properties },
      });
    }
  }

  return {
    point: { lat, lng },
    zoom,
    results: grouped,
    queried_layers: layers.map((l) => l.id),
    ...(failed.length ? { failed_layers: failed } : {}),
    timing_ms: Date.now() - start,
  };
}

// One reader per R2 key per isolate, so the archive's header and directory
// cache survive between requests (keys are versioned, so a rebake is a new key).
const readers = new Map<string, PMTiles>();
export function pmtilesFor(r2: R2Bucket, key: string): PMTiles {
  let pm = readers.get(key);
  if (!pm) {
    pm = new PMTiles(new R2Source(r2, key));
    readers.set(key, pm);
  }
  return pm;
}

// Recently read tiles, per isolate: a popular point (a city centre, a ward
// lookup) asks the same ~15 tiles again and again. Keys are versioned R2 keys,
// so a tile never changes under its key. Bounded by bytes, least recently used out.
const TILE_CACHE_BYTES = 16 * 1024 * 1024;
const tiles = new Map<string, ArrayBuffer | null>();
let tileBytes = 0;

export function clearTileCache(): void {
  tiles.clear();
  tileBytes = 0;
}

/** Tile z/x/y of `pm` (cached; `null` for a tile the archive doesn't have). */
export async function tileAt(
  pm: Pick<PMTiles, 'getZxy'>, key: string, z: number, x: number, y: number,
): Promise<ArrayBuffer | null> {
  const id = `${key}/${z}/${x}/${y}`;
  if (tiles.has(id)) {
    const hit = tiles.get(id)!;
    tiles.delete(id);
    tiles.set(id, hit); // most recently used last
    return hit;
  }
  const data = (await pm.getZxy(z, x, y))?.data ?? null;
  const size = data?.byteLength ?? 0;
  if (size <= TILE_CACHE_BYTES / 4) {
    tiles.set(id, data);
    tileBytes += size;
    for (const [k, v] of tiles) {
      if (tileBytes <= TILE_CACHE_BYTES) break;
      tiles.delete(k);
      tileBytes -= v?.byteLength ?? 0;
    }
  }
  return data;
}

async function queryLayer(
  layer: CatalogLayer,
  z: number,
  lng: number, lat: number,
  r2: R2Bucket,
) {
  const r2Key = r2KeyFromUrl(layer.pmtiles!.url);
  if (!r2Key) throw new Error(`${layer.id}: pmtiles url has no R2 key`);
  const pm = pmtilesFor(r2, r2Key);

  // Use the layer's max zoom if lower than requested
  const header = await pm.getHeader();
  const effectiveZ = Math.min(z, header.maxZoom);
  const { x, y } = lngLatToTile(lng, lat, effectiveZ);

  const data = await tileAt(pm, r2Key, effectiveZ, x, y);
  if (!data) return [];
  return findFeaturesAtPoint(data, effectiveZ, x, y, lng, lat);
}
