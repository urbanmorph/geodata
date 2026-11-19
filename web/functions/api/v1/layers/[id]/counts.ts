// GET /api/v1/layers/{id}/counts[?group_by=col][&filter_col=c&filter_val=v]
// Deprecated (kept for old callers): /layers/{id}/query?group_by=col does the
// same for every layer. Pre-computed stats (/api-data/layers/<id>.json) exist
// for a few ward layers only; any other group_by is counted from the parquet
// by the query engine, and filter_col/filter_val narrow it as a where filter
// (without group_by, to the filtered total).
import type { Env } from '../../../_middleware';
import { fetchAsset, type AssetCtx } from '../../../../lib/catalog-loader';
import type { CatalogLayer } from '../../../../lib/catalog-api';
import { cached, cacheKey, EDGE_TTL } from '../../../../lib/edge-cache';
import { countApiUse } from '../../../../lib/usage';
import { apiError, json, serverError } from '../../../../lib/http';
import { resolveLayer } from '../../../../lib/api-layer';
import { r2KeyFromLayer, asyncBufferFromR2 } from '../../../../lib/parquet-r2';
import { query, QueryInputError, type GroupByResult, type QueryResult } from '../../../../lib/parquet-query';

const CACHE = 'public, max-age=86400, stale-while-revalidate=86400';

type CountsCtx = AssetCtx & { env: { R2: R2Bucket } };

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const r = await resolveLayer(ctx);
  if (r instanceof Response) return r;
  const { layer, version, url } = r;
  countApiUse(ctx, layer.id);

  return cached(ctx, cacheKey(version, url), EDGE_TTL.r2, () => answer(ctx, layer, url.searchParams));
};

async function answer(ctx: CountsCtx, layer: CatalogLayer, params: URLSearchParams): Promise<Response> {
  const id = layer.id;
  const groupBy = params.get('group_by');
  const filterCol = params.get('filter_col');
  const filterVal = params.get('filter_val');
  if (!filterCol !== !filterVal) return apiError(400, 'filter_col and filter_val go together: give both or neither');
  const where = filterCol && filterVal ? { [filterCol]: filterVal } : undefined;

  // Pre-computed stats, from this deployment's static files.
  let stats: LayerStats | null = null;
  try {
    const r = await fetchAsset(ctx, `/api-data/layers/${id}.json`);
    if (r.ok) stats = await r.json() as LayerStats;
  } catch { /* no stats available */ }

  // No group_by and no filter: the total.
  if (!groupBy && !where) {
    const total = stats?.row_count ?? layer.rows ?? null;
    const groupable = stats
      ? Object.entries(stats.columns)
          .filter(([, info]) => info.values)
          .map(([col, info]) => ({ column: col, type: info.type, distinct: info.distinct }))
      : [];
    return respond({ layer_id: id, total, groupable_columns: groupable });
  }

  const col = groupBy ? stats?.columns[groupBy] : undefined;
  if (stats && col?.values && !where) {
    return respond({ layer_id: id, total: stats.row_count, group_by: groupBy, counts: col.values });
  }

  // Everything else from the parquet: any column, with the filter applied (an
  // unknown column is a 400 before any row is read).
  const r2Key = r2KeyFromLayer(layer);
  if (!r2Key) return apiError(404, 'No parquet file for this layer');
  try {
    const file = await asyncBufferFromR2(ctx.env.R2, r2Key);
    if (!groupBy) {
      // The filtered total: only the filter column is scanned.
      const q = await query(file, { where, select: [filterCol!], limit: 1 }) as QueryResult;
      return respond({ layer_id: id, total: q.total, filter: { column: filterCol, value: filterVal } });
    }
    const g = await query(file, { groupBy, where }) as GroupByResult;
    return respond({ layer_id: id, total: g.total, group_by: groupBy, counts: g.counts });
  } catch (e) {
    if (e instanceof QueryInputError) return apiError(400, e.message);
    return serverError('Counts', e);
  }
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
