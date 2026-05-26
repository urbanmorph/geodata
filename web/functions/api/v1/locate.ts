import type { Env } from '../_middleware';
import { loadCatalog } from '../../lib/catalog-loader';
import { locate, DEFAULT_LOCATE_LAYERS } from '../../lib/locate';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const latStr = url.searchParams.get('lat');
  const lngStr = url.searchParams.get('lng');

  if (!latStr || !lngStr) {
    return json(400, { error: 'lat and lng query params are required', status: 400 });
  }

  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);

  if (isNaN(lat) || isNaN(lng) || lat < 6 || lat > 38 || lng < 68 || lng > 98) {
    return json(400, { error: 'lat must be 6-38, lng must be 68-98 (India bounding box)', status: 400 });
  }

  const zoom = Math.min(Math.max(parseInt(url.searchParams.get('zoom') || '14', 10), 4), 16);

  const layersParam = url.searchParams.get('layers');
  const layerIds = layersParam
    ? layersParam.split(',').map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_LOCATE_LAYERS];

  const catalog = await loadCatalog(url.origin);
  const result = await locate(lat, lng, layerIds, zoom, catalog, ctx.env.R2);

  return new Response(JSON.stringify(result), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  });
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
