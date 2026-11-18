import type { Env } from '../../_middleware';
import { loadCatalogVersioned } from '../../../lib/catalog-loader';
import { attachFilterStats, toApiLayer } from '../../../lib/catalog-api';
import { countApiUse } from '../../../lib/usage';
import { json } from '../../../lib/http';
import { retiredRedirect } from '../../../lib/retired-layers';
import { cached, cacheKey, EDGE_TTL } from '../../../lib/edge-cache';

const CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const id = (ctx.params as { id: string }).id;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return json(400, { error: 'Invalid layer ID', status: 400 });

  const url = new URL(ctx.request.url);
  const moved = retiredRedirect(url, id);
  if (moved) return moved;
  const { catalog, version } = await loadCatalogVersioned(ctx);
  const layer = catalog.layers.find((l) => l.id === id);

  if (!layer) return json(404, { error: 'Layer not found', status: 404 });
  countApiUse(ctx, id);

  return cached(ctx, cacheKey(version, url), EDGE_TTL.catalog, async () =>
    json(200, { data: await attachFilterStats(ctx, toApiLayer(layer, catalog, true)) }, { 'cache-control': CACHE }));
};
