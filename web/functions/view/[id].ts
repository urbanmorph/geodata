// GET /view/<id> — curated-layer canonical share URL.
//
// Cloudflare Pages serves index.html as the SPA. For social-card crawlers
// to see a layer-specific OG image (not the generic og-default), we fetch
// index.html and rewrite its meta tags via HTMLRewriter. The browser-side
// bundle is the same; main.ts detects /view/<id> and opens that layer.

type Params = { id: string };

type Catalog = {
  layers?: Array<{
    id: string;
    level: string;
    source: string;
    rows: number | null;
    licence?: string;
  }>;
  level_meta?: Record<string, { label: string; unit?: string; description?: string }>;
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
  const levelMeta = catalog.level_meta?.[layer.level];
  const title = levelMeta?.label || layer.id.replace(/_/g, ' ');
  const unit = levelMeta?.unit || 'features';
  const count = layer.rows != null ? layer.rows.toLocaleString('en-IN') : null;
  const baseDescription = levelMeta?.description ?? `${title} — ${count ? count + ' ' + unit + ' · ' : ''}${layer.source}.`;
  // Meta tag uses Google's snippet ceiling (158); JSON-LD Dataset needs ≥50
  // chars (Google Dataset Search rejects shorter). Pad with a stable suffix
  // when the source string falls under the JSON-LD minimum.
  const description = baseDescription.slice(0, 158);
  const ldDescription = baseDescription.length >= 80
    ? baseDescription
    : `${baseDescription} Part of the bharatlas open atlas of India's geospatial data, sourced from ${layer.source}.`;
  const canonical = `${origin}/view/${id}`;
  const ogImage = `${origin}/og/view/${id}.png`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: title,
    description: ldDescription,
    url: canonical,
    license: layer.licence ? mapLicenceUrl(layer.licence) : undefined,
    creator: { '@type': 'Organization', name: layer.source },
    spatialCoverage: { '@type': 'Place', name: 'India' },
  };

  // HTMLRewriter.setAttribute HTML-escapes the value itself — passing pre-escaped
  // strings produces &amp;quot; etc.
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

function mapLicenceUrl(licence: string): string {
  if (licence.includes('CC0')) return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (licence.includes('CC-BY-SA')) return 'https://creativecommons.org/licenses/by-sa/4.0/';
  if (licence.includes('CC-BY')) return 'https://creativecommons.org/licenses/by/4.0/';
  if (licence.includes('ODbL')) return 'https://opendatacommons.org/licenses/odbl/1-0/';
  return licence;
}
