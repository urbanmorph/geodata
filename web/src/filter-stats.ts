// The Filter panel's column stats: the catalog's `filter_stats` for a layer that
// has them there, else the layer's static file /api-data/filter-stats/<id>.json
// (layers over LARGE_FILTER_BYTES, baked by scripts/bake_large_filter_stats.py;
// kept out of catalog.json, which every visitor downloads). Fetched only when
// the panel opens. Null when there are none.
import type { LayerFilterStats } from './catalog';

export async function loadBakedStats(
  layerId: string,
  catalog: { filter_stats?: Record<string, LayerFilterStats> },
  fetchImpl: (url: string) => Promise<Response> = fetch,
): Promise<LayerFilterStats | null> {
  const inCatalog = catalog.filter_stats?.[layerId];
  if (inCatalog) return inCatalog;
  try {
    const r = await fetchImpl(`/api-data/filter-stats/${encodeURIComponent(layerId)}.json`);
    return r.ok ? ((await r.json()) as LayerFilterStats) : null;
  } catch {
    return null;
  }
}
