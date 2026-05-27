import type { Env } from '../../../_middleware';
import { loadCatalog } from '../../../../lib/catalog-loader';

const CACHE = 'public, max-age=86400, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const id = (ctx.params as { id: string }).id;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return json(400, { error: 'Invalid layer ID', status: 400 });
  }

  const url = new URL(ctx.request.url);
  const catalog = await loadCatalog(url.origin);
  const layer = catalog.layers.find((l) => l.id === id);
  if (!layer) return json(404, { error: 'Layer not found', status: 404 });

  const groupBy = url.searchParams.get('group_by');
  const filterCol = url.searchParams.get('filter_col');
  const filterVal = url.searchParams.get('filter_val');

  // Try to load pre-computed stats
  let stats: LayerStats | null = null;
  try {
    const r = await fetch(`${url.origin}/api-data/layers/${id}.json`);
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

  let counts = col.values;

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
};

function respond(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400, stale-while-revalidate=86400' },
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface LayerStats {
  row_count: number;
  columns: Record<string, {
    type: string;
    distinct: number;
    row_count: number;
    values?: Record<string, number>;
  }>;
}
