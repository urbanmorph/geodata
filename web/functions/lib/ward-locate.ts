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

// National ward layer (Swachh Bharat Mission, ~3,300 towns) used when no city
// ward layer covers the point, so "which ward am I in" answers outside the ~34
// cities too. City layers stay first choice: they are cleaner where they exist.
export const FALLBACK_WARD_LAYER = 'sbm_wards';

// SBM has only 7 West Bengal towns (183 wards, Nov 2026); WB AMRUT's ward layer covers 52
// towns there. Asked only for points inside West Bengal's extent, so elsewhere costs nothing;
// where both answer, surface_at's summary says the ward once (profile.ts).
const WB_WARD_LAYER = 'wb_amrut_wards';
const WEST_BENGAL_BBOX = [85.8, 21.5, 89.9, 27.3] as const; // [west, south, east, north]

/** Every national ward layer fallbackWardLayers may name. */
export const NATIONAL_WARD_LAYERS: readonly string[] = [FALLBACK_WARD_LAYER, WB_WARD_LAYER];

/** The national ward layer(s) to ask where no city ward layer answers. */
export function fallbackWardLayers(lng: number, lat: number): string[] {
  const [w, s, e, n] = WEST_BENGAL_BBOX;
  const inWB = lng >= w && lng <= e && lat >= s && lat <= n;
  return inWB ? [FALLBACK_WARD_LAYER, WB_WARD_LAYER] : [FALLBACK_WARD_LAYER];
}

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
 * - Otherwise: the default set plus the city ward layer(s) covering the point, or
 *   the national SBM ward layer when none does; deduped, defaults first.
 */
/** Most layers one locate call may ask: each is a tile read from R2. */
export const MAX_LOCATE_LAYERS = 25;

export function resolveLocateLayers(
  layersParam: string | null | undefined,
  lng: number,
  lat: number,
  defaults: readonly string[],
  bboxes: BboxTable = WARD_BBOXES,
  margin: number = WARD_MARGIN_DEG,
): string[] {
  // An explicit list is honoured, de-duplicated; the caller caps its length.
  const explicit = [...new Set((layersParam ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (explicit.length) return explicit;

  const cityWards = wardLayersAt(lng, lat, bboxes, margin);
  const wards = cityWards.length ? cityWards : fallbackWardLayers(lng, lat);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...defaults, ...wards]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

type LocateHit = { layer_id: string };
type LocateGroups = Record<string, LocateHit[]>;

/**
 * Second pass: a point can sit inside a city ward layer's bbox yet outside its
 * wards (Jaipur's layer is Greater Jaipur only, so Hawa Mahal in Heritage finds
 * nothing). On the default path, when no ward layer answered and the national
 * layer wasn't asked, ask it.
 */
export function wardFallbackNeeded(
  layersParam: string | null | undefined,
  askedIds: readonly string[],
  results: LocateGroups,
): boolean {
  if ((layersParam ?? '').trim()) return false;
  if (askedIds.includes(FALLBACK_WARD_LAYER) || askedIds.includes(WB_WARD_LAYER)) return false;
  const wardIds = new Set(askedIds.filter((id) => id.startsWith('wards_')));
  return !Object.values(results).flat().some((hit) => wardIds.has(hit.layer_id));
}

/** Append a second locate's grouped results to the first's, group by group. */
export function mergeLocateResults<T extends LocateHit>(
  a: Record<string, T[]>,
  b: Record<string, T[]>,
): Record<string, T[]> {
  const out: Record<string, T[]> = { ...a };
  for (const [group, hits] of Object.entries(b)) out[group] = [...(out[group] ?? []), ...hits];
  return out;
}
