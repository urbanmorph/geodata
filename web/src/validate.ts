// Pure validation helpers used by /verify and (later) /submit.
// No DOM, no MapLibre — testable in plain Node.

export type FC = {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: unknown;
    properties: Record<string, unknown> | null;
  }>;
};

export type Report = {
  count: number;
  byType: Record<string, number>;
  invalid: number;
  crs?: string;
  outsideIndia: number;
  topProps: string[];
  bbox: [number, number, number, number] | null;
};

export const INDIA_BBOX: [number, number, number, number] = [68, 6, 98, 38];

/** Accept any of: FeatureCollection, Feature, raw array of Features. */
export function normaliseFC(o: unknown): FC {
  if (!o || typeof o !== 'object') throw new Error('not a JSON object');
  const x = o as Record<string, unknown>;
  if (x.type === 'FeatureCollection' && Array.isArray(x.features)) return x as unknown as FC;
  if (x.type === 'Feature') return { type: 'FeatureCollection', features: [x as FC['features'][number]] };
  if (Array.isArray(x)) return { type: 'FeatureCollection', features: x as FC['features'] };
  throw new Error('not a GeoJSON FeatureCollection or Feature');
}

export function detectCRS(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { crs?: { properties?: { name?: string } } };
  return r.crs?.properties?.name;
}

/** Visit every (x, y) pair across nested coordinate arrays + GeometryCollections. */
export function visitCoords(g: unknown, cb: (x: number, y: number) => void): void {
  if (!g || typeof g !== 'object') return;
  const coords = (g as { coordinates?: unknown }).coordinates;
  const walk = (c: unknown) => {
    if (!c) return;
    if (Array.isArray(c) && typeof c[0] === 'number') cb(c[0] as number, c[1] as number);
    else if (Array.isArray(c)) for (const sub of c) walk(sub);
  };
  walk(coords);
  const geoms = (g as { geometries?: unknown[] }).geometries;
  if (Array.isArray(geoms)) for (const sub of geoms) visitCoords(sub, cb);
}

/** Bounding box [minLon, minLat, maxLon, maxLat] over every feature, or null
 * when the collection has no coordinates. Used to fit the map view to a
 * geojson layer's extent (the pmtiles path reads its bounds from the header). */
export function featureCollectionBounds(fc: FC): [number, number, number, number] | null {
  let b: [number, number, number, number] | null = null;
  for (const f of fc.features ?? []) {
    visitCoords(f.geometry, (x, y) => {
      b = b
        ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]
        : [x, y, x, y];
    });
  }
  return b;
}

export function validate(fc: FC, raw?: unknown): Report {
  const byType: Record<string, number> = {};
  let invalid = 0;
  let outsideIndia = 0;
  const propCounts: Record<string, number> = {};
  let bbox: [number, number, number, number] | null = null;

  for (const f of fc.features) {
    const t = (f.geometry as { type?: string } | null)?.type;
    if (!t) {
      invalid++;
      continue;
    }
    byType[t] = (byType[t] || 0) + 1;
    visitCoords(f.geometry, (x, y) => {
      if (!isFinite(x) || !isFinite(y)) {
        invalid++;
        return;
      }
      if (x < INDIA_BBOX[0] || x > INDIA_BBOX[2] || y < INDIA_BBOX[1] || y > INDIA_BBOX[3]) outsideIndia++;
      bbox = bbox
        ? [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)]
        : [x, y, x, y];
    });
    if (f.properties)
      for (const k of Object.keys(f.properties)) propCounts[k] = (propCounts[k] || 0) + 1;
  }

  const topProps = Object.entries(propCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k]) => k);

  return {
    count: fc.features.length,
    byType,
    invalid,
    crs: detectCRS(raw),
    outsideIndia,
    topProps,
    bbox,
  };
}
