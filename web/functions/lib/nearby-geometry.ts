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
// over to this separately.
import { parquetReadObjects } from 'hyparquet';
import type { AsyncBuffer, FileMetaData } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { asyncBufferFromR2, cachedMetadata, r2KeyFromLayer } from './parquet-r2';
import { BBOX_COLS, QueryInputError, READ_WINDOW_ROWS, isGeomColumn, readWindows, topLevelColumns } from './parquet-query';
import { mapConcurrent, R2_CONCURRENCY } from './concurrency';
import { overlappingRowGroups, queryBbox } from './nearby';
import { parseWKB } from './wkb-geojson';
import { pointInPolygon } from './point-in-polygon';
import { GIS_ARTEFACT_COLUMNS } from './junk-columns';
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

/** Polygons as ring lists, and every run of vertices (a point is a run of one). */
function parts(g: Geo | null): { polygons: Coord[][][]; runs: Coord[][] } {
  const out = { polygons: [] as Coord[][][], runs: [] as Coord[][] };
  if (!g) return out;
  if (g.type === 'GeometryCollection') {
    for (const sub of g.geometries ?? []) {
      const p = parts(geoJSONOf(sub));
      out.polygons.push(...p.polygons);
      out.runs.push(...p.runs);
    }
    return out;
  }
  const c = g.coordinates as unknown;
  if (g.type === 'Point') out.runs.push([c as Coord]);
  else if (g.type === 'MultiPoint') out.runs.push(...(c as Coord[]).map((p) => [p]));
  else if (g.type === 'LineString') out.runs.push(c as Coord[]);
  else if (g.type === 'MultiLineString') out.runs.push(...(c as Coord[][]));
  else if (g.type === 'Polygon') { out.polygons.push(c as Coord[][]); out.runs.push(...(c as Coord[][])); }
  else if (g.type === 'MultiPolygon') for (const poly of c as Coord[][][]) { out.polygons.push(poly); out.runs.push(...poly); }
  return out;
}

/** The point of a shape nearest to lat/lng and its distance (km; 0 inside a polygon),
 *  on a local flat projection, or null for no readable shape. */
export function closestOnGeometry(lat: number, lng: number, geometry: unknown): { km: number; lat: number; lng: number } | null {
  let g: Geo | null;
  try { g = geoJSONOf(geometry); } catch { return null; }
  const { polygons, runs } = parts(g);
  if (polygons.some((rings) => pointInPolygon([lng, lat], rings))) return { km: 0, lat, lng };
  const kx = KM_PER_DEG * Math.cos((lat * Math.PI) / 180), ky = KM_PER_DEG;
  let best = { d2: Infinity, x: 0, y: 0 };
  const consider = (x: number, y: number) => {
    const d2 = x * x + y * y;
    if (d2 < best.d2) best = { d2, x, y };
  };
  for (const run of runs) {
    const pts = run.map(([x, y]) => [(x - lng) * kx, (y - lat) * ky]);
    if (pts.length === 1) consider(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      consider(ax + t * dx, ay + t * dy);
    }
  }
  if (!Number.isFinite(best.d2)) return null;
  return { km: Math.sqrt(best.d2), lat: lat + best.y / ky, lng: lng + best.x / kx };
}

/** Distance (km) from the point to a bbox: 0 inside, a lower bound on the distance to the shape. */
export function bboxDistanceKm(lat: number, lng: number, b: { xmin: number; ymin: number; xmax: number; ymax: number }): number {
  const dx = Math.max(b.xmin - lng, 0, lng - b.xmax) * KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const dy = Math.max(b.ymin - lat, 0, lat - b.ymax) * KM_PER_DEG;
  return Math.hypot(dx, dy);
}

export interface GeomHit {
  properties: Record<string, unknown>;
  /** The nearest point of the shape (the query point itself when inside a polygon). */
  lat: number;
  lng: number;
  distance_km: number;
}

const round = (n: number, p: number) => Math.round(n * 10 ** p) / 10 ** p;

