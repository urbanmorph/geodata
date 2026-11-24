import type { Env } from '../../../_middleware';
import { countApiUse } from '../../../../lib/usage';
import { timedCall } from '../../../../lib/api-calls';
import { withColoReads } from '../../../../lib/colo-cache';
import { ncFields, noMatchHint } from '../../../../lib/catalog-api';
import { r2KeyFromLayer, asyncBufferFromR2 } from '../../../../lib/parquet-r2';
import { query, queryFailure } from '../../../../lib/parquet-query';
import { parseQueryParams, queryCacheUrl } from '../../../../lib/query-params';
import { parseFilterParam } from '../../../../lib/parquet-export';
import { apiError, json } from '../../../../lib/http';
import { resolveLayer } from '../../../../lib/api-layer';
import { cached, cacheKey, EDGE_TTL } from '../../../../lib/edge-cache';
import { loadValueIndex } from '../../../../lib/value-index';

export const onRequestGet: PagesFunction<Env> = timedCall(async (ctx) => {
  const r = await resolveLayer(ctx);
  if (r instanceof Response) return r;
  const { layer, version, url } = r;
  countApiUse(ctx, layer.id);

  const r2Key = r2KeyFromLayer(layer);
  if (!r2Key) return apiError(404, 'No parquet file for this layer');

  let parsed: ReturnType<typeof parseQueryParams>;
  try {
    parsed = parseQueryParams(url.searchParams);
  } catch (e) {
    return queryFailure('Query', layer.id)(e);
  }
  const { select, groupBy, sum, limit, where, includeCentroid } = parsed;

  const run = async (): Promise<Response> => {
    try {
      const start = Date.now();
      const filters = parseFilterParam(url.searchParams.get('filter'));
      // A large layer's baked value index lets a filter read only the row groups it needs;
      // fetched while the parquet's footer is read.
      const indexed = where || filters?.length || groupBy ? loadValueIndex(ctx, layer) : null;
      const { file, result } = await withColoReads(ctx, version, async (r2) => {
        const file = await asyncBufferFromR2(r2, r2Key);
        return { file, result: await query(file, { select, where, groupBy, sum, limit, includeCentroid, filters, valueIndex: await indexed }) };
      });
      const timing = Date.now() - start;
      // A filter that matched nothing: usually a wrong column value or spelling.
      const hint = (where || filters?.length) && result.total === 0 ? { hint: noMatchHint(layer.id) } : {};

      return json(200, { data: result, layer_id: layer.id, ...ncFields(layer), timing_ms: timing, ...hint }, {
        'cache-control': groupBy ? 'public, max-age=3600, stale-while-revalidate=86400' : 'public, max-age=300, stale-while-revalidate=3600',
        ...(groupBy ? { etag: `"${version}-${file.etag}"` } : {}),
      });
    } catch (e) {
      return queryFailure('Query', layer.id)(e);
    }
  };

  // Every answer is kept in the colo: a filtered row answer (at most 1,000 rows)
  // on a large layer is a whole-file scan (an Overture hospital query took 15 s
  // every time). The key leaves out parameters that can't change the answer.
  return cached(ctx, cacheKey(version, queryCacheUrl(url)), EDGE_TTL.r2, run);
});
