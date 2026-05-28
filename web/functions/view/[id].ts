// GET /view/<id> — curated-layer canonical share URL.
//
// Cloudflare Pages serves index.html as the SPA. For social-card crawlers
// to see a layer-specific OG image (not the generic og-default), we fetch
// index.html and rewrite its meta tags via HTMLRewriter. The browser-side
// bundle is the same; main.ts detects /view/<id> and opens that layer.

import { buildViewDataset, buildViewContent, resolveLevelMeta, type CatalogLayer, type LevelMeta } from '../lib/view-dataset';

type Params = { id: string };

type Catalog = {
  layers?: CatalogLayer[];
  level_meta?: Record<string, LevelMeta>;
};

const NOT_FOUND_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Not found · geodata</title><meta name="robots" content="noindex"></head><body style="font:15px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;color:#444"><h1 style="font-size:22px">404 — layer not found</h1><p>This layer id doesn't exist in the catalog.</p><p><a href="/" style="color:#0a58ca">← back to the catalog</a></p></body></html>`;

export const onRequestGet: PagesFunction<unknown, keyof Params> = async (ctx) => {
  const id = (ctx.params.id as string) || '';
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return new Response(NOT_FOUND_HTML, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  const origin = new URL(ctx.request.url).origin;

  const [catalogResp, indexResp] = await Promise.all([
    fetch(`${origin}/catalog.json`),
    fetch(`${origin}/index.html`),
  ]);
  if (!catalogResp.ok || !indexResp.ok) {
    return new Response('upstream unavailable', { status: 503 });
  }
  const catalog = (await catalogResp.json()) as Catalog;
  const layer = catalog.layers?.find((l) => l.id === id);
  if (!layer) {
    return new Response(NOT_FOUND_HTML, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  const levelMeta = resolveLevelMeta(layer, catalog.level_meta);
  const { title, description, canonical, ogImage, jsonLd, breadcrumbJsonLd } = buildViewDataset(
    layer,
    levelMeta,
    origin,
  );
  const contentHtml = buildViewContent(layer, levelMeta, origin);

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
      },
    }));
};
