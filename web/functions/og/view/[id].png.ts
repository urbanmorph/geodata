// GET /og/view/<id>.png — curated-layer OG card.
// Reads the catalog, builds metadata, renders PNG; the PNG is kept in the edge
// cache (keyed by the deploy version), so resvg runs once per colo and deploy.

import { curatedMetadata } from '../../lib/og-metadata';
import { renderOgPng } from '../../lib/og-render';
import { ogError, PNG_HEADERS } from '../../lib/og-response';
import { renderOgSvg } from '../../lib/og-template';
import { loadCatalogVersioned } from '../../lib/catalog-loader';
import { cached, cacheKey, EDGE_TTL } from '../../lib/edge-cache';
import { LAYER_ID } from '../../lib/api-layer';
import { retiredRedirect } from '../../lib/retired-layers';

type Params = { id: string };

type Catalog = {
  layers?: Array<{ id: string; level: string; source: string; rows: number | null; licence?: string }>;
  level_meta?: Record<string, { label: string; unit?: string }>;
};

export const onRequestGet: PagesFunction<{ ASSETS: Fetcher }, keyof Params> = async (ctx) => {
  const id = (ctx.params.id as string) || '';
  if (!LAYER_ID.test(id)) return ogError(404, 'invalid layer id');
  const moved = retiredRedirect(new URL(ctx.request.url), id);
  if (moved) return moved;

  // Cached per isolate (catalog.json only changes with a deploy).
  const loaded = await loadCatalogVersioned(ctx).catch(() => null);
  if (!loaded) return ogError(503, 'catalog unavailable');
  const catalog = loaded.catalog as unknown as Catalog;

  const layer = catalog.layers?.find((l) => l.id === id);
  if (!layer) return ogError(404, 'layer not found');

  const key = cacheKey(loaded.version, new URL(ctx.request.url), { query: false });
  return cached(ctx, key, EDGE_TTL.page, async () => {
    const meta = curatedMetadata({ layer, levelMeta: catalog.level_meta?.[layer.level] });
    return new Response(await renderOgPng(renderOgSvg(meta), ctx), { headers: PNG_HEADERS });
  });
};
