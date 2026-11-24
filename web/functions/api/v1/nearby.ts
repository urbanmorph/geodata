import type { Env } from '../_middleware';
import { clampNum } from '../../lib/query-params';
import { countApiUse } from '../../lib/usage';
import { timedCall } from '../../lib/api-calls';
import { withColoReads } from '../../lib/colo-cache';
import { nearbyTrueDistance } from '../../lib/nearby-true-distance';
import { queryFailure } from '../../lib/parquet-query';
import { apiError, json } from '../../lib/http';
import { parseIndiaPoint, resolveLayer } from '../../lib/api-layer';
import { answerKey, cached, dataIdentity, EDGE_TTL } from '../../lib/edge-cache';

export const onRequestGet: PagesFunction<Env> = timedCall(async (ctx) => {
  const url = new URL(ctx.request.url);
  if (!url.searchParams.get('layer')) return apiError(400, 'lat, lng, and layer query params are required');
  const pt = parseIndiaPoint(url.searchParams);
  if ('error' in pt) return apiError(400, pt.error);
  const { lat, lng } = pt;

  const radiusKm = clampNum(url.searchParams.get('radius_km'), 25, 1, 200);
  const limit = clampNum(url.searchParams.get('limit'), 20, 1, 100, true);

  const r = await resolveLayer(ctx, { param: 'layer', missingStatus: 400 });
  if (r instanceof Response) return r;
  const { layer, catalog, dataVersion } = r;
  countApiUse(ctx, layer.id);

  return cached(ctx, answerKey('nearby', dataIdentity(layer), url), EDGE_TTL.r2, async () => {
    try {
      const result = await withColoReads(ctx, dataVersion, (r2) => nearbyTrueDistance(lat, lng, radiusKm, layer.id, catalog, r2, limit));
      return json(200, result, { 'cache-control': 'public, max-age=3600, stale-while-revalidate=86400' });
    } catch (e) {
      return queryFailure('Nearby')(e);
    }
  });
});
