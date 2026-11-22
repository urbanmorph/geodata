// Nearest features by TRUE distance to their shapes, for lines and polygons.
//
// /api/v1/nearby (lib/nearby.ts) ranks by distance to each feature's bbox
// centre: right for points, wrong for long lines and big polygons (a 4-degree
// fault or river can pass a point whose bbox centre is 200 km away). This is
// the same two passes with a different measure: pass 1 reads only the bbox
// columns of the row groups that overlap the radius and keeps rows whose bbox
// comes within the radius (a lower bound on the true distance); pass 2 reads
// those rows' shapes and measures the point to the nearest segment (0 inside a
// polygon). Used by /api/v1/ground; nearby itself is unchanged and can move
// over to this separately. A small layer (India's outline: one 5 MB polygon) is
// read whole once per isolate and kept as flat coordinates, not read per call.
import { parquetReadObjects } from 'hyparquet';
import type { AsyncBuffer, FileMetaData } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { openParquet, r2KeyFromLayer } from './parquet-r2';
import { BBOX_COLS, QueryInputError, READ_WINDOW_ROWS, isGeomColumn, readWindows, topLevelColumns } from './parquet-query';
import { mapConcurrent, R2_CONCURRENCY } from './concurrency';
import { chunkRanges, coalesced } from './parquet-coalesce';
import { groupBoxes, overlappingRowGroups, queryBbox } from './nearby';
import { parseWKB } from './wkb-geojson';
import { GIS_ARTEFACT_COLUMNS } from './junk-columns';
import { ResolvedCache } from './isolate-cache';
import type { CatalogData } from './catalog-api';

/** km per degree on the sphere haversineKm uses (R = 6371 km). */
const KM_PER_DEG = (6371 * Math.PI) / 180;
/** Shapes read per call at most, nearest boxes first, unless the caller says otherwise. */
export const MAX_SHAPE_CANDIDATES = 500;

type Coord = [number, number];
type Geo = { type: string; coordinates?: unknown; geometries?: unknown[] };

function geoJSONOf(v: unknown): Geo | null {
  if (v instanceof Uint8Array) return parseWKB(v);
  if (typeof v === 'string') {
    const buf = new Uint8Array(v.length); // utf8-decoded WKB (see wkb-centroid.ts)
    for (let i = 0; i < v.length; i++) buf[i] = v.charCodeAt(i) & 0xff;
    return parseWKB(buf);
  }
  return v && typeof v === 'object' ? (v as Geo) : null;
}

/** A shape as flat x,y coordinates: its polygons (ring lists) and every run of
 *  vertices (each ring and line; a point is a run of one). */
interface ShapeParts { polygons: Float64Array[][]; runs: Float64Array[] }

const flat = (coords: Coord[]): Float64Array => {
  const out = new Float64Array(coords.length * 2);
  coords.forEach(([x, y], i) => { out[2 * i] = x; out[2 * i + 1] = y; });
  return out;
};

function parts(g: Geo | null, out: ShapeParts = { polygons: [], runs: [] }): ShapeParts {
  if (!g) return out;
  if (g.type === 'GeometryCollection') {
    for (const sub of g.geometries ?? []) parts(geoJSONOf(sub), out);
    return out;
  }
  const c = g.coordinates as unknown;
  const polygon = (rings: Coord[][]) => { const r = rings.map(flat); out.polygons.push(r); out.runs.push(...r); };
  if (g.type === 'Point') out.runs.push(flat([c as Coord]));
  else if (g.type === 'MultiPoint') out.runs.push(...(c as Coord[]).map((p) => flat([p])));
  else if (g.type === 'LineString') out.runs.push(flat(c as Coord[]));
  else if (g.type === 'MultiLineString') out.runs.push(...(c as Coord[][]).map(flat));
  else if (g.type === 'Polygon') polygon(c as Coord[][]);
  else if (g.type === 'MultiPolygon') for (const poly of c as Coord[][][]) polygon(poly);
  return out;
}

/** A geometry (GeoJSON or WKB) as flat parts, or null when it can't be read. */
function shapeParts(geometry: unknown): ShapeParts | null {
  try { return parts(geoJSONOf(geometry)); } catch { return null; }
}

