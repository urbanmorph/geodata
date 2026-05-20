// SEO head block — emits <title>, description, canonical, OG, Twitter, JSON-LD.
// Called by prerender.mjs for static pages and by the /c/[id] edge function later.

import { escapeHtml } from './util';

export type SeoOpts = {
  title: string;             // page title (the "geodata · " suffix is appended)
  description: string;
  url: string;               // canonical absolute URL
  image?: string;            // OG card. Defaults to /og-default.png
  type?: 'website' | 'article';
  structuredData?: object;   // schema.org JSON-LD object (will be JSON-stringified)
};

const ORIGIN = 'https://geodata-3ij.pages.dev';
const DEFAULT_IMAGE = ORIGIN + '/og-default.png';

export function seoHead(o: SeoOpts): string {
  const title = `${o.title} · geodata`;
  const image = o.image || DEFAULT_IMAGE;
  const type = o.type || 'website';
  const ld = o.structuredData
    ? `<script type="application/ld+json">${
        JSON.stringify(o.structuredData).replace(/</g, '\\u003c')
      }</script>`
    : '';
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(o.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(o.url)}" />`,
    `<meta property="og:type" content="${type}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(o.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(o.url)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:site_name" content="geodata" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(o.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
    ld,
  ].filter(Boolean).join('\n    ');
}

