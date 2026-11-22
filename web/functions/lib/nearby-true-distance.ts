// /api/v1/nearby by true distance (plan A1). nearby() ranks by each feature's
// bbox centre: right for points, wrong for lines and large polygons (a river that
// passes 1.5 km from Kolkata has its centre hundreds of km away). Here a layer
// whose candidates have an extent is measured to the shape instead, with the
// helpers /ground and /surface use:
//
//   parquet-shape  the shapes the search needs are small (at most
//                  PARQUET_SHAPE_BYTES of geometry): read from the parquet, exact.
//   tiles-shape    heavier (wris_rivers keeps 34 MB of geometry in each row
//                  group): measured on the layer's map tiles, then each hit's
//                  every column read from the parquet row that matches it (the
//                  tiles keep only popup fields; columns other than geometry are
//                  small to read).
//
// A point layer takes nearby() unchanged. The answer keeps nearby's shape, plus
// `_distance_to` (point or shape) and `_approximate` when the search had to read
// fewer shapes or coarser tiles than it wanted (distances to within tens of
// metres; the count may be short).
import type { FileMetaData } from 'hyparquet';
import type { CatalogData } from './catalog-api';
import { openParquet, r2KeyFromLayer } from './parquet-r2';
import { BBOX_COLS, isGeomColumn, topLevelColumns } from './parquet-query';
import {
  cleanProps, groupBoxes, nearby, overlappingRowGroups, queryBbox, readRowsAt,
  type GroupBoxes, type NearbyHit, type NearbyResult, type RowSpan,
} from './nearby';
import { bboxDistanceKm, nearestByGeometry, type GeomHit } from './nearby-geometry';
import { nearbyFromTiles } from './nearby-tiles';

/** Most geometry (compressed bytes, over the row groups the search touches) read from the parquet.
 *  Measured 22 Nov 2026 on a preview: at 8 MB, soi_forests (7.7 MB of polygons a row group) ran
 *  out of CPU (Cloudflare 1102) at Delhi, Leh and Lucknow, and lgd_villages at Port Blair. */
export const PARQUET_SHAPE_BYTES = 2_000_000;
/** Most parquet rows read to give tile hits their full columns. */
const MAX_JOIN_ROWS = 2000;

export interface TrueDistanceResult extends Omit<NearbyResult, '_source'> {
  _source: NearbyResult['_source'] | 'parquet-shape' | 'tiles-shape';
  _distance_to: 'point' | 'shape' | 'centroid';
  _approximate?: true;
}

export interface TrueDistanceOpts {
  /** Geometry bytes the parquet path may read (tests set 0 to take the tile path). */
  parquetShapeBytes?: number;
}

type Candidate = { idx: number; box: { xmin: number; ymin: number; xmax: number; ymax: number }; d: number };

/** Rows whose bbox comes within the radius (a lower bound on their true distance). */
function candidatesOf(spans: RowSpan[], boxes: GroupBoxes[], lat: number, lng: number, radiusKm: number): Candidate[] {
  const out: Candidate[] = [];
  spans.forEach((span, g) => {
    const b = boxes[g];
    for (let i = 0; i < b.xmin.length; i++) {
      const box = { xmin: b.xmin[i], ymin: b.ymin[i], xmax: b.xmax[i], ymax: b.ymax[i] };
      const d = bboxDistanceKm(lat, lng, box);
      if (d <= radiusKm) out.push({ idx: span.start + i, box, d });
    }
  });
  return out;
}

/** Whether any row of these row groups has an extent (a line or polygon); a point layer has none. */
function anyExtent(boxes: GroupBoxes[]): boolean {
  for (const b of boxes) for (let i = 0; i < b.xmin.length; i++) if (b.xmax[i] > b.xmin[i] || b.ymax[i] > b.ymin[i]) return true;
  return false;
}

/** Compressed geometry bytes of the row groups that hold these rows. */
function geometryBytes(metadata: FileMetaData, geomCol: string, rows: Candidate[]): number {
  let start = 0, bytes = 0;
  const idxs = rows.map((r) => r.idx).sort((a, b) => a - b);
  let k = 0;
  for (const rg of metadata.row_groups) {
    const end = start + Number(rg.num_rows);
    if (k < idxs.length && idxs[k] < end) {
      const col = rg.columns.find((c) => c.meta_data?.path_in_schema[0] === geomCol);
      bytes += Number(col?.meta_data?.total_compressed_size ?? 0);
      while (k < idxs.length && idxs[k] < end) k++;
    }
    start = end;
  }
  return bytes;
}

const sameValue = (a: unknown, b: unknown) => {
  if (a === b) return true;
  const x = Number(a), y = Number(b);
  if (a !== null && b !== null && a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x));
  return String(a) === String(b);
};

