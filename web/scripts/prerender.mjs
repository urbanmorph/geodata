// Build-time prerender: produce one large card per admin level.
// Zero JS needed to read or navigate the catalog.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const ROOT = resolve(WEB, '..');

const catalogPath = resolve(ROOT, 'catalog.json');
if (!existsSync(catalogPath)) {
  console.error('catalog.json not found at', catalogPath, '— run scripts/build_catalog.py first');
  process.exit(1);
}
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
await copyFile(catalogPath, resolve(WEB, 'public', 'catalog.json'));

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
const fmtRows = (n) => (n == null ? '—' : n.toLocaleString('en-IN'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Build-time mirror of web/src/seo.ts. Both produce the same head block;
// keep them in sync. Edge runtimes use the TS version.
const ORIGIN = 'https://geodata-3ij.pages.dev';

// Canonical-URL form of a licence id, used in schema.org Dataset.license.
function licenseUrl(id) {
  const map = {
    'CC0-1.0':       'https://creativecommons.org/publicdomain/zero/1.0/',
    'CC-BY-4.0':     'https://creativecommons.org/licenses/by/4.0/',
    'CC-BY-SA-4.0':  'https://creativecommons.org/licenses/by-sa/4.0/',
    'ODbL-1.0':      'https://opendatacommons.org/licenses/odbl/1-0/',
    'ODC-PDDL-1.0':  'https://opendatacommons.org/licenses/pddl/1-0/',
    'GODL-India':    'https://data.gov.in/government-open-data-license-india',
  };
  if (!id) return undefined;
  // dual e.g. "CC0-1.0 / CC-BY-4.0" — pick the most permissive.
  const first = id.split('/')[0].trim();
  return map[first] || undefined;
}
function seoHead(o) {
  const title = `${o.title} · geodata`;
  const image = o.image || ORIGIN + '/og-default.png';
  const type = o.type || 'website';
  const ld = o.structuredData
    ? `<script type="application/ld+json">${JSON.stringify(o.structuredData).replace(/</g, '\\u003c')}</script>`
    : '';
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(o.description)}" />`,
    `<link rel="canonical" href="${esc(o.url)}" />`,
    `<meta property="og:type" content="${type}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(o.description)}" />`,
    `<meta property="og:url" content="${esc(o.url)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:site_name" content="geodata" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(o.description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    ld,
  ].filter(Boolean).join('\n    ');
}

// Per-level descriptions and unit labels — plain English, not table-speak.
const LEVEL_META = {
  state: {
    label: 'States',
    unit: 'states & UTs',
    description: 'Pan-India state and Union Territory boundaries. The base layer for every drill-down.',
  },
  district: {
    label: 'Districts',
    unit: 'districts',
    description: 'Every district in India. Joins to states via the LGD code.',
  },
  subdistrict: {
    label: 'Sub-districts',
    unit: 'sub-districts',
    description: 'Tehsils, talukas and sub-divisions — the layer below a district.',
  },
  block: {
    label: 'Blocks',
    unit: 'community-development blocks',
    description: 'Community-development blocks. The administrative unit that groups villages.',
  },
  village: {
    label: 'Villages',
    unit: 'villages',
    description: 'Every revenue village in India. The finest admin polygon — 584k of them.',
  },
};
const LEVEL_ORDER = ['state', 'district', 'subdistrict', 'block', 'village'];

// Pick the primary layer for each level. LGD is canonical wherever it exists.
function pickPrimary(layers) {
  return layers.find((l) => l.source === 'LGD') || layers[0];
}

function downloadLinks(layer) {
  const items = [];
  if (layer.parquet?.url) items.push({ fmt: 'parquet', url: layer.parquet.url, size: layer.parquet.bytes });
  if (layer.pmtiles?.url) items.push({ fmt: 'pmtiles', url: layer.pmtiles.url, size: layer.pmtiles.bytes });
  if (layer.geojson?.url) items.push({ fmt: 'geojson', url: layer.geojson.url, size: layer.geojson.bytes });
  return items;
}

function renderRow(level, layersForLevel) {
  const meta = LEVEL_META[level];
  if (!meta) return '';
  const primary = pickPrimary(layersForLevel);
  const others = layersForLevel.filter((l) => l !== primary);

  const viewable = !!(primary.pmtiles?.url || primary.geojson?.url);
  // Only LGD layers carry the code chain that powers the in-viewer state filter.
  const filterable = viewable && primary.source === 'LGD';
  const viewBtn = viewable
    ? `<a href="#view/${esc(primary.id)}" class="btn-primary">View map →</a>`
    : `<span class="btn-primary disabled" title="No map for this layer">no map</span>`;

  const downloads = downloadLinks(primary);
  const dlInline = downloads.length
    ? `<span class="dl-inline">${downloads
        .map(
          (d, i) =>
            `${i > 0 ? '<span class="dot">·</span>' : ''}<a href="${esc(d.url)}" download>${esc(d.fmt)}</a><span class="size">${fmtBytes(d.size)}</span>`
        )
        .join('')}</span>`
    : '';

  // Include the LGD primary as the first row of the comparison so the user
  // can eyeball count + provenance differences against the alt sources.
  const altSection = others.length
    ? `<details class="alt">
        <summary>compare sources: LGD · ${others.map((o) => esc(o.source)).join(' · ')}</summary>
        <div class="alt__list">
          ${[primary, ...others]
            .map((o, i) => {
              const isPrimary = i === 0;
              const dl = downloadLinks(o);
              const links = dl
                .map((d) => `<a href="${esc(d.url)}" download>${esc(d.fmt)}</a>`)
                .join('<span class="dot">·</span>');
              return `<div class="alt__row${isPrimary ? ' alt__row--primary' : ''}">
                <span class="src">${esc(o.source)}${isPrimary ? ' <span class="tag">primary</span>' : ''}</span>
                <span class="meta">${fmtRows(o.rows)} rows · ${esc(o.notes || '')}</span>
                <span class="links">${links || '<span class="muted">—</span>'}</span>
              </div>`;
            })
            .join('')}
        </div>
      </details>`
    : '';

  const lic = primary.licence ? `<span class="lic"><code>${esc(primary.licence)}</code></span>` : '';

  const viewerHint = filterable
    ? `<p class="row__viewer-hint">↳ Inside the viewer: slice by state · instant download as <strong>GeoJSON</strong> (QGIS, web) or <strong>KML</strong> (Google Earth & Maps)</p>`
    : '';

  return `<section class="row" id="${esc(level)}">
      <div class="row__head">
        <span class="row__title">${esc(meta.label)}</span>
        <span class="row__meta">${fmtRows(primary.rows)} ${esc(meta.unit)}<span class="dot">·</span>${lic}</span>
      </div>
      <p class="row__desc">${esc(meta.description)}</p>
      <div class="row__actions">
        ${viewBtn}
        ${dlInline}
      </div>
      ${viewerHint}
      ${altSection}
    </section>`;
}

// Group layers by level
const byLevel = {};
for (const l of catalog.layers) {
  (byLevel[l.level] ||= []).push(l);
}
const cards = LEVEL_ORDER.filter((lvl) => byLevel[lvl]?.length)
  .map((lvl) => renderRow(lvl, byLevel[lvl]))
  .join('\n');

// Attribution footer
const attrLinks = Object.entries(catalog.attribution || {})
  .filter(([k]) => !k.startsWith('_'))
  .map(([, val]) => `<a href="${esc(val.url)}" target="_blank" rel="noopener">${esc(val.name)}</a>`)
  .join(' · ');
const publisher = catalog.attribution?._publisher;
const publisherLink = publisher
  ? `<a href="${esc(publisher.url)}" target="_blank" rel="noopener">${esc(publisher.name)}</a>`
  : '';

// Inline the SMALL parts of the catalog so map + filter open with zero
// network roundtrips for the common case. The extracts manifest (~60 KB,
// 405 entries) is only needed when the user clicks a format download
// button — that lazy-fetches the full catalog.
const inlineCatalogObj = { ...catalog };
delete inlineCatalogObj.extracts;
delete inlineCatalogObj.state_extracts;
const inlineCatalog = JSON.stringify(inlineCatalogObj);

// SEO head for the home page (+ JSON-LD Dataset for each curated layer)
const homeSeo = seoHead({
  title: 'India admin boundaries · view, slice, download',
  description:
    'Open-source visualiser for India admin boundaries — state, district, sub-district, block, village. View on a map, slice by state, download as Parquet, GeoJSON or KML. No signup, no API key.',
  url: ORIGIN + '/',
  structuredData: {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        name: 'geodata',
        url: ORIGIN + '/',
        description: 'Open-source visualiser for India admin boundaries',
      },
      ...catalog.layers
        .filter((l) => l.source === 'LGD' && (l.parquet?.url || l.pmtiles?.url))
        .map((l) => ({
          '@type': 'Dataset',
          name: `${LEVEL_META[l.level]?.label ?? l.id} (LGD)`,
          description: LEVEL_META[l.level]?.description ?? l.notes ?? '',
          url: ORIGIN + '/#' + l.level,
          license: licenseUrl(l.licence),
          creator: l.attribution?.primary
            ? { '@type': 'Organization', name: l.attribution.primary.name, url: l.attribution.primary.url }
            : undefined,
          distribution: [
            l.parquet?.url && { '@type': 'DataDownload', encodingFormat: 'application/x-parquet', contentUrl: l.parquet.url, contentSize: l.parquet.bytes },
            l.pmtiles?.url && { '@type': 'DataDownload', encodingFormat: 'application/vnd.pmtiles', contentUrl: l.pmtiles.url, contentSize: l.pmtiles.bytes },
          ].filter(Boolean),
          spatialCoverage: { '@type': 'Place', name: 'India' },
        })),
    ],
  },
});

const tmpl = await readFile(resolve(WEB, 'index.template.html'), 'utf8');
const out = tmpl
  .replace('<!-- LEVEL_CARDS -->', cards)
  .replace('<!-- GENERATED -->', esc(catalog.generated || ''))
  .replace('<!-- ATTR_LINKS -->', attrLinks)
  .replace('<!-- PUBLISHER -->', publisherLink)
  .replace('<!-- SEO_HEAD -->', homeSeo)
  .replace('<!-- CATALOG_INLINE -->', `<script type="application/json" id="catalog-data">${inlineCatalog.replace(/</g, '\\u003c')}</script>`);

await writeFile(resolve(WEB, 'index.html'), out);
console.log(`prerendered ${LEVEL_ORDER.filter((l) => byLevel[l]?.length).length} level cards (+ inline catalog ${inlineCatalog.length} B)`);

// /about page — same shell, dedicated content. Lives at /about (CF Pages strips .html).
const aboutTmplPath = resolve(WEB, 'about.template.html');
if (existsSync(aboutTmplPath)) {
  const aboutTmpl = await readFile(aboutTmplPath, 'utf8');
  const aboutSeo = seoHead({
    title: 'About',
    description: 'geodata is an open-source visualiser for India\'s geo data. View, slice and contribute admin-boundary and community-submitted layers — no signup, no API key, no tracking.',
    url: ORIGIN + '/about',
    structuredData: {
      '@context': 'https://schema.org',
      '@type': 'AboutPage',
      name: 'About geodata',
      url: ORIGIN + '/about',
    },
  });
  const aboutOut = aboutTmpl
    .replace('<!-- SEO_HEAD -->', aboutSeo)
    .replace('<!-- GENERATED -->', esc(catalog.generated || ''))
    .replace('<!-- ATTR_LINKS -->', attrLinks);
  await writeFile(resolve(WEB, 'about.html'), aboutOut);
  console.log(`prerendered /about`);
}

// Static sitemap.xml — emitted at build time. Edge function later stitches in /c/[id].
const sitemapUrls = [
  { loc: ORIGIN + '/', changefreq: 'weekly', priority: '1.0' },
  { loc: ORIGIN + '/about', changefreq: 'monthly', priority: '0.8' },
  { loc: ORIGIN + '/verify', changefreq: 'monthly', priority: '0.6' },
  { loc: ORIGIN + '/submit', changefreq: 'monthly', priority: '0.6' },
];
const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
await writeFile(resolve(WEB, 'public', 'sitemap.xml'), sitemapXml);
console.log(`wrote sitemap.xml (${sitemapUrls.length} static URLs)`);
