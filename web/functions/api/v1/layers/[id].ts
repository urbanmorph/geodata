import type { Env } from '../../_middleware';
import { attachFilterStats, toApiLayer } from '../../../lib/catalog-api';
import { countApiUse } from '../../../lib/usage';
import { timedCall } from '../../../lib/api-calls';
import { json } from '../../../lib/http';
import { resolveLayer } from '../../../lib/api-layer';
import { answerKey, cached, CACHE_CONTROL, EDGE_TTL } from '../../../lib/edge-cache';
import { withLookups } from '../../../lib/lookups';
import { pointProfilesOn } from '../../../lib/point-profiles';


export const onRequestGet: PagesFunction<Env> = timedCall(async (ctx) => {
  const r = await resolveLayer(ctx);
  if (r instanceof Response) return r;
  const { layer, catalog, dataVersion, url } = r;
  countApiUse(ctx, layer.id);
  // Which lookup reads the layer, said only while the lookups are published.
  const lookups = pointProfilesOn(ctx.env, url);

  return cached(ctx, answerKey('detail', `${dataVersion}${lookups ? '.lookups' : ''}`, url), EDGE_TTL.catalog, async () => {
    const api = await attachFilterStats(ctx, toApiLayer(layer, catalog, true));
    return json(200, { data: lookups ? withLookups(api) : api }, { 'cache-control': CACHE_CONTROL.catalog });
  });
});
