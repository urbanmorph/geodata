// The Filter panel's column stats: the catalog's `filter_stats` for a layer that
// has them there, else the layer's static file /api-data/filter-stats/<id>.json.
// Only layers over LARGE_FILTER_BYTES have a file (scripts/bake_large_filter_stats.py;
// kept out of catalog.json, which every visitor downloads; tests/large-filter.test.ts
// checks each has one), so `hasFile` is usesServerFilter(layer): a small layer
// never asks for one (it would 404) and goes to the probe. Fetched only when the
// panel opens. Null when there are none.
import type { LayerFilterStats } from './catalog';

export async function loadBakedStats(
  layerId: string,
  catalog: { filter_stats?: Record<string, LayerFilterStats> },
  hasFile: boolean,
  fetchImpl: (url: string) => Promise<Response> = fetch,
): Promise<LayerFilterStats | null> {
  const inCatalog = catalog.filter_stats?.[layerId];
  if (inCatalog) return inCatalog;
  if (!hasFile) return null;
  try {
    const r = await fetchImpl(`/api-data/filter-stats/${encodeURIComponent(layerId)}.json`);
    return r.ok ? ((await r.json()) as LayerFilterStats) : null;
  } catch {
    return null;
  }
}
