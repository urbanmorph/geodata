import type { Env } from '../../../_middleware';
import { countApiUse } from '../../../../lib/usage';
import { ncFields } from '../../../../lib/catalog-api';
import { r2KeyFromLayer, asyncBufferFromR2 } from '../../../../lib/parquet-r2';
import { getSchema } from '../../../../lib/parquet-query';
import { apiError, json, serverError } from '../../../../lib/http';
import { resolveLayer } from '../../../../lib/api-layer';
import { cached, cacheKey, EDGE_TTL } from '../../../../lib/edge-cache';

const CACHE = 'public, max-age=86400, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const r = await resolveLayer(ctx);
  if (r instanceof Response) return r;
  const { layer, version, url } = r;
  countApiUse(ctx, layer.id);

  const r2Key = r2KeyFromLayer(layer);
  if (!r2Key) return apiError(404, 'No parquet file for this layer');

  return cached(ctx, cacheKey(version, url), EDGE_TTL.r2, async () => {
    try {
      const file = await asyncBufferFromR2(ctx.env.R2, r2Key);
      const schema = await getSchema(file);
      return json(200, { data: schema, ...ncFields(layer) }, { 'cache-control': CACHE, etag: `"${version}-${file.etag}"` });
    } catch (e) {
      return serverError('Schema read', e);
    }
  });
};
