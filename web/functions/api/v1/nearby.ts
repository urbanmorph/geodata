import type { Env } from '../_middleware';
import { clampNum } from '../../lib/query-params';
import { loadCatalogVersioned } from '../../lib/catalog-loader';
import { countApiUse } from '../../lib/usage';
import { nearby } from '../../lib/nearby';
import { QueryInputError } from '../../lib/parquet-query';
import { json, safeStringify } from '../../lib/http';
import { cached, cacheKey, EDGE_TTL } from '../../lib/edge-cache';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const latStr = url.searchParams.get('lat');
  const lngStr = url.searchParams.get('lng');
  const layerId = url.searchParams.get('layer');

  if (!latStr || !lngStr || !layerId) {
    return json(400, { error: 'lat, lng, and layer query params are required', status: 400 });
  }

  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);
  if (isNaN(lat) || isNaN(lng) || lat < 6 || lat > 38 || lng < 68 || lng > 98) {
    return json(400, { error: 'lat must be 6-38, lng must be 68-98 (India bounding box)', status: 400 });
  }

  const radiusKm = clampNum(url.searchParams.get('radius_km'), 25, 1, 200);
  const limit = clampNum(url.searchParams.get('limit'), 20, 1, 100, true);

  const { catalog, version } = await loadCatalogVersioned(ctx);
  if (!catalog.layers.some((l) => l.id === layerId)) {
    return json(400, { error: `Layer ${layerId} not found`, status: 400 });
  }
  countApiUse(ctx, layerId);

  return cached(ctx, cacheKey(version, url), EDGE_TTL.r2, async () => {
    try {
      const result = await nearby(lat, lng, radiusKm, layerId, catalog, ctx.env.R2, limit);
      return new Response(safeStringify(result), {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
        },
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (e instanceof QueryInputError) return json(400, { error: msg, status: 400 });
      return json(500, { error: `Nearby failed: ${msg}`, status: 500 });
    }
  });
};
