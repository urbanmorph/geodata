import type { Env } from '../../../_middleware';
import { countApiUse } from '../../../../lib/usage';
import { timedCall } from '../../../../lib/api-calls';
import { ncFields } from '../../../../lib/catalog-api';
import { r2KeyFromLayer, asyncBufferFromR2 } from '../../../../lib/parquet-r2';
import { getSchema, queryFailure } from '../../../../lib/parquet-query';
import { bakedSchema } from '../../../../lib/baked-schema';
import { apiError, json } from '../../../../lib/http';
import { resolveLayer } from '../../../../lib/api-layer';
import { cached, cacheKey, EDGE_TTL } from '../../../../lib/edge-cache';

const CACHE = 'public, max-age=86400, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = timedCall(async (ctx) => {
  const r = await resolveLayer(ctx);
  if (r instanceof Response) return r;
  const { layer, version, url } = r;
  countApiUse(ctx, layer.id);

  const r2Key = r2KeyFromLayer(layer);
  if (!r2Key) return apiError(404, 'No parquet file for this layer');

  return cached(ctx, cacheKey(version, url), EDGE_TTL.r2, async () => {
    // The baked file (a static asset of this deploy) when it matches the parquet;
    // else the live read from R2.
    const baked = await bakedSchema(ctx, layer);
    if (baked) return json(200, { data: baked, ...ncFields(layer) }, { 'cache-control': CACHE, etag: `"${version}-baked"` });
    try {
      const file = await asyncBufferFromR2(ctx.env.R2, r2Key);
      const schema = await getSchema(file);
      return json(200, { data: schema, ...ncFields(layer) }, { 'cache-control': CACHE, etag: `"${version}-${file.etag}"` });
    } catch (e) {
      return queryFailure('Schema read', layer.id)(e);
    }
  });
});