/** Candidates whose bbox holds the hit's nearest point, within the tiles' precision. */
const holding = (h: GeomHit, cands: Candidate[], tolDeg: number) => cands.filter(({ box: b }) =>
  h.lng >= b.xmin - tolDeg && h.lng <= b.xmax + tolDeg && h.lat >= b.ymin - tolDeg && h.lat <= b.ymax + tolDeg);

/** The row a tile hit came from: the first of its candidates whose columns match the tile's fields. */
function matchRow(hit: GeomHit, cands: Candidate[], rows: Map<number, Record<string, unknown>>): Record<string, unknown> | null {
  const keys = Object.keys(hit.properties);
  for (const c of cands) {
    const row = rows.get(c.idx);
    if (row && keys.every((k) => !(k in row) || sameValue(row[k], hit.properties[k]))) return row;
  }
  return null;
}

const toHit = (properties: Record<string, unknown>, g: GeomHit): NearbyHit =>
  ({ properties, _lat: g.lat, _lng: g.lng, _distance_km: g.distance_km });

/** nearby(), measured to the shape for layers whose features have an extent. */
export async function nearbyTrueDistance(
  lat: number, lng: number, radiusKm: number, layerId: string, catalog: CatalogData, r2: R2Bucket,
  limit = 50, opts: TrueDistanceOpts = {},
): Promise<TrueDistanceResult> {
  const start = Date.now();
  const layer = catalog.layers.find((l) => l.id === layerId);
  const key = layer && r2KeyFromLayer(layer);
  const byNearby = async (to: 'point' | 'centroid'): Promise<TrueDistanceResult> =>
    ({ ...(await nearby(lat, lng, radiusKm, layerId, catalog, r2, limit)), _distance_to: to });
  if (!key) return byNearby('point'); // nearby() says why

  const { file, metadata } = await openParquet(r2, key);
  const allCols = topLevelColumns(metadata).map((c) => c.name);
  const geomCol = allCols.find(isGeomColumn);
  // No bbox columns: nearby() scans the whole (small) file and measures to each feature's centre.
  if (!geomCol || !BBOX_COLS.every((c) => allCols.includes(c))) return byNearby('centroid');

  const spans = overlappingRowGroups(metadata, queryBbox(lat, lng, radiusKm));
  const boxes = await groupBoxes(file, metadata, spans); // cached: nearby() reuses them for a point layer
  if (!anyExtent(boxes)) return byNearby('point');
  const cands = candidatesOf(spans, boxes, lat, lng, radiusKm);

  const done = (source: TrueDistanceResult['_source'], features: NearbyHit[], total: number, approximate: boolean, scanned: number): TrueDistanceResult => ({
    center: { lat, lng }, radius_km: radiusKm, total, features, timing_ms: Date.now() - start,
    _source: source, rows_scanned: scanned, _truncated: total > features.length, _distance_to: 'shape',
    ...(approximate ? { _approximate: true as const } : {}),
  });

  const maxBytes = opts.parquetShapeBytes ?? PARQUET_SHAPE_BYTES;
  if (!layer.pmtiles?.url || geometryBytes(metadata, geomCol, cands) <= maxBytes) {
    const g = await nearestByGeometry(file, metadata, lat, lng, radiusKm, { limit });
    return done('parquet-shape', g.features.map((f) => toHit(f.properties, f)), g.total, g.capped, cands.length);
  }

  const t = await nearbyFromTiles(lat, lng, radiusKm, layerId, catalog, r2, { limit });
  // Full columns: the attribute columns (not the geometry) of the rows that could be each hit.
  // Tiles quantise to 1/4096 of a tile; 16 such pixels at z12 (about 20 m) covers that and
  // tippecanoe's simplification, a coarser zoom gets 0.002 degrees. A hit no row matches keeps the tile's fields.
  const tolDeg = t.capped ? 0.002 : (360 / 2 ** 12 / 4096) * 16;
  const perHit = t.features.map((h) => holding(h, cands, tolDeg));
  const idxs = [...new Set(perHit.flat().map((c) => c.idx))].slice(0, MAX_JOIN_ROWS);
  const rows = idxs.length ? await readRowsAt(file, metadata, allCols.filter((c) => c !== geomCol), idxs) : new Map();
  const skip = new Set([geomCol, ...BBOX_COLS, 'bbox']);
  const features = t.features.map((h, i) => {
    const row = matchRow(h, perHit[i], rows);
    return toHit(row ? cleanProps(row, skip) : h.properties, h);
  });
  return done('tiles-shape', features, t.total, t.capped, cands.length);
}
