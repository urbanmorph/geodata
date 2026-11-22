// GET /og/view/<id>.png — curated-layer OG card.
// Reads the catalog, builds metadata, renders PNG; the PNG is kept in the edge
// cache (keyed by the deploy version), so resvg runs once per colo and deploy.

import { curatedCard } from '../../lib/og-metadata';
import { renderOgPng } from '../../lib/og-render';
import { ogError, PNG_HEADERS } from '../../lib/og-response';
import { renderOgSvg } from '../../lib/og-template';
import { cached, cacheKey, EDGE_TTL } from '../../lib/edge-cache';
import { findLayer } from '../../lib/api-layer';

type Params = { id: string };

export const onRequestGet: PagesFunction<{ ASSETS: Fetcher }, keyof Params> = async (ctx) => {
  const url = new URL(ctx.request.url);
  // The catalog is cached per isolate (catalog.json only changes with a deploy).
  const found = await findLayer(ctx, (ctx.params.id as string) || '', url).catch(() => null);
  if (!found) return ogError(503, 'catalog unavailable');
  if (found.kind === 'invalid') return ogError(404, 'invalid layer id');
  if (found.kind === 'moved') return found.response;
  if (found.kind === 'missing') return ogError(404, 'layer not found');
  const { layer, catalog, version } = found;

  const key = cacheKey(version, url, { query: false });
  return cached(ctx, key, EDGE_TTL.page, async () => {
    // The /view page's own level rule, so the card's title matches the page's.
    const meta = curatedCard(layer, catalog.level_meta, catalog.layers);
    return new Response(await renderOgPng(renderOgSvg(meta), ctx), { headers: PNG_HEADERS });
  });
};
