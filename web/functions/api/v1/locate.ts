import type { Env } from '../_middleware';
import { clampNum } from '../../lib/query-params';
import { loadCatalog } from '../../lib/catalog-loader';
import { locate, DEFAULT_LOCATE_LAYERS } from '../../lib/locate';
import { resolveLocateLayers, wardFallbackNeeded, mergeLocateResults, fallbackWardLayers, MAX_LOCATE_LAYERS } from '../../lib/ward-locate';
import { apiError } from '../../lib/http';
import { parseIndiaPoint } from '../../lib/api-layer';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const pt = parseIndiaPoint(url.searchParams);
  if ('error' in pt) return apiError(400, pt.error);
  const { lat, lng } = pt;

  const zoom = clampNum(url.searchParams.get('zoom'), 14, 4, 16, true);

  // Default path auto-includes the city ward layer(s) covering the point (ward
  // lookup is the top demand); an explicit `layers=` is honoured verbatim.
  const layerIds = resolveLocateLayers(
    url.searchParams.get('layers'), lng, lat, DEFAULT_LOCATE_LAYERS,
  );

  if (layerIds.length > MAX_LOCATE_LAYERS) {
    return apiError(400, `ask at most ${MAX_LOCATE_LAYERS} layers at once`);
  }

  const catalog = await loadCatalog(ctx);
  const result = await locate(lat, lng, layerIds, zoom, catalog, ctx.env.R2);

  // A city ward layer chosen by bbox can miss the point (Jaipur's layer is
  // Greater Jaipur only): ask the national SBM ward layer as a second pass.
  if (wardFallbackNeeded(url.searchParams.get('layers'), layerIds, result.results)) {
    const extra = await locate(lat, lng, fallbackWardLayers(lng, lat), zoom, catalog, ctx.env.R2);
    result.results = mergeLocateResults(result.results, extra.results);
    result.queried_layers = [...result.queried_layers, ...extra.queried_layers];
    if (extra.failed_layers) result.failed_layers = [...(result.failed_layers ?? []), ...extra.failed_layers];
  }

  return new Response(JSON.stringify(result), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  });
};
