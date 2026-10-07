// Parquet-backed /api/v1/nearby. Two paths share the same return shape:
//
//   parquet-bbox   layer has flat xmin/ymin/xmax/ymax cols (ramSeraph re-bake).
//                  Two passes: read only the bbox columns of row groups whose
//                  bbox statistics overlap the query (bounded parallel), rank
//                  by distance, then decode the full columns only for the
//                  winners' row spans.
//                  (One pass decoding every column of every overlapping row
//                  group hit Cloudflare 1102 on Overture places in Delhi.)
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
import { parquetQuery, parquetReadObjects, parquetSchema } from 'hyparquet';
import type { AsyncBuffer, FileMetaData } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { asyncBufferFromR2, cachedMetadata, r2KeyFromLayer } from './parquet-r2';
import { mapConcurrent, R2_CONCURRENCY } from './concurrency';
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
  _truncated?: boolean;
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

// A nearest-row candidate: the row plus its bbox-centre and distance.
// cleanProps() runs only on the K winners, never on every candidate.
export interface BboxWinner {
  row: Record<string, unknown>;
  cLat: number; cLng: number; d: number;
}

function topKByDistance(winners: BboxWinner[], limit: number): BboxWinner[] {
  winners.sort((a, b) => a.d - b.d);
  if (winners.length > limit) winners.length = limit;
  return winners;
}

type Bbox = ReturnType<typeof queryBbox>;
export interface RowSpan { start: number; end: number }

function statNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

/** Row ranges of the row groups whose xmin..ymax statistics overlap `q`.
 *  Only DOUBLE/FLOAT statistics are trusted (DECIMAL ones are raw scaled
 *  integers); a row group without usable statistics is kept. */
export function overlappingRowGroups(metadata: FileMetaData, q: Bbox): RowSpan[] {
  const spans: RowSpan[] = [];
  let start = 0;
  for (const rg of metadata.row_groups) {
    const end = start + Number(rg.num_rows);
    const stat = (name: string, which: 'min' | 'max') => {
      const meta = rg.columns.find((c) => c.meta_data?.path_in_schema.length === 1
        && c.meta_data.path_in_schema[0] === name)?.meta_data;
      if (meta?.type !== 'DOUBLE' && meta?.type !== 'FLOAT') return undefined;
      const st = meta.statistics;
      return statNumber(which === 'min' ? (st?.min_value ?? st?.min) : (st?.max_value ?? st?.max));
    };
    const xmin = stat('xmin', 'min'), xmax = stat('xmax', 'max');
    const ymin = stat('ymin', 'min'), ymax = stat('ymax', 'max');
    const disjoint = (xmin !== undefined && xmin > q.xmax) || (xmax !== undefined && xmax < q.xmin)
      || (ymin !== undefined && ymin > q.ymax) || (ymax !== undefined && ymax < q.ymin);
    if (!disjoint) spans.push({ start, end });
    start = end;
  }
  return spans;
}

/** Nearest `limit` rows within `radiusKm`, by bbox centre. Pass 1 reads only
 *  the bbox columns; pass 2 decodes `cols` for the winners' row spans only. */
