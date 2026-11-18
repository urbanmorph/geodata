import type { Env } from '../../../_middleware';
import { loadCatalogVersioned, fetchAsset, type AssetCtx } from '../../../../lib/catalog-loader';
import type { CatalogLayer } from '../../../../lib/catalog-api';
import { cached, cacheKey, EDGE_TTL } from '../../../../lib/edge-cache';
import { countApiUse } from '../../../../lib/usage';
import { json } from '../../../../lib/http';

const CACHE = 'public, max-age=86400, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const id = (ctx.params as { id: string }).id;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return json(400, { error: 'Invalid layer ID', status: 400 });
  }

  const url = new URL(ctx.request.url);
  const { catalog, version } = await loadCatalogVersioned(ctx);
  const layer = catalog.layers.find((l) => l.id === id);
  if (!layer) return json(404, { error: 'Layer not found', status: 404 });
  countApiUse(ctx, id);

  return cached(ctx, cacheKey(version, url), EDGE_TTL.catalog, () => answer(ctx, layer, url.searchParams));
};

async function answer(ctx: AssetCtx, layer: CatalogLayer, params: URLSearchParams): Promise<Response> {
  const id = layer.id;
  const groupBy = params.get('group_by');
  const filterCol = params.get('filter_col');
  const filterVal = params.get('filter_val');

  // Pre-computed stats, from this deployment's static files.
  let stats: LayerStats | null = null;
  try {
    const r = await fetchAsset(ctx, `/api-data/layers/${id}.json`);
    if (r.ok) stats = await r.json() as LayerStats;
  } catch { /* no stats available */ }

  // No group_by: return total
  if (!groupBy) {
    const total = stats?.row_count ?? layer.rows ?? null;
    const groupable = stats
      ? Object.entries(stats.columns)
          .filter(([, info]) => info.values)
          .map(([col, info]) => ({ column: col, type: info.type, distinct: info.distinct }))
      : [];
    return respond({ layer_id: id, total, groupable_columns: groupable });
  }

  // group_by specified: return value→count from pre-computed stats
  if (!stats) {
    return respond({ layer_id: id, total: layer.rows ?? null, group_by: groupBy, counts: null, detail: 'No pre-computed stats. Run scripts/build_api_indexes.py.' });
  }

  const col = stats.columns[groupBy];
  if (!col || !col.values) {
    const available = Object.keys(stats.columns).filter((c) => stats!.columns[c].values);
    return json(400, { error: `Column "${groupBy}" not available for grouping. Available: ${available.join(', ')}`, status: 400 });
  }

  const counts = col.values;

  // Optional cross-filter: when filter_col + filter_val are provided,
  // we can't cross-filter from pre-computed single-column stats.
  // Return what we have and note the limitation.
  if (filterCol && filterVal) {
    return respond({
      layer_id: id,
      total: stats.row_count,
      group_by: groupBy,
      counts,
      filter_note: 'Cross-column filtering requires client-side DuckDB on the parquet file. Pre-computed stats are single-column only.',
    });
  }

  return respond({ layer_id: id, total: stats.row_count, group_by: groupBy, counts });
}

const respond = (data: unknown) => json(200, { data }, { 'cache-control': CACHE });

interface LayerStats {
  row_count: number;
  columns: Record<string, {
    type: string;
    distinct: number;
    row_count: number;
    values?: Record<string, number>;
  }>;
}