/** Features within radiusKm by true distance, nearest first. `total` counts every
 *  shape read that is within the radius; `capped` says some candidates (boxes
 *  within the radius) were not read, so `total` may be short. */
export async function nearestByGeometry(
  file: AsyncBuffer, metadata: FileMetaData, lat: number, lng: number, radiusKm: number,
  opts: { limit: number; maxCandidates?: number },
): Promise<{ features: GeomHit[]; total: number; capped: boolean }> {
  const cols = topLevelColumns(metadata).map((c) => c.name);
  const geomCol = cols.find(isGeomColumn);
  if (!geomCol || !BBOX_COLS.every((c) => cols.includes(c))) {
    throw new QueryInputError('true-distance search needs a geometry column and flat xmin/ymin/xmax/ymax columns');
  }
  const spans = overlappingRowGroups(metadata, queryBbox(lat, lng, radiusKm));
  const perGroup = await mapConcurrent(spans, R2_CONCURRENCY, async (span) => {
    const rows = await parquetReadObjects({
      file, metadata, compressors, columns: [...BBOX_COLS], rowStart: span.start, rowEnd: span.end,
    }) as Array<{ xmin: number; ymin: number; xmax: number; ymax: number }>;
    const near: Array<{ idx: number; d: number }> = [];
    rows.forEach((b, i) => {
      const d = bboxDistanceKm(lat, lng, { xmin: Number(b.xmin), ymin: Number(b.ymin), xmax: Number(b.xmax), ymax: Number(b.ymax) });
      if (d <= radiusKm) near.push({ idx: span.start + i, d });
    });
    return near;
  });
  const max = opts.maxCandidates ?? MAX_SHAPE_CANDIDATES;
  const all = perGroup.flat().sort((a, b) => a.d - b.d);
  const candidates = all.slice(0, max).map((c) => c.idx).sort((a, b) => a - b);

  const skip = new Set([geomCol, ...BBOX_COLS, 'bbox']);
  const found = await mapConcurrent(readWindows(candidates, READ_WINDOW_ROWS), R2_CONCURRENCY, async (idxs) => {
    const lo = idxs[0];
    const rows = await parquetReadObjects({
      file, metadata, compressors, columns: cols, rowStart: lo, rowEnd: idxs[idxs.length - 1] + 1,
      utf8: false, // a geometry column without GeoParquet metadata stays WKB bytes (utf8 text would be lossy)
    }) as Array<Record<string, unknown>>;
    return idxs.flatMap((i): GeomHit[] => {
      const row = rows[i - lo];
      const near = closestOnGeometry(lat, lng, row[geomCol]);
      if (!near || near.km > radiusKm) return [];
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (skip.has(k) || GIS_ARTEFACT_COLUMNS.has(k.toLowerCase())) continue;
        properties[k] = v instanceof Uint8Array ? new TextDecoder().decode(v) : v;
      }
      return [{ properties, lat: round(near.lat, 5), lng: round(near.lng, 5), distance_km: round(near.km, 2) }];
    });
  });
  const hits = found.flat().sort((a, b) => a.distance_km - b.distance_km);
  return { features: hits.slice(0, opts.limit), total: hits.length, capped: all.length > max };
}

/** nearestByGeometry over a catalog layer's parquet on R2. */
export async function nearbyByGeometry(
  lat: number, lng: number, radiusKm: number, layerId: string, catalog: CatalogData, r2: R2Bucket,
  opts: { limit: number; maxCandidates?: number },
): Promise<{ features: GeomHit[]; total: number; capped: boolean }> {
  const layer = catalog.layers.find((l) => l.id === layerId);
  const key = layer && r2KeyFromLayer(layer);
  if (!key) throw new QueryInputError(`Layer ${layerId} has no parquet`);
  const file = await asyncBufferFromR2(r2, key);
  return nearestByGeometry(file, await cachedMetadata(file), lat, lng, radiusKm, opts);
}