export async function nearestRows(
  file: AsyncBuffer, metadata: FileMetaData, cols: string[], geomCol: string,
  lat: number, lng: number, radiusKm: number, limit: number,
): Promise<{ winners: BboxWinner[]; total: number; rowsScanned: number }> {
  type Candidate = { idx: number; span: RowSpan; cLat: number; cLng: number; d: number };
  const spans = overlappingRowGroups(metadata, queryBbox(lat, lng, radiusKm));

  // Pass 1, row groups in parallel (bounded): each group keeps only its own
  // nearest `limit` (the global top K is within their union) and a count.
  const perGroup = await mapConcurrent(spans, R2_CONCURRENCY, async (span) => {
    const rows = await parquetReadObjects({
      file, metadata, compressors, columns: BBOX_COLS, rowStart: span.start, rowEnd: span.end,
    }) as Array<Record<string, unknown>>;
    const inRadius: Candidate[] = [];
    rows.forEach((row, i) => {
      const cLat = (Number(row.ymin) + Number(row.ymax)) / 2;
      const cLng = (Number(row.xmin) + Number(row.xmax)) / 2;
      const d = haversineKm(lat, lng, cLat, cLng);
      if (d <= radiusKm) inRadius.push({ idx: span.start + i, span, cLat, cLng, d });
    });
    const count = inRadius.length;
    inRadius.sort((a, b) => a.d - b.d);
    if (inRadius.length > limit) inRadius.length = limit;
    return { count, top: inRadius, scanned: rows.length };
  });
  const total = perGroup.reduce((n, g) => n + g.count, 0);
  const rowsScanned = perGroup.reduce((n, g) => n + g.scanned, 0);
  const candidates = perGroup.flatMap((g) => g.top).sort((a, b) => a.d - b.d).slice(0, limit);

  // Pass 2: full columns only for the winners' row spans, in parallel.
  const readCols = cols.filter((c) => c !== geomCol);
  const bySpan = [...new Set(candidates.map((c) => c.span))]
    .map((span) => candidates.filter((c) => c.span === span));
  const found = await mapConcurrent(bySpan, R2_CONCURRENCY, async (inSpan) => {
    const lo = Math.min(...inSpan.map((c) => c.idx));
    const hi = Math.max(...inSpan.map((c) => c.idx)) + 1;
    const rows = await parquetReadObjects({
      file, metadata, compressors, columns: readCols, rowStart: lo, rowEnd: hi,
    }) as Array<Record<string, unknown>>;
    return inSpan.map((c): BboxWinner => ({ row: rows[c.idx - lo], cLat: c.cLat, cLng: c.cLng, d: c.d }));
  });
  return { winners: topKByDistance(found.flat(), limit), total, rowsScanned };
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
  const metadata = await cachedMetadata(file);
  // Top-level fields only; a flat schema.slice(1) would false-match struct
  // children like `bbox.{xmin,ymin,xmax,ymax}` as top-level cols.
  const allCols = parquetSchema(metadata).children.map((c) => c.element.name);
  const geomCol = pickGeomCol(allCols);
  if (!geomCol) throw new Error(`Layer ${layerId} parquet has no geometry column`);

  const hasBboxCols = BBOX_COLS.every((c) => allCols.includes(c));
  let rowsScanned: number;
  let skip: Set<string>;
  let total: number;
  let winners: BboxWinner[];

  if (hasBboxCols) {
    const r = await nearestRows(file, metadata, allCols, geomCol, lat, lng, radiusKm, limit);
    skip = new Set([geomCol, 'xmin', 'ymin', 'xmax', 'ymax', 'bbox']);
    winners = r.winners;
    total = r.total;
    rowsScanned = r.rowsScanned;
  } else {
    const bytes = layer.parquet.bytes ?? 0;
    if (bytes > MAX_FULLSCAN_BYTES) {
      throw new Error(
        `Layer ${layerId} parquet is ${Math.round(bytes / 1e6)} MB without spatial bbox columns; ` +
        `full-scan nearby is unavailable until the layer is rebaked with xmin/ymin/xmax/ymax.`,
      );
    }
    const rows = await parquetQuery({
      compressors,
      file,
      columns: allCols,
      rowFormat: 'object',
      geoparquet: false,
    }) as Record<string, unknown>[];
    rowsScanned = rows.length;
    skip = new Set([geomCol]);
    // Scan path computes the centroid from WKB per row (no bbox cols).
    // Same top-K shape as the bbox path; just a different distance source.
    total = 0;
    const allWinners: BboxWinner[] = [];
    for (const row of rows) {
      const c = extractCentroid(row[geomCol]);
      if (!c) continue;
      const [cLng, cLat] = c;
      const d = haversineKm(lat, lng, cLat, cLng);
      if (d > radiusKm) continue;
      total++;
      allWinners.push({ row, cLat, cLng, d });
    }
    winners = topKByDistance(allWinners, limit);
  }

  const features: NearbyHit[] = winners.map((w) => ({
    properties: cleanProps(w.row, skip),
    _lat: round4(w.cLat),
    _lng: round4(w.cLng),
    _distance_km: Math.round(w.d * 10) / 10,
  }));

  return {
    center: { lat, lng },
    radius_km: radiusKm,
    total,
    features,
    timing_ms: Date.now() - start,
    _source: hasBboxCols ? 'parquet-bbox' : 'parquet-scan',
    rows_scanned: rowsScanned,
    _truncated: total > features.length,
  };
}