/** Ray casting over a flat ring (point-in-polygon.ts, on x,y pairs). */
function ringContains(px: number, py: number, ring: Float64Array): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i], yi = ring[2 * i + 1], xj = ring[2 * j], yj = ring[2 * j + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (x: number, y: number, rings: Float64Array[]) =>
  ringContains(x, y, rings[0]) && !rings.slice(1).some((hole) => ringContains(x, y, hole));

/** closestOnGeometry over parts already read. */
function closestOnParts(lat: number, lng: number, { polygons, runs }: ShapeParts, edge = false): { km: number; lat: number; lng: number } | null {
  if (!edge && polygons.some((rings) => inPolygon(lng, lat, rings))) return { km: 0, lat, lng };
  const kx = KM_PER_DEG * Math.cos((lat * Math.PI) / 180), ky = KM_PER_DEG;
  let best = Infinity, bx = 0, by = 0;
  const consider = (x: number, y: number) => {
    const d2 = x * x + y * y;
    if (d2 < best) { best = d2; bx = x; by = y; }
  };
  for (const run of runs) {
    let ax = (run[0] - lng) * kx, ay = (run[1] - lat) * ky;
    if (run.length === 2) consider(ax, ay);
    for (let i = 2; i < run.length; i += 2) {
      const px = (run[i] - lng) * kx, py = (run[i + 1] - lat) * ky;
      const dx = px - ax, dy = py - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      consider(ax + t * dx, ay + t * dy);
      ax = px; ay = py;
    }
  }
  if (!Number.isFinite(best)) return null;
  return { km: Math.sqrt(best), lat: lat + by / ky, lng: lng + bx / kx };
}

/** The point of a shape nearest to lat/lng and its distance (km; 0 inside a polygon unless
 *  `edge`, which measures to the outline), on a local flat projection, or null for no readable shape. */
export function closestOnGeometry(lat: number, lng: number, geometry: unknown, edge = false): { km: number; lat: number; lng: number } | null {
  const p = shapeParts(geometry);
  return p && closestOnParts(lat, lng, p, edge);
}

type Box = { xmin: number; ymin: number; xmax: number; ymax: number };

/** Distance (km) from the point to a bbox: 0 inside, a lower bound on the distance to the shape. */
export function bboxDistanceKm(lat: number, lng: number, b: Box): number {
  const dx = Math.max(b.xmin - lng, 0, lng - b.xmax) * KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const dy = Math.max(b.ymin - lat, 0, lat - b.ymax) * KM_PER_DEG;
  return Math.hypot(dx, dy);
}

/** limit: features returned; maxCandidates: shapes read at most; edge: measure to the
 *  outline from inside a polygon; keep: only rows it keeps count. */
export interface NearestShapeOpts {
  limit: number;
  maxCandidates?: number;
  edge?: boolean;
  keep?: (properties: Record<string, unknown>) => boolean;
}

export interface GeomHit {
  properties: Record<string, unknown>;
  /** The nearest point of the shape (the query point itself when inside a polygon). */
  lat: number;
  lng: number;
  distance_km: number;
}

/** Features nearest first; `total` counts every shape read within the radius; `capped`:
 *  some candidates were not read, so `total` may be short. */
export interface ShapeAnswer { features: GeomHit[]; total: number; capped: boolean }

const round = (n: number, p: number) => Math.round(n * 10 ** p) / 10 ** p;

const boxOf = (b: Record<string, unknown>): Box => ({ xmin: Number(b.xmin), ymin: Number(b.ymin), xmax: Number(b.xmax), ymax: Number(b.ymax) });

/** Rows whose box comes within the radius, nearest box first, at most `maxCandidates`, back
 *  in row order; and whether some were left out. */
function pickCandidates(near: Array<{ idx: number; d: number }>, opts: NearestShapeOpts): { idxs: number[]; capped: boolean } {
  const max = opts.maxCandidates ?? MAX_SHAPE_CANDIDATES;
  const all = near.sort((a, b) => a.d - b.d);
  return { idxs: all.slice(0, max).map((c) => c.idx).sort((a, b) => a - b), capped: all.length > max };
}

/** A row's properties: no geometry or bbox columns, text bytes as text. */
function propertiesOf(row: Record<string, unknown>, skip: Set<string>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (skip.has(k) || GIS_ARTEFACT_COLUMNS.has(k.toLowerCase())) continue;
    properties[k] = v instanceof Uint8Array ? new TextDecoder().decode(v) : v;
  }
  return properties;
}

/** The hit for one shape, or null when it is past the radius or `keep` drops it. */
function hitOf(lat: number, lng: number, radiusKm: number, shape: ShapeParts | null, properties: Record<string, unknown>, opts: NearestShapeOpts): GeomHit | null {
  const near = shape && closestOnParts(lat, lng, shape, opts.edge);
  if (!near || near.km > radiusKm) return null;
  if (opts.keep && !opts.keep(properties)) return null;
  return { properties, lat: round(near.lat, 5), lng: round(near.lng, 5), distance_km: round(near.km, 2) };
}

function answer(found: Array<GeomHit | null>, limit: number, capped: boolean): ShapeAnswer {
  const hits = found.filter((h): h is GeomHit => !!h).sort((a, b) => a.distance_km - b.distance_km);
  return { features: hits.slice(0, limit), total: hits.length, capped };
}

