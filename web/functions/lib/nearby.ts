// Parquet-backed /api/v1/nearby. Two paths share the same return shape:
//
//   parquet-bbox   layer has flat xmin/ymin/xmax/ymax cols (ramSeraph re-bake).
//                  hyparquet skips row groups whose bbox is wholly outside the
//                  query bbox; only matching rows are read.
//
//   parquet-scan   no bbox cols. We read the full file once, parse WKB to a
//                  centroid per row, then haversine-filter. Guarded by
//                  MAX_FULLSCAN_BYTES so we never try this on a layer that
//                  wouldn't fit Workers' CPU budget — those layers throw and
//                  the caller hears about it instead of timing out.
//
// The PMTiles-based path that lived here through PR #83 is gone: pmtiles drop
// features at lower zooms (designed for display), which gave wrong results on
// dense layers like hospitals and POIs. See issue #100.
import { parquetMetadataAsync, parquetQuery, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { asyncBufferFromR2, r2KeyFromLayer } from './parquet-r2';
import { extractCentroid } from './wkb-centroid';
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
  total: number;
  features: NearbyHit[];
  timing_ms: number;
  _source: 'parquet-bbox' | 'parquet-scan';
  rows_scanned: number;
}

const KM_PER_DEG_LAT = 111.32;
const BBOX_COLS = ['xmin', 'ymin', 'xmax', 'ymax'];
const MAX_FULLSCAN_BYTES = 200 * 1024 * 1024;

const JUNK_PROPS = new Set([
  'shape_leng', 'shape_area', 'shape_length', 'shape.starea()', 'shape.stlength()',
  'shape_le_1', 'st_area(shape)', 'st_perimeter(shape)',
  'inpoly_fid', 'simpgnflag', 'maxsimptol', 'minsimptol', 'ogc_fid',
]);

export function queryBbox(lat: number, lng: number, radiusKm: number) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
  return { xmin: lng - dLng, ymin: lat - dLat, xmax: lng + dLng, ymax: lat + dLat };
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pickGeomCol(cols: string[]): string | null {
  for (const c of ['geometry', 'wkb_geometry', 'geom']) if (cols.includes(c)) return c;
  return cols.find((c) => c.toLowerCase().includes('geom')) ?? null;
}

function cleanProps(row: Record<string, unknown>, skip: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    if (skip.has(k) || JUNK_PROPS.has(k.toLowerCase())) continue;
    out[k] = row[k];
  }
  return out;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export async function nearby(
  lat: number, lng: number, radiusKm: number,
  layerId: string, catalog: CatalogData, r2: R2Bucket,
  limit = 50,
): Promise<NearbyResult> {
  const start = Date.now();

  const layer = catalog.layers.find((l) => l.id === layerId) as CatalogLayer | undefined;
  if (!layer) throw new Error(`Layer ${layerId} not found`);
  if (!layer.parquet) {
    throw new Error(`Layer ${layerId} has no parquet — nearby unsupported (only layers with geometry can be queried)`);
  }

  const r2Key = r2KeyFromLayer(layer);
  if (!r2Key) throw new Error(`Layer ${layerId} has no R2 parquet key`);

  const file = await asyncBufferFromR2(r2, r2Key);
  const metadata = await parquetMetadataAsync(file);
  // Top-level fields only; a flat schema.slice(1) would false-match struct
  // children like `bbox.{xmin,ymin,xmax,ymax}` as top-level cols.
  const allCols = parquetSchema(metadata).children.map((c) => c.element.name);
  const geomCol = pickGeomCol(allCols);
  if (!geomCol) throw new Error(`Layer ${layerId} parquet has no geometry column`);

  const hasBboxCols = BBOX_COLS.every((c) => allCols.includes(c));
  const qbbox = queryBbox(lat, lng, radiusKm);
  const hits: NearbyHit[] = [];
  let rows: Record<string, unknown>[];
  let skip: Set<string>;

  if (hasBboxCols) {
    rows = await parquetQuery({
      compressors,
      file,
      columns: allCols.filter((c) => c !== geomCol),
      rowFormat: 'object',
      geoparquet: false,
      filter: {
        $and: [
          { xmin: { $lte: qbbox.xmax } },
          { xmax: { $gte: qbbox.xmin } },
          { ymin: { $lte: qbbox.ymax } },
          { ymax: { $gte: qbbox.ymin } },
        ],
      },
    }) as Record<string, unknown>[];
    skip = new Set([geomCol, 'xmin', 'ymin', 'xmax', 'ymax', 'bbox']);
    for (const row of rows) {
      const cLat = (Number(row.ymin) + Number(row.ymax)) / 2;
      const cLng = (Number(row.xmin) + Number(row.xmax)) / 2;
      const d = haversineKm(lat, lng, cLat, cLng);
      if (d > radiusKm) continue;
      hits.push({
        properties: cleanProps(row, skip),
        _lat: round4(cLat),
        _lng: round4(cLng),
        _distance_km: Math.round(d * 10) / 10,
      });
    }
  } else {
    const bytes = layer.parquet.bytes ?? 0;
    if (bytes > MAX_FULLSCAN_BYTES) {
      throw new Error(
        `Layer ${layerId} parquet is ${Math.round(bytes / 1e6)} MB without spatial bbox columns; ` +
        `full-scan nearby is unavailable until the layer is rebaked with xmin/ymin/xmax/ymax.`,
      );
    }
    rows = await parquetQuery({
      compressors,
      file,
      columns: allCols,
      rowFormat: 'object',
      geoparquet: false,
    }) as Record<string, unknown>[];
    skip = new Set([geomCol]);
    for (const row of rows) {
      const c = extractCentroid(row[geomCol]);
      if (!c) continue;
      const [cLng, cLat] = c;
      const d = haversineKm(lat, lng, cLat, cLng);
      if (d > radiusKm) continue;
      hits.push({
        properties: cleanProps(row, skip),
        _lat: round4(cLat),
        _lng: round4(cLng),
        _distance_km: Math.round(d * 10) / 10,
      });
    }
  }

  hits.sort((a, b) => a._distance_km - b._distance_km);

  return {
    center: { lat, lng },
    radius_km: radiusKm,
    total: hits.length,
    features: hits.slice(0, limit),
    timing_ms: Date.now() - start,
    _source: hasBboxCols ? 'parquet-bbox' : 'parquet-scan',
    rows_scanned: rows.length,
  };
}
