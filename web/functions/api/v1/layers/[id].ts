import type { Env } from '../../_middleware';
import { attachFilterStats, toApiLayer } from '../../../lib/catalog-api';
import { countApiUse } from '../../../lib/usage';
import { json } from '../../../lib/http';
import { resolveLayer } from '../../../lib/api-layer';
import { cached, cacheKey, EDGE_TTL } from '../../../lib/edge-cache';

const CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const r = await resolveLayer(ctx);
  if (r instanceof Response) return r;
  const { layer, catalog, version, url } = r;
  countApiUse(ctx, layer.id);

  return cached(ctx, cacheKey(version, url), EDGE_TTL.catalog, async () =>
    json(200, { data: await attachFilterStats(ctx, toApiLayer(layer, catalog, true)) }, { 'cache-control': CACHE }));
};
