// The Filter panel's column stats: the catalog's `filter_stats` for a layer that
// has them there, else the layer's static file /api-data/filter-stats/<id>.json.
// Every curated layer has a file (scripts/bake_filter_stats.py; kept out of
// catalog.json, which every visitor downloads; the API's /schema reads them),
// but the panel reads only a large layer's: `hasFile` is usesServerFilter(layer),
// so a small layer keeps the in-browser probe as before. Fetched only when the
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
