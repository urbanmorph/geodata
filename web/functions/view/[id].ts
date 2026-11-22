// GET /view/<id> — curated-layer canonical share URL.
//
// Cloudflare Pages serves index.html as the SPA. For social-card crawlers
// to see a layer-specific OG image (not the generic og-default), we read
// index.html and rewrite its meta tags via HTMLRewriter. The browser-side
// bundle is the same; main.ts detects /view/<id> and opens that layer.
// The finished page is kept in the edge cache, keyed by the deploy version.

import { buildViewDataset, buildViewContent, layerLevelMeta, type CatalogLayer, type WardIndex } from '../lib/view-dataset';
import type { CatalogData } from '../lib/catalog-api';
import { SECURITY_HEADERS_HTML } from '../lib/security-headers';
import { fetchAsset, type AssetCtx } from '../lib/catalog-loader';
import { cached, cacheKey, CACHE_CONTROL, EDGE_TTL } from '../lib/edge-cache';
import { notFoundResponse, suggestLayers } from '../lib/not-found';
import { escapeHtml as esc, ldJsonScript } from '../../../shared/format.mjs';
import { findLayer } from '../lib/api-layer';

type Params = { id: string };

// SEO URLs (canonical / OG / JSON-LD) must always be the primary apex, so www.*
// and pages.dev variants consolidate there instead of self-referencing as
// canonical and splitting the ranking signal. Mirrors render-view.ts's PUBLIC_ORIGIN.
const CANONICAL_ORIGIN = 'https://bharatlas.com';

const LAYER_NOT_FOUND = { title: 'Layer not found', message: "There's no layer with this id. It may have been renamed, or the link has a typo." };

/** The 404 for an unknown layer id, with "Did you mean" links to the closest real ones. */
function layerNotFound(ctx: AssetCtx, id: string, catalog: CatalogData): Promise<Response> {
  const layers: CatalogLayer[] = catalog.layers;
  const items = suggestLayers(id, layers).map((sid) => {
    const layer = layers.find((l) => l.id === sid)!;
    const meta = layerLevelMeta(layer, catalog.level_meta, layers);
    const title = meta?.label || layer.name || sid.replace(/_/g, ' ');
    // Titles repeat across sources (LGD and SOI both have "Districts"): the source tells them apart.
    return `<li><a href="/view/${esc(sid)}">View ${esc(title)}</a>, ${esc(layer.source)}<code>${esc(sid)}</code></li>`;
  });
  const extra = items.length ? `<h2>Did you mean</h2>\n      <ul class="nf-suggest">${items.join('')}</ul>\n` : '';
  return notFoundResponse(ctx, {
    title: LAYER_NOT_FOUND.title,
    message: `There's no layer with the id "${id}". It may have been renamed, or the link has a typo.`,
    extra,
  });
}

export const onRequestGet: PagesFunction<{ ASSETS: Fetcher }, keyof Params> = async (ctx) => {
  const id = (ctx.params.id as string) || '';
  const url = new URL(ctx.request.url);
  // The catalog is cached per isolate; a rejected load is a 503, not a crash.
  const found = await findLayer(ctx, id, url).catch(() => null);
  if (!found) return new Response('upstream unavailable', { status: 503 });
  if (found.kind === 'invalid') return notFoundResponse(ctx, LAYER_NOT_FOUND);
  if (found.kind === 'moved') return found.response;
  if (found.kind === 'missing') return layerNotFound(ctx, id, found.catalog);

  // The page depends only on the layer and the deploy: keyed by path, not query.
  const { layer, catalog, version } = found;
  const key = cacheKey(version, url, { query: false });
  return cached(ctx, key, EDGE_TTL.page, () => renderPage(ctx, layer, catalog));
};

async function renderPage(ctx: AssetCtx, layer: CatalogLayer, catalog: CatalogData): Promise<Response> {
  // The home page from this deployment's own files (env.ASSETS: no trip through
  // the zone). Ward pages also read their answer-table sidecar in parallel; it's
  // absent for number-only cities, leaving the page table-less.
  const [indexResp, wardResp] = await Promise.all([
    fetchAsset(ctx, '/').catch(() => null),
    /^wards_/.test(layer.id) ? fetchAsset(ctx, `/ward-index/${layer.id}.json`).catch(() => null) : Promise.resolve(null),
  ]);
  if (!indexResp?.ok) return new Response('upstream unavailable', { status: 503 });
  let wardIndex: WardIndex | null = null;
  if (wardResp && wardResp.ok) {
    wardIndex = await wardResp.json<WardIndex>().catch(() => null);
  }

  const levelMeta = layerLevelMeta(layer, catalog.level_meta, catalog.layers);
  const { title, description, canonical, ogImage, jsonLd, breadcrumbJsonLd, howToJsonLd, wardListJsonLd } = buildViewDataset(
    layer,
    levelMeta,
    CANONICAL_ORIGIN,
    wardIndex,
  );
  const contentHtml = buildViewContent(layer, levelMeta, CANONICAL_ORIGIN, wardIndex);

  // [selector, attribute, value] for every head tag the page rewrites.
  const attrs: Array<[string, string, string]> = [
    ['meta[name="description"]', 'content', description],
    ['link[rel="canonical"]', 'href', canonical],
    ['meta[property="og:title"]', 'content', title],
    ['meta[property="og:description"]', 'content', description],
    ['meta[property="og:url"]', 'content', canonical],
    ['meta[property="og:image"]', 'content', ogImage],
    ['meta[name="twitter:title"]', 'content', title],
    ['meta[name="twitter:description"]', 'content', description],
    ['meta[name="twitter:image"]', 'content', ogImage],
  ];
  // The home page's JSON-LD block becomes the layer's blocks, in this order.
  const ldScripts = [jsonLd, wardListJsonLd, howToJsonLd, breadcrumbJsonLd]
    .filter(Boolean)
    .map(ldJsonScript)
    .join('\n    ');

  return attrs
    .reduce((rw, [sel, attr, value]) => rw.on(sel, { element(el) { el.setAttribute(attr, value); } }), new HTMLRewriter())
    .on('title', {
      element(el) { el.setInnerContent(`${title} · bharatlas`); },
    })
    .on('script[type="application/ld+json"]', {
      element(el) { el.replace(ldScripts, { html: true }); },
    })
    .on('body', {
      element(el) { el.prepend(contentHtml, { html: true }); },
    })
    // Home hero h1 is left in DOM by index.html so it's there after JS hydrates
    // and the user closes the map overlay. On /view/<id> the only h1 a crawler
    // should see is the layer title in <article class="view-seo">. Demote to
    // <div> (same .hero__title CSS) so styling is preserved when the user
    // returns to / via the in-page close button.
    .on('h1.hero__title', {
      element(el) {
        el.before('<div class="hero__title">', { html: true });
        el.after('</div>', { html: true });
        el.removeAndKeepContent();
      },
    })
    .transform(new Response(indexResp.body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': CACHE_CONTROL.page,
        ...SECURITY_HEADERS_HTML,
      },
    }));
}
