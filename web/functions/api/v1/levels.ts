import type { Env } from '../_middleware';
import { loadCatalog } from '../../lib/catalog-loader';
import { toApiLevel } from '../../lib/catalog-api';

const CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const catalog = await loadCatalog(url.origin);
  return new Response(JSON.stringify({ data: toApiLevel(catalog) }), {
    headers: { 'content-type': 'application/json', 'cache-control': CACHE },
  });
};
