// Reject any geometry with a vertex outside India. Mirrors web's check in
// api/v1/locate (lat 6-38, lng 68-98); a record is rejected whole on any
// out-of-range vertex (spec → "POST /collections/:id/records", step 1).

export const INDIA_BBOX = [68, 6, 98, 38] as const; // [minLng, minLat, maxLng, maxLat]
const [MIN_LNG, MIN_LAT, MAX_LNG, MAX_LAT] = INDIA_BBOX;

export type BoundsResult = { ok: true } | { ok: false; error: string };

const OUT_OF_RANGE = 'lat must be 6-38, lng must be 68-98 (India bounding box)';
const MALFORMED = 'invalid geometry';

const SIMPLE = new Set([
  'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon',
]);

function isPair(node: unknown): node is [number, number, ...number[]] {
  return Array.isArray(node) && node.length >= 2
    && typeof node[0] === 'number' && typeof node[1] === 'number';
}

export function checkIndiaBounds(geometry: unknown): BoundsResult {
  if (!geometry || typeof geometry !== 'object') return { ok: false, error: MALFORMED };
  const g = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (typeof g.type !== 'string') return { ok: false, error: MALFORMED };

  if (g.type === 'GeometryCollection') {
    if (!Array.isArray(g.geometries) || g.geometries.length === 0) return { ok: false, error: MALFORMED };
    for (const sub of g.geometries) {
      const r = checkIndiaBounds(sub);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  if (!SIMPLE.has(g.type)) return { ok: false, error: MALFORMED };
  if (!Array.isArray(g.coordinates)) return { ok: false, error: MALFORMED };

  let sawPair = false;
  let malformed = false;
  let outOfRange = false;

  const walk = (node: unknown): void => {
    if (malformed) return;
    if (isPair(node)) {
      sawPair = true;
      const [lng, lat] = node;
      if (lng < MIN_LNG || lng > MAX_LNG || lat < MIN_LAT || lat > MAX_LAT) outOfRange = true;
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    malformed = true; // a non-array, non-pair leaf — not valid GeoJSON coordinates
  };

  walk(g.coordinates);

  if (malformed || !sawPair) return { ok: false, error: MALFORMED };
  if (outOfRange) return { ok: false, error: OUT_OF_RANGE };
  return { ok: true };
}
