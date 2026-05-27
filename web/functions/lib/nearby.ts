import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { R2Source } from './r2-source';
import { lngLatToTile } from './tile-math';
import type { CatalogData, CatalogLayer } from './catalog-api';

export interface NearbyHit {
  properties: Record<string, unknown>;
  _lat: number;
  _lng: number;
  _distance_km: number;
}

export interface NearbyResult {
  center: { lat: number; lng: number };
  radius_km: number;
  zoom_used: number;
  tiles_read: number;
  total: number;
  features: NearbyHit[];
  timing_ms: number;
}

function zoomForRadius(radiusKm: number, lat: number): number {
  const cosLat = Math.cos(lat * Math.PI / 180);
  const targetTileKm = radiusKm / 2;
  const z = Math.floor(Math.log2((40075.017 * cosLat) / targetTileKm));
  return Math.max(4, Math.min(z, 14));
}

function tilesInRadius(lng: number, lat: number, radiusKm: number, zoom: number): { x: number; y: number }[] {
  const { x: cx, y: cy } = lngLatToTile(lng, lat, zoom);
  const n = 2 ** zoom;
  const cosLat = Math.cos(lat * Math.PI / 180);
  const tileKmX = (40075.017 * cosLat) / n;
  const tileKmY = 40075.017 / n;
  const stepsX = Math.ceil(radiusKm / tileKmX);
  const stepsY = Math.ceil(radiusKm / tileKmY);
  const margin = Math.sqrt(tileKmX ** 2 + tileKmY ** 2) / 2;

  const tiles: { x: number; y: number }[] = [];
  for (let dy = -stepsY; dy <= stepsY; dy++) {
    for (let dx = -stepsX; dx <= stepsX; dx++) {
      if (Math.sqrt((dx * tileKmX) ** 2 + (dy * tileKmY) ** 2) > radiusKm + margin) continue;
      const tx = cx + dx, ty = cy + dy;
      if (tx >= 0 && tx < n && ty >= 0 && ty < n) tiles.push({ x: tx, y: ty });
    }
  }
  return tiles;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const JUNK_PROPS = new Set([
  'shape_leng', 'shape_area', 'shape_length', 'shape.starea()', 'shape.stlength()',
  'shape_le_1', 'st_area(shape)', 'st_perimeter(shape)',
  'inpoly_fid', 'simpgnflag', 'maxsimptol', 'minsimptol', 'ogc_fid',
]);

function cleanProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!JUNK_PROPS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function featureCentroid(
  feat: { loadGeometry(): { x: number; y: number }[][]; type: number },
  tileX: number, tileY: number, zoom: number, extent: number,
): [number, number] | null {
  const geom = feat.loadGeometry();
  if (!geom.length || !geom[0].length) return null;

  const size = extent * (2 ** zoom);
  const x0 = extent * tileX;
  const y0 = extent * tileY;

  const ring = feat.type === 1 ? geom.map((r) => r[0]) : geom[0];
  let sumLng = 0, sumLat = 0;
  for (const pt of ring) {
    sumLng += ((pt.x + x0) * 360) / size - 180;
    sumLat += (360 / Math.PI) * Math.atan(Math.exp((1 - ((pt.y + y0) * 2) / size) * Math.PI)) - 90;
  }
  return [sumLng / ring.length, sumLat / ring.length];
}

export async function nearby(
  lat: number, lng: number, radiusKm: number,
  layerId: string, catalog: CatalogData, r2: R2Bucket,
  limit = 50,
): Promise<NearbyResult> {
  const start = Date.now();

  const layer = catalog.layers.find((l) => l.id === layerId);
  if (!layer?.pmtiles) throw new Error(`Layer ${layerId} not found or has no PMTiles`);

  const r2Key = layer.pmtiles.url.replace(/^https:\/\/[^/]+\//, '');
  const source = new R2Source(r2, r2Key);
  const pm = new PMTiles(source);

  const header = await pm.getHeader();
  const effectiveZ = Math.min(zoomForRadius(radiusKm, lat), header.maxZoom);
  const tiles = tilesInRadius(lng, lat, radiusKm, effectiveZ);

  const tileResults = await Promise.allSettled(
    tiles.map(({ x, y }) => pm.getZxy(effectiveZ, x, y)),
  );

  const seen = new Set<string>();
  const hits: NearbyHit[] = [];

  for (let i = 0; i < tiles.length; i++) {
    const result = tileResults[i];
    if (result.status !== 'fulfilled' || !result.value?.data) continue;

    const { x, y } = tiles[i];
    const tile = new VectorTile(new Pbf(result.value.data));

    for (const layerName of Object.keys(tile.layers)) {
      const mvtLayer = tile.layers[layerName];
      for (let f = 0; f < mvtLayer.length; f++) {
        const feat = mvtLayer.feature(f);
        const key = feat.id != null
          ? `${layerName}:${feat.id}`
          : `${layerName}:${JSON.stringify(feat.properties)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const center = featureCentroid(feat, x, y, effectiveZ, mvtLayer.extent);
        if (!center) continue;
        const [fLng, fLat] = center;

        const dist = haversineKm(lat, lng, fLat, fLng);
        if (dist > radiusKm) continue;

        hits.push({
          properties: cleanProps(feat.properties),
          _lat: Math.round(fLat * 10000) / 10000,
          _lng: Math.round(fLng * 10000) / 10000,
          _distance_km: Math.round(dist * 10) / 10,
        });
      }
    }
  }

  hits.sort((a, b) => a._distance_km - b._distance_km);

  return {
    center: { lat, lng },
    radius_km: radiusKm,
    zoom_used: effectiveZ,
    tiles_read: tileResults.filter((r) => r.status === 'fulfilled' && r.value?.data).length,
    total: hits.length,
    features: hits.slice(0, limit),
    timing_ms: Date.now() - start,
  };
}
