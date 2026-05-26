import type { Env } from '../../_middleware';
import { loadCatalog } from '../../../lib/catalog-loader';
import { filterLayers, paginateResults, toApiLayer } from '../../../lib/catalog-api';

const CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const catalog = await loadCatalog(url.origin);

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

  return new Response(JSON.stringify(page), {
    headers: { 'content-type': 'application/json', 'cache-control': CACHE },
  });
};
