import type { Env } from '../_middleware';
import { loadCatalog } from '../../lib/catalog-loader';
import { nearby } from '../../lib/nearby';

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

  const radiusKm = Math.min(Math.max(parseFloat(url.searchParams.get('radius_km') || '25'), 1), 200);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10), 1), 100);

  const catalog = await loadCatalog(url.origin);

  try {
    const result = await nearby(lat, lng, radiusKm, layerId, catalog, ctx.env.R2, limit);
    return new Response(safeStringify(result), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
      },
    });
  } catch (e) {
    return json(400, { error: (e as Error).message, status: 400 });
  }
};

function safeStringify(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? Number(v) : v);
}

function json(status: number, body: unknown) {
  return new Response(safeStringify(body), { status, headers: { 'content-type': 'application/json' } });
}