function columnsOf(metadata: FileMetaData): { cols: string[]; geomCol: string } {
  const cols = topLevelColumns(metadata).map((c) => c.name);
  const geomCol = cols.find(isGeomColumn);
  if (!geomCol || !BBOX_COLS.every((c) => cols.includes(c))) {
    throw new QueryInputError('true-distance search needs a geometry column and flat xmin/ymin/xmax/ymax columns');
  }
  return { cols, geomCol };
}
const skipOf = (geomCol: string) => new Set([geomCol, ...BBOX_COLS, 'bbox']);

/** Features within radiusKm by true distance (candidates: rows whose box is within it). */
export async function nearestByGeometry(
  file: AsyncBuffer, metadata: FileMetaData, lat: number, lng: number, radiusKm: number,
  opts: NearestShapeOpts,
): Promise<ShapeAnswer> {
  const { cols, geomCol } = columnsOf(metadata);
  const spans = overlappingRowGroups(metadata, queryBbox(lat, lng, radiusKm));
  const boxes = await groupBoxes(file, metadata, spans);
  const near: Array<{ idx: number; d: number }> = [];
  spans.forEach((span, g) => {
    const b = boxes[g];
    for (let i = 0; i < b.xmin.length; i++) {
      const d = bboxDistanceKm(lat, lng, { xmin: b.xmin[i], ymin: b.ymin[i], xmax: b.xmax[i], ymax: b.ymax[i] });
      if (d <= radiusKm) near.push({ idx: span.start + i, d });
    }
  });
  const { idxs: candidates, capped } = pickCandidates(near, opts);

  const skip = skipOf(geomCol);
  const windows = readWindows(candidates, READ_WINDOW_ROWS);
  const rowFile = coalesced(file, windows.flatMap((w) => chunkRanges(metadata, cols, w[0], w[w.length - 1] + 1)));
  const found = await mapConcurrent(windows, R2_CONCURRENCY, async (idxs) => {
    const lo = idxs[0];
    const rows = await parquetReadObjects({
      file: rowFile, metadata, compressors, columns: cols, rowStart: lo, rowEnd: idxs[idxs.length - 1] + 1,
      utf8: false, // a geometry column without GeoParquet metadata stays WKB bytes (utf8 text would be lossy)
    }) as Array<Record<string, unknown>>;
    return idxs.map((i) => hitOf(lat, lng, radiusKm, shapeParts(rows[i - lo][geomCol]), propertiesOf(rows[i - lo], skip), opts));
  });
  return answer(found.flat(), opts.limit, capped);
}

// ── small layers, kept whole ─────────────────────────────────────────────────

/** A parquet this small is read whole once per isolate and kept parsed. */
const WHOLE_LAYER_MAX_BYTES = 8_000_000;
type ShapeRow = { box: Box; shape: ShapeParts | null; properties: Record<string, unknown> };
const shapeRows = new ResolvedCache<ShapeRow[]>(4);

export function clearShapeCache(): void {
  shapeRows.clear();
}

async function readShapeRows(file: AsyncBuffer, metadata: FileMetaData): Promise<ShapeRow[]> {
  const { cols, geomCol } = columnsOf(metadata);
  const skip = skipOf(geomCol);
  const rows = await parquetReadObjects({ file, metadata, compressors, columns: cols, utf8: false }) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ box: boxOf(r), shape: shapeParts(r[geomCol]), properties: propertiesOf(r, skip) }));
}

/** nearestByGeometry over rows kept in memory: the same candidates, the same answer. */
function nearestInShapeRows(rows: ShapeRow[], lat: number, lng: number, radiusKm: number, opts: NearestShapeOpts): ShapeAnswer {
  const near: Array<{ idx: number; d: number }> = [];
  rows.forEach((r, idx) => {
    const d = bboxDistanceKm(lat, lng, r.box);
    if (d <= radiusKm) near.push({ idx, d });
  });
  const { idxs, capped } = pickCandidates(near, opts);
  const hits = idxs.map((i) => hitOf(lat, lng, radiusKm, rows[i].shape, { ...rows[i].properties }, opts));
  return answer(hits, opts.limit, capped);
}

/** nearestByGeometry over a catalog layer's parquet on R2 (a small one kept whole per isolate). */
export async function nearbyByGeometry(
  lat: number, lng: number, radiusKm: number, layerId: string, catalog: CatalogData, r2: R2Bucket,
  opts: NearestShapeOpts,
): Promise<ShapeAnswer> {
  const layer = catalog.layers.find((l) => l.id === layerId);
  const key = layer && r2KeyFromLayer(layer);
  if (!key) throw new QueryInputError(`Layer ${layerId} has no parquet`);
  const { file, metadata } = await openParquet(r2, key);
  if (file.byteLength > WHOLE_LAYER_MAX_BYTES || !file.cacheKey) return nearestByGeometry(file, metadata, lat, lng, radiusKm, opts);
  const rows = await shapeRows.get(file.cacheKey, () => readShapeRows(file, metadata), file);
  return nearestInShapeRows(rows, lat, lng, radiusKm, opts);
}
