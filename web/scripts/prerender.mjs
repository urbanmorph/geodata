// Build-time prerender: produce one large card per admin level.
// Zero JS needed to read or navigate the catalog.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { TOKENS, renderNav, FOOTER } from './shared-chrome.mjs';

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
// Compact count formatter — "1,234" gets noisy in line; short forms scan.
function fmtCount(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

// Human-readable "X ago" — coarse buckets, no library needed.
function relativeTime(iso) {
  if (!iso) return '';
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
  if (days < 1) return 'updated today';
  if (days < 7) return `updated ${days}d ago`;
  if (days < 30) return `updated ${Math.floor(days / 7)}w ago`;
  if (days < 365) return `updated ${Math.floor(days / 30)}mo ago`;
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  return months > 0 ? `updated ${years}y ${months}mo ago` : `updated ${years}y ago`;
}

// Anything older than this is highlighted as stale on the card.
const STALE_DAYS = 180;
function isStale(iso) {
  if (!iso) return false;
  return (Date.now() - new Date(iso).getTime()) / 86400000 > STALE_DAYS;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Build-time mirror of web/src/seo.ts. Both produce the same head block;
// keep them in sync. Edge runtimes use the TS version.
const ORIGIN = 'https://bharatlas.com';

// TOKENS, renderNav, FOOTER imported from ./shared-chrome.mjs above
// (extracted so vitest can test the pure helpers).

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
  const title = `${o.title} · bharatlas`;
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

// Map an R2 public URL to the /api/dl/<path> route so every click hits the
// counter Pages Function. PMTiles bypasses (Range-fetched by MapLibre).
function dlUrl(r2Url, fmt) {
  if (!r2Url) return r2Url;
  if (fmt === 'pmtiles') return r2Url;
  const m = r2Url.match(/^https?:\/\/[^/]+\/(.+)$/);
  return m ? `/api/dl/${m[1]}` : r2Url;
}

function countFor(layer, fmt) {
  const cnt = catalog.download_counts?.[layer.id]?.['']?.[fmt];
  return typeof cnt === 'number' && cnt > 0 ? cnt : 0;
}

function downloadLinks(layer) {
  const items = [];
  if (layer.parquet?.url) items.push({ fmt: 'parquet', url: dlUrl(layer.parquet.url, 'parquet'), size: layer.parquet.bytes, count: countFor(layer, 'parquet') });
  if (layer.pmtiles?.url) items.push({ fmt: 'pmtiles', url: dlUrl(layer.pmtiles.url, 'pmtiles'), size: layer.pmtiles.bytes, count: countFor(layer, 'pmtiles') });
  if (layer.geojson?.url) items.push({ fmt: 'geojson', url: dlUrl(layer.geojson.url, 'geojson'), size: layer.geojson.bytes, count: countFor(layer, 'geojson') });
  return items;
}

function renderRow(level, layersForLevel) {
  const meta = LEVEL_META[level];
  if (!meta) return '';
  const primary = pickPrimary(layersForLevel);
  const hasOthers = layersForLevel.length > 1;

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
            `${i > 0 ? '<span class="dot">·</span>' : ''}<a href="${esc(d.url)}" download>${esc(d.fmt)}</a><span class="size">${fmtBytes(d.size)}</span>${d.count ? `<span class="count" title="${d.count.toLocaleString('en-IN')} downloads">${fmtCount(d.count)}</span>` : ''}`
        )
        .join('')}</span>`
    : '';

  // Iterate the full layer list (primary stays in its natural slot) and tag
  // the primary row inline so we don't rebuild the array.
  const altSection = hasOthers
    ? `<details class="alt">
        <summary>compare sources: ${layersForLevel.map((o) => esc(o.source)).join(' · ')}</summary>
        <div class="alt__list">
          ${layersForLevel
            .map((o) => {
              const isPrimary = o === primary;
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

  const freshnessSpan = primary.fetched_at
    ? `<span class="row__freshness${isStale(primary.fetched_at) ? ' stale' : ''}" title="${esc(primary.fetched_at)}">${relativeTime(primary.fetched_at)}</span>`
    : '';
  const sourceText = primary.attribution?.primary
    ? `Source: <a href="${esc(primary.attribution.primary.url)}" target="_blank" rel="noopener">${esc(primary.attribution.primary.name)}</a>`
    : '';
  const sourceLine =
    sourceText || freshnessSpan
      ? `<p class="row__source">${sourceText}${sourceText && freshnessSpan ? ' <span class="dot">·</span> ' : ''}${freshnessSpan}</p>`
      : '';

  const dataAttrs = [
    `data-id="${esc(primary.id)}"`,
    `data-level="${esc(level)}"`,
    `data-category="${esc(primary.category || 'administrative')}"`,
    `data-provenance="${esc(primary.provenance || 'curated')}"`,
    `data-source="${esc(primary.source)}"`,
    `data-search="${esc((meta.label + ' ' + meta.description + ' ' + (primary.attribution?.primary?.name || '') + ' ' + (primary.notes || '')).toLowerCase())}"`,
  ].join(' ');

  return `<section class="row row--curated" id="${esc(level)}" ${dataAttrs}>
      <div class="row__head">
        <span class="row__title">${esc(meta.label)} <span class="badge badge--curated" title="Curated by urbanmorph from LGD">curated</span></span>
        <span class="row__meta">${fmtRows(primary.rows)} ${esc(meta.unit)}<span class="dot">·</span>${lic}</span>
      </div>
      <p class="row__desc">${esc(meta.description)}</p>
      ${sourceLine}
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

// Attribution links — used by the /about page footer only (the home page
// now shows per-card source links instead of a global dump).
const attrLinks = Object.entries(catalog.attribution || {})
  .filter(([k]) => !k.startsWith('_'))
  .map(([, val]) => `<a href="${esc(val.url)}" target="_blank" rel="noopener">${esc(val.name)}</a>`)
  .join(' · ');

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
  title: "India's open atlas · view, verify, contribute",
  description:
    "India's official admin boundaries from state to village — view on a map, slice by state, download as Parquet, GeoJSON or KML. Drop your own file to verify, or contribute a new layer under an open licence. No signup, no API key, no tracking.",
  url: ORIGIN + '/',
  structuredData: {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        name: 'geodata',
        url: ORIGIN + '/',
        description:
          "Open catalog, verifier and contribution flow for India's geo data — admin boundaries plus community layers.",
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

// Category chips: count layers per category, render an "All" chip + one per
// non-empty category. Hide chip row entirely when only one category is in play.
// Categories not declared in catalog.categories fall through to 'other'.
const knownCats = new Set(Object.keys(catalog.categories || {}));
const categoryCounts = {};
for (const l of catalog.layers || []) {
  const cat = l.category && knownCats.has(l.category) ? l.category : 'other';
  if (l.category && !knownCats.has(l.category)) {
    console.warn(`[prerender] layer ${l.id} has unknown category "${l.category}" — bucketing as "other"`);
  }
  categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
}
const totalLayers = (catalog.layers || []).length;
const activeCats = Object.entries(catalog.categories || {})
  .filter(([id]) => categoryCounts[id]);
const chips = [
  `<button class="catalog-chip active" data-cat="all" data-count="${totalLayers}">All <span class="count">${totalLayers}</span></button>`,
  ...activeCats.map(
    ([id, name]) => `<button class="catalog-chip" data-cat="${esc(id)}" data-count="${categoryCounts[id]}">${esc(name)} <span class="count">${categoryCounts[id]}</span></button>`,
  ),
];
// Only render chips when there's more than one category to switch between
// (with just admin layers today, the chip row would be noise).
const chipsHtml = activeCats.length > 1 ? chips.join('') : '';

// Community submissions: query D1 (local by default; --remote in prod build
// once that's wired). Silently empty on failure so a missing wrangler /
// missing DB doesn't break the build.
const COMMUNITY_FROM = process.env.COMMUNITY_FROM || 'local'; // local | remote
function fetchCommunitySubmissions() {
  try {
    const out = execSync(
      `npx --yes wrangler d1 execute geodata-submissions --${COMMUNITY_FROM} --json --command "${
        'SELECT s.id, s.name, s.description, s.category, s.attribution, s.is_original, ' +
        's.format, s.bytes, s.feature_count, s.r2_key, s.created_at, ' +
        "COALESCE(SUM(CASE WHEN r.vote = 1 THEN 1 ELSE 0 END), 0) AS up_count, " +
        "COALESCE(SUM(CASE WHEN r.vote = -1 THEN 1 ELSE 0 END), 0) AS down_count " +
        'FROM submissions s LEFT JOIN submission_ratings r ON r.submission_id = s.id ' +
        "WHERE s.status='accepted' GROUP BY s.id ORDER BY s.created_at DESC LIMIT 200"
      }"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const data = JSON.parse(out);
    return (data?.[0]?.results || []).map((r) => ({
      ...r,
      up_count: Number(r.up_count) || 0,
      down_count: Number(r.down_count) || 0,
      score: (Number(r.up_count) || 0) - (Number(r.down_count) || 0),
    }));
  } catch {
    return [];
  }
}
const community = fetchCommunitySubmissions();

function renderCommunityCard(s) {
  const score = s.score;
  const dataAttrs = [
    `data-id="${esc(s.id)}"`,
    `data-score="${score}"`,
    `data-created="${esc(s.created_at)}"`,
  ].join(' ');
  const credit = s.is_original ? `original work by ${esc(s.attribution)}` : `source: ${esc(s.attribution)}`;
  return `<article class="comm-card" ${dataAttrs}>
    <div class="comm-card__head">
      <div class="comm-card__title"><a href="/c/${esc(s.id)}">${esc(s.name)}</a><span class="badge">community</span></div>
      <div class="comm-card__score" title="up ${s.up_count} · down ${s.down_count}">
        <span class="up">▲ ${s.up_count}</span> · <span class="down">▼ ${s.down_count}</span>
      </div>
    </div>
    ${s.description ? `<p class="comm-card__desc">${esc(s.description)}</p>` : ''}
    <div class="comm-card__meta">${esc(s.category || 'other')} · ${esc(s.format)} · ${s.feature_count != null ? s.feature_count.toLocaleString('en-IN') + ' features · ' : ''}${credit}</div>
  </article>`;
}

const communityHtml = community.length
  ? `<section class="community-section">
      <h2>Community submissions <span style="color:var(--muted);font-weight:400">· ${community.length}</span></h2>
      <p class="lede-line">Open-licensed contributions from anyone — verify provenance via the source link on each card.</p>
      <div class="sort-toggle" role="tablist">
        <button class="active" data-sort="recent" type="button">Recent</button>
        <button data-sort="popular" type="button">Popular</button>
      </div>
      <div class="comm-grid" id="community-grid">
        ${community.map(renderCommunityCard).join('\n')}
      </div>
    </section>
    <script>
      (() => {
        const grid = document.getElementById('community-grid');
        const buttons = document.querySelectorAll('.sort-toggle button');
        if (!grid || !buttons.length) return;
        const cards = Array.from(grid.children);

        // Live-hydrate scores so votes from /c/<id> show up without waiting
        // for the next prerender. Falls through silently on failure — the
        // prerendered scores remain visible.
        fetch('/api/community/scores').then(r => r.ok ? r.json() : null).then(rows => {
          if (!Array.isArray(rows)) return;
          const byId = Object.fromEntries(rows.map(s => [s.id, s]));
          for (const card of cards) {
            const id = card.dataset.id;
            const s = byId[id];
            if (!s) continue;
            const up = Number(s.up) || 0, down = Number(s.down) || 0;
            card.dataset.score = String(up - down);
            const upEl = card.querySelector('.comm-card__score .up');
            const downEl = card.querySelector('.comm-card__score .down');
            if (upEl) upEl.textContent = '▲ ' + up;
            if (downEl) downEl.textContent = '▼ ' + down;
          }
          // re-apply current sort
          const active = document.querySelector('.sort-toggle button.active');
          sortBy(active?.dataset.sort || 'recent');
        }).catch(() => {});

        function sortBy(mode) {
          const sorted = cards.slice().sort((a, b) => {
            if (mode === 'popular') {
              const d = Number(b.dataset.score) - Number(a.dataset.score);
              if (d !== 0) return d;
            }
            return b.dataset.created.localeCompare(a.dataset.created);
          });
          grid.replaceChildren(...sorted);
        }
        buttons.forEach((btn) => btn.addEventListener('click', () => {
          buttons.forEach((b) => b.classList.toggle('active', b === btn));
          sortBy(btn.dataset.sort);
        }));
      })();
    </script>`
  : '';

const tmpl = await readFile(resolve(WEB, 'index.template.html'), 'utf8');
const out = tmpl
  .replace('<!-- LEVEL_CARDS -->', cards)
  .replace('<!-- COMMUNITY_SECTION -->', communityHtml)
  .replace('<!-- CATEGORY_CHIPS -->', chipsHtml)
  .replace('<!-- GENERATED -->', esc(catalog.generated || ''))
  .replace('<!-- SEO_HEAD -->', homeSeo)
  .replace('<!-- TOKENS -->', TOKENS)
  .replace('<!-- NAV -->', renderNav('catalog'))
  .replace('<!-- FOOTER -->', FOOTER)
  .replace('<!-- CATALOG_INLINE -->', `<script type="application/json" id="catalog-data">${inlineCatalog.replace(/</g, '\\u003c')}</script>`);

await writeFile(resolve(WEB, 'index.html'), out);
console.log(`prerendered home — ${LEVEL_ORDER.filter((l) => byLevel[l]?.length).length} curated, ${community.length} community`);

// Helper: prerender a page that just needs an SEO head.
async function renderPage(name, seoOpts, extra = {}, navKey = name) {
  const path = resolve(WEB, `${name}.template.html`);
  if (!existsSync(path)) return;
  const tmpl = await readFile(path, 'utf8');
  let out = tmpl
    .replace('<!-- SEO_HEAD -->', seoHead(seoOpts))
    .replace('<!-- GENERATED -->', esc(catalog.generated || ''))
    .replace('<!-- TOKENS -->', TOKENS)
    .replace('<!-- NAV -->', renderNav(navKey))
    .replace('<!-- FOOTER -->', FOOTER);
  for (const [k, v] of Object.entries(extra)) out = out.replace(`<!-- ${k} -->`, v);
  await writeFile(resolve(WEB, `${name}.html`), out);
  console.log(`prerendered /${name}`);
}

await renderPage('about', {
  title: 'About',
  description:
    "Bharatlas — a visual catalog, drag-drop verifier, and anonymous contribution flow for India's geo data. Admin boundaries from state to village, plus community-submitted layers under open licences. No signup, no API key, no tracking.",
  url: ORIGIN + '/about',
  structuredData: {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    name: 'About geodata',
    url: ORIGIN + '/about',
  },
}, { ATTR_LINKS: attrLinks });

await renderPage('verify', {
  title: 'Verify · drop a geo file',
  description: 'Drag-drop a GeoJSON, KML, KMZ, GPX, TCX or Parquet file to render it on a map and check CRS, geometry validity, properties — all in your browser, nothing uploaded.',
  url: ORIGIN + '/verify',
  structuredData: {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'geodata · verify',
    url: ORIGIN + '/verify',
    applicationCategory: 'UtilityApplication',
    operatingSystem: 'Web',
  },
});

// Turnstile site key — Cloudflare's test key (always passes) when no env override.
// In production, set TURNSTILE_SITEKEY in the deploy environment.
const TURNSTILE_SITEKEY = process.env.TURNSTILE_SITEKEY || '1x00000000000000000000AA';

await renderPage(
  'submit',
  {
    title: 'Submit · contribute a geo layer',
    description:
      "Submit your own geo content to India's open atlas under an open licence — no signup, no email. Get a shareable URL and admin token in seconds.",
    url: ORIGIN + '/submit',
    structuredData: {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'geodata · submit',
      url: ORIGIN + '/submit',
      applicationCategory: 'UtilityApplication',
      operatingSystem: 'Web',
    },
  },
  { TURNSTILE_SITEKEY },
);

// Static sitemap.xml — emitted at build time. Edge function later stitches in /c/[id].
const sitemapUrls = [
  { loc: ORIGIN + '/', changefreq: 'weekly', priority: '1.0' },
  { loc: ORIGIN + '/about', changefreq: 'monthly', priority: '0.8' },
  { loc: ORIGIN + '/verify', changefreq: 'monthly', priority: '0.7' },
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
