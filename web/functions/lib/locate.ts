import { PMTiles } from 'pmtiles';
import { R2Source } from './r2-source';
import { lngLatToTile } from './tile-math';
import { findFeaturesAtPoint } from './mvt-locate';
import type { CatalogData, CatalogLayer } from './catalog-api';

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
  for (let i = 0; i < layers.length; i++) {
    const s = settled[i];
    if (s.status !== 'fulfilled' || !s.value.length) continue;
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

async function queryLayer(
  layer: CatalogLayer,
  z: number,
  lng: number, lat: number,
  r2: R2Bucket,
) {
  const pmtilesUrl = layer.pmtiles!.url;
  const r2Key = pmtilesUrl.replace(/^https:\/\/[^/]+\//, '');
  const pm = pmtilesFor(r2, r2Key);

  // Use the layer's max zoom if lower than requested
  const header = await pm.getHeader();
  const effectiveZ = Math.min(z, header.maxZoom);
  const { x, y } = lngLatToTile(lng, lat, effectiveZ);

  const tileData = await pm.getZxy(effectiveZ, x, y);
  if (!tileData?.data) return [];
  return findFeaturesAtPoint(tileData.data, effectiveZ, x, y, lng, lat);
}
