import type { Env } from '../_middleware';
import { loadCatalogVersioned } from '../../lib/catalog-loader';
import { toApiCategory } from '../../lib/catalog-api';
import { json } from '../../lib/http';
import { cached, cacheKey, EDGE_TTL } from '../../lib/edge-cache';

const CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const { catalog, version } = await loadCatalogVersioned(ctx);
  return cached(ctx, cacheKey(version, new URL(ctx.request.url)), EDGE_TTL.catalog, async () =>
    json(200, { data: toApiCategory(catalog) }, { 'cache-control': CACHE }));
};
