// A ward layer's ward-index sidecar (web/public/ward-index/<id>.json: ward
// numbers, names, groups), fetched once per page and shared by the locate
// sheet, the home search answer and the About panel. Null when the layer has
// no sidecar (number-only cities, non-ward layers) or the fetch fails.
import type { WardSidecar } from './locate-format';
import type { WardIndex } from '../functions/lib/view-dataset';
import { isWardLayer } from './locate-actions';

/** The sidecar file: what the page renders (WardIndex) + what locate reads (WardSidecar). */
export type WardIndexFile = WardIndex & WardSidecar;

const cache = new Map<string, Promise<WardIndexFile | null>>();

export function fetchWardIndex(layerId: string): Promise<WardIndexFile | null> {
  if (!isWardLayer(layerId)) return Promise.resolve(null);
  let p = cache.get(layerId);
  if (!p) {
    // No sidecar (a 404, or the site's HTML fallback) is kept as null; any other failure
    // is forgotten so a later call retries.
    p = fetch(`/ward-index/${encodeURIComponent(layerId)}.json`)
      .then((r) => {
        if (r.ok) return (r.json() as Promise<WardIndexFile>).catch(() => null);
        if (r.status === 404) return null;
        throw new Error(String(r.status));
      })
      .catch(() => {
        cache.delete(layerId);
        return null;
      });
    cache.set(layerId, p);
  }
  return p;
}

/** Tests only. */
export function _resetWardIndexCache(): void {
  cache.clear();
}
