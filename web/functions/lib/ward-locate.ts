// Auto-selecting the city ward layer for a locate point.
//
// The default locate layer set is admin + zones only; wards were invisible unless
// the caller already knew the wards_<city> id. Ward lookup is the single biggest
// demand on bharatlas, so on the default path we append the ward layer(s) whose
// extent contains the point — resolved cheaply from a precomputed per-layer bbox
// table (WARD_BBOXES) so we never query all ~30 ward PMTiles per call, only the
// 1-2 that could actually contain the point. The bbox is a candidate filter, not
// the answer: the actual point-in-polygon test still happens in locate(), so a
// point inside the bbox but outside every ward simply yields no ward feature.

import { WARD_BBOXES, type WardBbox } from './ward-bboxes';

type BboxTable = Record<string, WardBbox | readonly number[]>;

// A GPS fix (or a slightly-off boundary) can land just outside the official ward
// extent; a small margin recovers those without pulling in a neighbouring city.
// ~0.01 deg is roughly 1.1 km. A false candidate only costs one empty PMTiles read.
export const WARD_MARGIN_DEG = 0.01;

/** Ward layer ids whose (margin-padded) bbox contains the point, sorted. */
export function wardLayersAt(
  lng: number,
  lat: number,
  bboxes: BboxTable = WARD_BBOXES,
  margin: number = WARD_MARGIN_DEG,
): string[] {
  const hits: string[] = [];
  for (const id in bboxes) {
    const b = bboxes[id];
    if (!b) continue;
    const [w, s, e, n] = b;
    if (lng >= w - margin && lng <= e + margin && lat >= s - margin && lat <= n + margin) {
      hits.push(id);
    }
  }
  return hits.sort();
}

/**
 * The final locate layer list for a request.
 * - An explicit `layers=` param wins verbatim (trimmed, blanks dropped); the caller
 *   has chosen, so nothing is auto-added.
 * - Otherwise: the default set plus the ward layer(s) covering the point, deduped,
 *   defaults first.
 */
export function resolveLocateLayers(
  layersParam: string | null | undefined,
  lng: number,
  lat: number,
  defaults: readonly string[],
  bboxes: BboxTable = WARD_BBOXES,
  margin: number = WARD_MARGIN_DEG,
): string[] {
  const explicit = (layersParam ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (explicit.length) return explicit;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...defaults, ...wardLayersAt(lng, lat, bboxes, margin)]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
