import type { Env } from '../../_middleware';
import { loadCatalogVersioned } from '../../../lib/catalog-loader';
import { filterLayers, paginateResults, toApiLayer } from '../../../lib/catalog-api';
import { cached, cacheKey, CACHE_CONTROL, EDGE_TTL } from '../../../lib/edge-cache';
import { json } from '../../../lib/http';


export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const { catalog, version } = await loadCatalogVersioned(ctx);

  return cached(ctx, cacheKey(version, url), EDGE_TTL.catalog, async () => {
    const filtered = filterLayers(catalog.layers, {
      category: url.searchParams.get('category') || undefined,
      level: url.searchParams.get('level') || undefined,
      source: url.searchParams.get('source') || undefined,
      q: url.searchParams.get('q') || undefined,
    });

    const page = paginateResults(
      filtered.map((l) => toApiLayer(l, catalog)),
      {
        limit: Number(url.searchParams.get('limit')) || undefined,
        offset: Number(url.searchParams.get('offset')) || undefined,
      },
    );

    return json(200, page, { 'cache-control': CACHE_CONTROL.catalog });
  });
};
