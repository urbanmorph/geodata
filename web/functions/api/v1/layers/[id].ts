import type { Env } from '../../_middleware';
import { attachFilterStats, toApiLayer } from '../../../lib/catalog-api';
import { countApiUse } from '../../../lib/usage';
import { timedCall } from '../../../lib/api-calls';
import { json } from '../../../lib/http';
import { resolveLayer } from '../../../lib/api-layer';
import { cached, cacheKey, CACHE_CONTROL, EDGE_TTL } from '../../../lib/edge-cache';
import { withLookups } from '../../../lib/lookups';
import { pointProfilesOn } from '../../../lib/point-profiles';


export const onRequestGet: PagesFunction<Env> = timedCall(async (ctx) => {
  const r = await resolveLayer(ctx);
  if (r instanceof Response) return r;
  const { layer, catalog, version, url } = r;
  countApiUse(ctx, layer.id);

  return cached(ctx, cacheKey(version, url), EDGE_TTL.catalog, async () => {
    const api = await attachFilterStats(ctx, toApiLayer(layer, catalog, true));
    // Which lookup reads the layer, said only while the lookups are published.
    return json(200, { data: pointProfilesOn(ctx.env, url) ? withLookups(api) : api }, { 'cache-control': CACHE_CONTROL.catalog });
  });
});
