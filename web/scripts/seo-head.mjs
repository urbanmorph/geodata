// SEO head block (title, description, canonical, OG/Twitter, JSON-LD) for the
// prerendered pages (prerender.mjs) and the release pages (releases-page.mjs).
// /view pages rewrite theirs at the edge (functions/view).
import { escapeHtml as esc } from '../../shared/format.mjs';
import { SITE_ORIGIN } from '../../shared/sitemap.mjs';
import { ogImage } from './og-image-url.mjs';

/** BreadcrumbList from [name, path] pairs, Home first. */
export function crumbs(...trail) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: [['Home', '/'], ...trail].map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE_ORIGIN + path })),
  };
}

/**
 * `brief` leaves out og:locale and the Twitter title and description: the release
 * pages shipped without them, and this keeps their bytes the same.
 */
export function seoHead({ title, description, url, image = ogImage('og-default'), type = 'website', structuredData, brief = false }) {
  const full = `${title} · bharatlas`;
  return [
    `<title>${esc(full)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="${type}" />`,
    `<meta property="og:title" content="${esc(full)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:site_name" content="bharatlas" />`,
    !brief && `<meta property="og:locale" content="en_IN" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    !brief && `<meta name="twitter:title" content="${esc(full)}" />`,
    !brief && `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    structuredData && `<script type="application/ld+json">${JSON.stringify(structuredData).replace(/</g, '\\u003c')}</script>`,
  ].filter(Boolean).join('\n    ');
}
