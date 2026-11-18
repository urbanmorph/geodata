// GET /view/<id> — curated-layer canonical share URL.
//
// Cloudflare Pages serves index.html as the SPA. For social-card crawlers
// to see a layer-specific OG image (not the generic og-default), we read
// index.html and rewrite its meta tags via HTMLRewriter. The browser-side
// bundle is the same; main.ts detects /view/<id> and opens that layer.
// The finished page is kept in the edge cache, keyed by the deploy version.

import { buildViewDataset, buildViewContent, resolveLevelMeta, type CatalogLayer, type LevelMeta, type WardIndex } from '../lib/view-dataset';
import { SECURITY_HEADERS_HTML } from '../lib/security-headers';
import { loadCatalogVersioned, fetchAsset, type AssetCtx } from '../lib/catalog-loader';
import { cached, cacheKey, EDGE_TTL } from '../lib/edge-cache';
import { notFoundHtml } from '../lib/not-found';
import { retiredRedirect } from '../lib/retired-layers';

type Params = { id: string };

type Catalog = {
  layers?: CatalogLayer[];
  level_meta?: Record<string, LevelMeta>;
};

const NOT_FOUND_HTML = notFoundHtml('layer not found', "This layer id doesn't exist in the catalog.");

// SEO URLs (canonical / OG / JSON-LD) must always be the primary apex, so www.*
// and pages.dev variants consolidate there instead of self-referencing as
// canonical and splitting the ranking signal. Mirrors render-view.ts's PUBLIC_ORIGIN.
const CANONICAL_ORIGIN = 'https://bharatlas.com';

const notFound = () =>
  new Response(NOT_FOUND_HTML, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS_HTML } });

export const onRequestGet: PagesFunction<{ ASSETS: Fetcher }, keyof Params> = async (ctx) => {
  const id = (ctx.params.id as string) || '';
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return notFound();
  const moved = retiredRedirect(new URL(ctx.request.url), id);
  if (moved) return moved;

  // The catalog is cached per isolate; a rejected load is a 503, not a crash.
  const loaded = await loadCatalogVersioned(ctx).catch(() => null);
  if (!loaded) return new Response('upstream unavailable', { status: 503 });
  const catalog = loaded.catalog as unknown as Catalog;
  const layer = catalog.layers?.find((l) => l.id === id);
  if (!layer) return notFound();

  // The page depends only on the layer and the deploy: keyed by path, not query.
  const key = cacheKey(loaded.version, new URL(ctx.request.url), { query: false });
  return cached(ctx, key, EDGE_TTL.page, () => renderPage(ctx, layer, catalog));
};

async function renderPage(ctx: AssetCtx, layer: CatalogLayer, catalog: Catalog): Promise<Response> {
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

  const levelMeta = resolveLevelMeta(layer, catalog.level_meta);
  const { title, description, canonical, ogImage, jsonLd, breadcrumbJsonLd, howToJsonLd, wardListJsonLd } = buildViewDataset(
    layer,
    levelMeta,
    CANONICAL_ORIGIN,
    wardIndex,
  );
  const contentHtml = buildViewContent(layer, levelMeta, CANONICAL_ORIGIN, wardIndex);

  return new HTMLRewriter()
    .on('title', {
      element(el) { el.setInnerContent(`${title} · bharatlas`); },
    })
    .on('meta[name="description"]', { element(el) { el.setAttribute('content', description); } })
    .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', canonical); } })
    .on('meta[property="og:title"]', { element(el) { el.setAttribute('content', title); } })
    .on('meta[property="og:description"]', { element(el) { el.setAttribute('content', description); } })
    .on('meta[property="og:url"]', { element(el) { el.setAttribute('content', canonical); } })
    .on('meta[property="og:image"]', { element(el) { el.setAttribute('content', ogImage); } })
    .on('meta[name="twitter:title"]', { element(el) { el.setAttribute('content', title); } })
    .on('meta[name="twitter:description"]', { element(el) { el.setAttribute('content', description); } })
    .on('meta[name="twitter:image"]', { element(el) { el.setAttribute('content', ogImage); } })
    .on('script[type="application/ld+json"]', {
      element(el) {
        el.setInnerContent(JSON.stringify(jsonLd).replace(/</g, '\\u003c'), { html: true });
        const bc = JSON.stringify(breadcrumbJsonLd).replace(/</g, '\\u003c');
        el.after(`\n    <script type="application/ld+json">${bc}</script>`, { html: true });
        if (howToJsonLd) {
          const ht = JSON.stringify(howToJsonLd).replace(/</g, '\\u003c');
          el.after(`\n    <script type="application/ld+json">${ht}</script>`, { html: true });
        }
        if (wardListJsonLd) {
          const wl = JSON.stringify(wardListJsonLd).replace(/</g, '\\u003c');
          el.after(`\n    <script type="application/ld+json">${wl}</script>`, { html: true });
        }
      },
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
        'cache-control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=86400',
        ...SECURITY_HEADERS_HTML,
      },
    }));
}
