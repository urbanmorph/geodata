import type { Env } from '../../_middleware';
import { loadCatalog } from '../../../lib/catalog-loader';
import { toApiLayer } from '../../../lib/catalog-api';

const CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const id = (ctx.params as { id: string }).id;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return new Response(JSON.stringify({ error: 'Invalid layer ID', status: 400 }), { status: 400 });
  }

  const url = new URL(ctx.request.url);
  const catalog = await loadCatalog(url.origin);
  const layer = catalog.layers.find((l) => l.id === id);

  if (!layer) {
    return new Response(JSON.stringify({ error: 'Layer not found', status: 404 }), { status: 404 });
  }

  return new Response(JSON.stringify({ data: toApiLayer(layer, catalog, true) }), {
    headers: { 'content-type': 'application/json', 'cache-control': CACHE },
  });
};
