import type { Env } from '../_middleware';
import { clampNum } from '../../lib/query-params';
import { loadCatalogVersioned } from '../../lib/catalog-loader';
import { timedCall } from '../../lib/api-calls';
import { withColoReads } from '../../lib/colo-cache';
import { endpointUsageId, timeOnly } from '../../lib/usage';
import { locate, DEFAULT_LOCATE_LAYERS } from '../../lib/locate';
import { resolveLocateLayers, wardFallbackNeeded, mergeLocateResults, fallbackWardLayers, MAX_LOCATE_LAYERS } from '../../lib/ward-locate';
import { apiError, json } from '../../lib/http';
import { parseIndiaPoint } from '../../lib/api-layer';
import { successorOf } from '../../lib/retired-layers';

export const onRequestGet: PagesFunction<Env> = timedCall(async (ctx) => {
  const url = new URL(ctx.request.url);
  const pt = parseIndiaPoint(url.searchParams);
  if ('error' in pt) return apiError(400, pt.error);
  const { lat, lng } = pt;

  const zoom = clampNum(url.searchParams.get('zoom'), 14, 4, 16, true);

  // Default path auto-includes the city ward layer(s) covering the point (ward
  // lookup is the top demand); an explicit `layers=` is honoured as given.
  const layersParam = url.searchParams.get('layers');
  let layerIds = resolveLocateLayers(layersParam, lng, lat, DEFAULT_LOCATE_LAYERS);

  if (layerIds.length > MAX_LOCATE_LAYERS) {
    return apiError(400, `ask at most ${MAX_LOCATE_LAYERS} layers at once`);
  }

  timeOnly(ctx.request, endpointUsageId('locate'));
  const { catalog, dataVersion } = await loadCatalogVersioned(ctx);

  // An explicit list: a retired id is asked as its successor, an unknown one is
  // reported (it used to vanish, answering an empty 200 that looked like "no
  // feature here"); none known at all is a 400.
  let unknown: string[] = [];
  if (layersParam?.trim()) {
    const known = new Set(catalog.layers.map((l) => l.id));
    const mapped = [...new Set(layerIds.map((id) => successorOf(id) ?? id))];
    unknown = mapped.filter((id) => !known.has(id));
    layerIds = mapped.filter((id) => known.has(id));
    if (!layerIds.length) {
      return apiError(400, `No such layer: ${unknown.join(', ')}. See /api/v1/layers for layer ids.`);
    }
  }

  const result = await withColoReads(ctx, dataVersion, async (r2) => {
    const first = await locate(lat, lng, layerIds, zoom, catalog, r2);
    // A city ward layer chosen by bbox can miss the point (Jaipur's layer is
    // Greater Jaipur only): ask the national SBM ward layer as a second pass.
    if (wardFallbackNeeded(layersParam, layerIds, first.results)) {
      const extra = await locate(lat, lng, fallbackWardLayers(lng, lat), zoom, catalog, r2);
      first.results = mergeLocateResults(first.results, extra.results);
      first.queried_layers = [...first.queried_layers, ...extra.queried_layers];
      if (extra.failed_layers) first.failed_layers = [...(first.failed_layers ?? []), ...extra.failed_layers];
    }
    return first;
  });

  return json(200, unknown.length ? { ...result, unknown_layers: unknown } : result, { 'cache-control': 'private, no-store' });
});
