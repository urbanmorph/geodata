// A ward layer's ward-index sidecar (web/public/ward-index/<id>.json: ward
// numbers, names, groups), fetched once per page and shared by the locate
// sheet, the home search answer and the About panel. Null when the layer has
// no sidecar (number-only cities, non-ward layers) or the fetch fails.
import type { WardSidecar } from './locate-format';
import type { WardIndex } from '../functions/lib/view-dataset';

/** The sidecar file: what the page renders (WardIndex) + what locate reads (WardSidecar). */
export type WardIndexFile = WardIndex & WardSidecar;

const cache = new Map<string, Promise<WardIndexFile | null>>();

export function fetchWardIndex(layerId: string): Promise<WardIndexFile | null> {
  if (!/^wards_/.test(layerId)) return Promise.resolve(null);
  let p = cache.get(layerId);
  if (!p) {
    p = fetch(`/ward-index/${encodeURIComponent(layerId)}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<WardIndexFile>) : null))
      .catch(() => null);
    cache.set(layerId, p);
  }
  return p;
}

/** Tests only. */
export function _resetWardIndexCache(): void {
  cache.clear();
}
