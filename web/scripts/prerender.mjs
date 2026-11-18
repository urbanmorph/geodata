// Build-time prerender: produce one large card per admin level.
// Zero JS needed to read or navigate the catalog.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fetchLiveCounts, bakedCounts, countFor as layerCount, totalDownloads, mostDownloaded } from './download-counts.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { TOKENS, renderNav, FOOTER } from './shared-chrome.mjs';
import { escapeHtml as esc, fmtBytes, fmtCount, fmtDate, fmtInt } from '../../shared/format.mjs';
import { licenceUrl, licenceBadgeHtml, layerIsNonCommercial, NC_LABEL } from '../../shared/licences.mjs';
import { viewMapLink, wholeFileBytes, inlineMapLink } from '../../shared/large-load.mjs';
import { brandMarkSvg } from '../../shared/brand.mjs';
import { THEME_DESC, THEME_GLYPH } from './themes.mjs';
import { indiaMapHtml } from './india-map.mjs';
import { WARD_BBOXES } from '../functions/lib/ward-bboxes.ts';
import { DEFAULT_LOCATE_LAYERS } from '../functions/lib/locate-layers.ts';
import { fillTemplate } from './fill-template.mjs';
import { docsStats } from './docs-stats.mjs';
import { renderCommunityActions, channelOf, CHANNEL_LABEL, dlProxyUrl } from './community-card.mjs';
import { expandAliases, buildBodyHaystack } from '../src/search-aliases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const ROOT = resolve(WEB, '..');

const catalogPath = resolve(ROOT, 'catalog.json');
if (!existsSync(catalogPath)) {
  console.error('catalog.json not found at', catalogPath, '— run scripts/build_catalog.py first');
  process.exit(1);
}
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
// The home search's index (/layer-index.json): one entry per /layers row,
// pushed by renderRow / renderCommunityCard from the same values the row shows.
const layerIndex = [];
// Live download counts (falls back to the catalog snapshot if unreachable).
const liveCounts = await fetchLiveCounts();
const dlCounts = bakedCounts(catalog, liveCounts);
console.log(`download counts: ${liveCounts ? 'live' : 'catalog snapshot'} (total ${totalDownloads(dlCounts)})`);
await copyFile(catalogPath, resolve(WEB, 'public', 'catalog.json'));


// Keep in sync with web/src/util.ts:escapeHtml

// SEO head block (title, description, canonical, OG/Twitter, JSON-LD) for the
// prerendered pages. /view pages rewrite theirs at the edge (functions/view).
const ORIGIN = 'https://bharatlas.com';
// How many layers /api/v1/locate checks by default (the FAQ copy on /docs and /mcp).
const LOCATE_N = DEFAULT_LOCATE_LAYERS.length;

// TOKENS, renderNav, FOOTER imported from ./shared-chrome.mjs above
// (extracted so vitest can test the pure helpers).

// Google Dataset Search rejects schema.org Dataset entries whose description
// is under ~50 chars. Pad short notes with a stable contextual suffix so
// future drift (short notes / new layers with terse meta.description) doesn't
// re-trigger Search Console warnings.
const DATASET_DESC_MIN = 80;
function padDatasetDescription(desc, name, source) {
  const trimmed = (desc || '').trim();
  if (trimmed.length >= DATASET_DESC_MIN) return trimmed;
  // Padded suffix lifts terse level descriptions over Google's Dataset
  // Search ≥50 floor with margin and adds format keywords + provenance
  // for richer SERP snippets. Stays under the ~250-char rich-snippet cap
  // when combined with the longest level description (~110 chars).
  const suffix = ` Free to view, slice and download as Parquet, PMTiles, GeoJSON or KML. Open atlas of India by Urban Morph, sourced from ${source}.`;
  return (trimmed + suffix).trim();
}

// Link previews (LinkedIn, WhatsApp, X) cache a share image by URL for weeks,
// so the URL carries the image's content hash: a new image is a new URL.
const ogImageCache = new Map();
function ogImage(name) {
  if (!ogImageCache.has(name)) {
    const hash = createHash('sha256').update(readFileSync(resolve(WEB, 'public', `${name}.png`))).digest('hex');
    ogImageCache.set(name, `${ORIGIN}/${name}.png?v=${hash.slice(0, 10)}`);
  }
  return ogImageCache.get(name);
}

function seoHead(o) {
  const title = `${o.title} · bharatlas`;
  const image = o.image || ogImage('og-default');
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
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:site_name" content="bharatlas" />`,
    `<meta property="og:locale" content="en_IN" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(o.description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    ld,
  ].filter(Boolean).join('\n    ');
}

// Per-level descriptions and unit labels — plain English, not table-speak.
const LEVEL_META = {
  country: {
    label: 'India national boundary (2024)',
    unit: 'country (MultiPolygon)',
    description: "India's national boundary as a single MultiPolygon. Derived by dissolving the 36 LGD state and UT polygons, so it's India-correct by construction (Aksai Chin via J&K/Ladakh, full Arunachal Pradesh claim). LGD snapshot 2024.",
  },
  state: {
    label: 'States (2024)',
    unit: 'states & UTs',
    description: 'Pan-India state and Union Territory boundaries. The base layer for every drill-down. LGD snapshot 2024.',
  },
  district: {
    label: 'Districts (2024)',
    unit: 'districts',
    description: 'Every district in India. Joins to states via the LGD code. LGD snapshot 2024.',
  },
  subdistrict: {
    label: 'Sub-districts (2024)',
    unit: 'sub-districts',
    description: 'Tehsils, talukas and sub-divisions, the layer below a district. LGD snapshot 2024.',
  },
  block: {
    label: 'Blocks (2024)',
    unit: 'community-development blocks',
    description: 'Community-development blocks. The administrative unit that groups villages. LGD snapshot 2024.',
  },
  panchayat: {
    label: 'Gram Panchayats (2024)',
    unit: 'gram panchayats',
    description: 'Village-level local governance units. The constitutional tier below block, above village. 319k polygons. LGD snapshot 2024.',
  },
  village: {
    label: 'Villages (2024)',
    unit: 'villages',
    description: 'Every revenue village in India. The finest admin polygon, 584k of them. LGD snapshot 2024.',
  },

  // Electoral
  parliament_constituency: {
    label: 'Lok Sabha constituencies (2008 delimitation)',
    unit: 'parliament constituencies',
    description: 'All 543 Lok Sabha constituency polygons from the 2008 Delimitation Commission (based on Census 2001). In effect since the 2009 general election.',
  },
  assembly_constituency: {
    label: 'Vidhan Sabha constituencies (2008 delimitation)',
    unit: 'assembly constituencies',
    description: 'State legislative assembly constituency polygons across India. 2008 Delimitation Commission boundaries.',
  },
  high_court: {
    label: 'High Court jurisdictions (2024)',
    unit: 'high courts',
    description: "Territorial jurisdiction of India's 25 High Courts. Dissolved from LGD 2024 state polygons per the constitutional assignment of states to each court.",
  },
  ngt_zone: {
    label: 'NGT zonal benches (2017)',
    unit: 'NGT zones',
    description: "National Green Tribunal's 5 zonal bench jurisdictions (Delhi, Bhopal, Kolkata, Chennai, Pune). Dissolved from LGD state polygons per the 2017 gazette notification.",
  },
  nclt_bench: {
    label: 'NCLT benches (2024)',
    unit: 'NCLT benches',
    description: "National Company Law Tribunal's 15 bench jurisdictions. Dissolved from LGD state polygons per nclt.gov.in bench assignments.",
  },

  // Postal
  pincode: {
    label: 'Pin codes (2025)',
    unit: 'pincode polygons',
    description: 'India Post pincode boundary polygons. Generated 2025. Joinable to many user-supplied datasets via postal code.',
  },

  // Environment
  wildlife: {
    label: 'Wildlife sanctuaries + national parks (2024)',
    unit: 'protected areas',
    description: 'Protected-area polygons across India, wildlife sanctuaries and national parks. Via PM GatiShakti, snapshot 2024.',
  },
  eco_zone: {
    label: 'Eco-sensitive zones (2024)',
    unit: 'eco-sensitive zones',
    description: 'MoEFCC-notified eco-sensitive zones around protected areas. Via Bharatmaps Parivesh, snapshot 2024.',
  },
  forest: {
    label: 'Forest boundaries (SOI)',
    unit: 'forest polygons',
    description: 'Reserved, protected, and unclassed forest boundary polygons from Survey of India topographic maps.',
  },
  ramsar: {
    label: 'Ramsar wetlands (2024)',
    unit: 'Ramsar sites',
    description: "India's wetland sites of international importance under the Ramsar Convention. Via Bharatmaps Parivesh, snapshot 2024.",
  },
  wetland: {
    label: 'Wetland boundaries (2024)',
    unit: 'wetlands',
    description: 'All wetland polygons notified under MoEFCC Wetland Rules 2017. Via Bharatmaps Parivesh, snapshot 2024.',
  },
  river_basin: {
    label: 'River basins (2024)',
    unit: 'major river basins',
    description: "India's major river basin polygons from the Central Water Commission's Water Resources Information System (WRIS). Snapshot 2024.",
  },
  river_subbasin: {
    label: 'River sub-basins (2024)',
    unit: 'sub-basins',
    description: 'One tier finer than basins. For catchment-scale water-resources analysis. From CWC WRIS, snapshot 2024.',
  },
  river: {
    label: 'Rivers + streams (2024)',
    unit: 'river segments',
    description: "India's river network as line geometry. Streams, rivers, and tributaries from CWC WRIS, snapshot 2024.",
  },
  flood_event: {
    label: 'Historical flood polygons (1960s-2020)',
    unit: 'flood events',
    description: 'India Flood Inventory v3.0. 1,006 historical flood event polygons across India from the 1960s to 2020.',
  },
  seismic_zone: {
    label: 'Seismic zones (IS 1893:2016)',
    unit: 'seismic zones',
    description: 'BIS IS 1893:2016 earthquake hazard zones II-V covering all of India. The current national seismic zonation standard.',
  },
  dam: {
    label: 'Dams (2024)',
    unit: 'dams',
    description: 'Dam point locations across India. Two sources: Bharatmaps and CWC WRIS, both snapshot 2024. Compare for cross-source coverage.',
  },
  reservoir: {
    label: 'Reservoirs (2024)',
    unit: 'reservoirs',
    description: 'Reservoir polygons from CWC WRIS, snapshot 2024. Complements the river basin, sub-basin, and river network layers.',
  },
  airport: {
    label: 'Airports (2024)',
    unit: 'airports',
    description: 'Airports across India. 151 point features with name, type, district, and state. From data.gov.in, snapshot 2024.',
  },
  national_highway: {
    label: 'National highways (2024)',
    unit: 'highway segments',
    description: 'National highway centerlines from the Ministry of Road Transport and Highways via PM GatiShakti, snapshot 2024.',
  },
  health_facility: {
    label: 'Health facilities (2020)',
    unit: 'health facilities',
    description: 'Primary Health Centres, Community Health Centres, sub-centres, and district hospitals from NIC HealthGIS. 147,957 point features. Scraped March 2020.',
  },
};
// Hardcoded display order for built-in levels — externally ingested layers
// are appended via merge() below, in catalog.level_order sequence.
const BUILTIN_LEVEL_ORDER = [
  'country',
  'state', 'district', 'subdistrict', 'block', 'panchayat', 'village',
  'parliament_constituency', 'assembly_constituency',
  'high_court', 'ngt_zone', 'nclt_bench',
  'pincode',
  'seismic_zone',
  'dam', 'reservoir',
  'airport', 'national_highway',
  'health_facility',
  'wildlife', 'eco_zone', 'forest',
  'ramsar', 'wetland',
  'river_basin', 'river_subbasin', 'river',
  'flood_event',
];

// Merge externally-ingested level metadata + order from catalog.json.
// Hardcoded LEVEL_META entries take precedence; manifest entries fill
// gaps for ingested layers. LEVEL_ORDER = builtin first, then external
// in their declared order.
const externalMeta = catalog.level_meta || {};
for (const [lvl, m] of Object.entries(externalMeta)) {
  if (!LEVEL_META[lvl]) {
    LEVEL_META[lvl] = {
      label: m.label,
      unit: m.unit || 'features',
      description: m.description,
    };
  }
}
const externalLevels = (catalog.level_order || []).filter(
  (lvl) => !BUILTIN_LEVEL_ORDER.includes(lvl),
);
const LEVEL_ORDER = [...BUILTIN_LEVEL_ORDER, ...externalLevels];

// Themes: catalog.categories is the one list, in display order. A layer or
// submission whose category isn't in it counts as 'other' (catOf), so the
// sections, their counts and the theme index agree.
const CATEGORY_ORDER = Object.keys(catalog.categories || {});
const catOf = (c) => (c && CATEGORY_ORDER.includes(c) ? c : 'other');

// Search-index alias dictionary + haystack builders live in
// ../src/search-aliases.mjs so they have a red-green unit test
// (web/tests/search-aliases.test.ts) and can fold per-layer `tags` into the
// body. expandAliases / buildBodyHaystack are imported at the top.

// Available download formats as a space-joined haystack token list.
// Reflects what the catalog card actually advertises so search ("kml",
// "shapefile") surfaces cards that ship those formats directly.
function formatTokens(layer) {
  const t = [];
  if (layer.parquet?.url) t.push('parquet');
  if (layer.pmtiles?.url) t.push('pmtiles', 'vector tiles');
  if (layer.geojson?.url) t.push('geojson');
  if (layer.kml?.url) t.push('kml', 'google earth');
  if (layer.shapefile?.url) t.push('shapefile', 'shp', 'qgis');
  // Viewer offers in-browser conversion for any parquet layer too —
  // surface 'kml'/'geojson' even when not baked, so search-by-format
  // doesn't hide layers whose downloads route through the viewer.
  if (layer.parquet?.url && !layer.kml?.url) t.push('kml');
  if (layer.parquet?.url && !layer.geojson?.url) t.push('geojson');
  return t.join(' ');
}

// Pick the primary layer for each level. LGD is canonical wherever it exists.
function pickPrimary(layers) {
  return layers.find((l) => l.source === 'LGD') || layers[0];
}

// Map an R2 public URL to the /api/dl/<path> route so every click hits the
// counter Pages Function. PMTiles bypasses (Range-fetched by MapLibre).
function countFor(layer, fmt) {
  return layerCount(dlCounts, layer.id, fmt);
}

function downloadLinks(layer) {
  const items = [];
  if (layer.parquet?.url) items.push({ fmt: 'parquet', url: dlProxyUrl(layer.parquet.url, 'parquet'), size: layer.parquet.bytes, count: countFor(layer, 'parquet') });
  if (layer.pmtiles?.url) items.push({ fmt: 'pmtiles', url: dlProxyUrl(layer.pmtiles.url, 'pmtiles'), size: layer.pmtiles.bytes, count: countFor(layer, 'pmtiles') });
  if (layer.geojson?.url) items.push({ fmt: 'geojson', url: dlProxyUrl(layer.geojson.url, 'geojson'), size: layer.geojson.bytes, count: countFor(layer, 'geojson') });
  if (layer.kml?.url) items.push({ fmt: 'kml', url: dlProxyUrl(layer.kml.url, 'kml'), size: layer.kml.bytes, count: countFor(layer, 'kml') });
  if (layer.shapefile?.url) items.push({ fmt: 'shp', url: dlProxyUrl(layer.shapefile.url, 'shapefile'), size: layer.shapefile.bytes, count: countFor(layer, 'shapefile') });
  return items;
}

function renderRow(level, layersForLevel, opts = {}) {
  const meta = LEVEL_META[level];
  if (!meta) return '';
  const primary = pickPrimary(layersForLevel);
  const hasOthers = layersForLevel.length > 1;
  const collapsed = opts.collapsed ? ' row--collapsed' : '';

  const viewable = !!(primary.pmtiles?.url || primary.geojson?.url);
  // Only LGD layers carry the code chain that powers the in-viewer state filter.
  const filterable = viewable && primary.source === 'LGD';
  // v4.7: link to the canonical /view/<id> path. Edge function serves the
  // home HTML with layer-specific OG meta; main.ts opens the map on load.
  const viewBtn = viewable
    ? viewMapLink(`/view/${primary.id}`, wholeFileBytes(primary), 'btn-primary', 'View map')
    : `<span class="btn-primary disabled" title="No map for this layer">no map</span>`;

  const downloads = downloadLinks(primary);
  const dlInline = downloads.length
    ? `<span class="dl-inline">${downloads
        .map(
          (d, i) =>
            `${i > 0 ? '<span class="dot">·</span>' : ''}<a href="${esc(d.url)}" download>${esc(d.fmt)}</a><span class="size">${fmtBytes(d.size)}</span>${d.count ? `<span class="count" title="${fmtInt(d.count)} downloads">${fmtCount(d.count)}</span>` : ''}`
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
                <span class="meta">${fmtInt(o.rows)} rows · ${esc(o.notes || '')}</span>
                <span class="links">${links || '<span class="muted">—</span>'}</span>
              </div>`;
            })
            .join('')}
        </div>
      </details>`
    : '';

  const nc = layerIsNonCommercial(primary);

  // Viewer-hint message adapts to what's already on the card:
  // - If geojson/kml/shp are baked whole-layer, the hint is just about state slicing.
  // - Otherwise it still advertises the in-viewer instant-convert path.
  const hasBakedDerivative = !!(primary.geojson?.url || primary.kml?.url || primary.shapefile?.url);
  const viewerHint = filterable
    ? (hasBakedDerivative
      ? `<p class="row__viewer-hint">↳ Inside the viewer: slice by state for a single-state subset (full-layer downloads above are India-wide)</p>`
      : `<p class="row__viewer-hint">↳ Inside the viewer: slice by state · instant download as <strong>GeoJSON</strong> (QGIS, web) or <strong>KML</strong> (Google Earth & Maps)</p>`)
    : '';

  // Show alternate sources for the same level inline. This signals plurality
  // at-a-glance — no single source is "the truth" for boundaries / names.
  // Clicking jumps to /view/<id> for that source's version. See terms.html
  // "Limitation of liability" for the editorial position on disputed depictions.
  //
  // Filter to map-renderable sources only (pmtiles or geojson). Parquet-only
  // alternates (some SOI / Bhuvan layers) still exist in the data; their
  // downloads surface in the <details class="alt"> "compare sources" block
  // below. The inline "also:" list is exclusively for "you can view this".
  const altSources = layersForLevel
    .filter((l) => l !== primary && (l.pmtiles?.url || l.geojson?.url))
    .map((l) => inlineMapLink(`/view/${l.id}`, wholeFileBytes(l), l.source));
  const sourceText = primary.attribution?.primary
    ? `Per <a href="${esc(primary.attribution.primary.url)}" target="_blank" rel="noopener">${esc(primary.attribution.primary.name)}</a>${altSources.length ? ` <span class="row__alts">also: ${altSources.join(', ')}</span>` : ''}`
    : '';
  const sourceLine = sourceText ? `<p class="row__source">${sourceText}</p>` : '';

  // Two haystacks so the client filter can do high-signal title matching
  // first, then fall back to body. Without the split, "villages" surfaced
  // Districts / Sub-districts / Blocks whose descriptions explain how they
  // join to villages. See src/catalog-filter.ts for the matcher.
  const primaryHaystack = expandAliases([meta.label, level].join(' ')).toLowerCase();
  const bodyHaystack = buildBodyHaystack({
    description: meta.description,
    attributionName: primary.attribution?.primary?.name || '',
    notes: primary.notes || '',
    source: primary.source || '',
    licence: primary.licence || '',
    category: primary.category || '',
    formats: formatTokens(primary),
    // Source codes from alt layers — so a card surfaces when searching
    // for any of its providers (e.g. "Bhuvan" on the States row).
    altSources: layersForLevel.map((l) => l.source).join(' '),
    // Per-layer search tags (groundwater, over-exploited, agro-ecological…).
    tags: primary.tags,
  });

  const sub = [primary.rows != null ? `${fmtInt(primary.rows)} ${meta.unit || 'features'}` : '', primary.source].filter(Boolean).join(' · ');
  layerIndex.push({ p: primaryHaystack, b: bodyHaystack, t: meta.label, s: sub, h: viewable ? `/view/${primary.id}` : `/layers#${level}`, n: layersForLevel.length });
  const dataAttrs = [
    `data-id="${esc(primary.id)}"`,
    `data-level="${esc(level)}"`,
    `data-category="${esc(primary.category || 'boundaries')}"`,
    `data-layers="${layersForLevel.length}"`,
    // What the search dropdown shows for this card (src/search-pop.ts).
    `data-title="${esc(meta.label)}"`,
    `data-sub="${esc(sub)}"`,
    `data-href="${viewable ? `/view/${esc(primary.id)}` : `#${esc(level)}`}"`,
    `data-provenance="${esc(primary.provenance || 'curated')}"`,
    `data-source="${esc(primary.source)}"`,
    `data-search-primary="${esc(primaryHaystack)}"`,
    `data-search-body="${esc(bodyHaystack)}"`,
  ].join(' ');

  // Compact list layout — one-line entry per layer. Description, source,
  // licence, freshness, alt sources reveal on click via <details>.
  // Summary: title · source · count+unit · actions. All columns are
  // fixed-width except actions; the title column is capped so source/count
  // line up vertically across rows.
  const countDisplay = primary.rows != null
    ? `<span class="row__num">${fmtInt(primary.rows)}</span><span class="row__unit">${esc(meta.unit || '')}</span>`
    : '<span class="row__num">—</span>';
  // row__actions lives OUTSIDE <summary> so the interactive <a> links inside
  // don't violate HTML semantics (interactive descendants of an interactive
  // element). row__head is the visible grid: details on the left, actions on
  // the right. Click on title → toggles details. Click on actions → navigates
  // / downloads without toggling. See task #65 background for full rationale.
  return `<section class="row row--curated row--compact${collapsed}" id="${esc(level)}" ${dataAttrs}>
      <div class="row__head">
        <details class="row__details">
          <summary class="row__summary">
            <span class="row__title" title="${esc(meta.label)}">${esc(meta.label)}${nc ? ` <span class="badge lic-badge lic-badge--nc">${NC_LABEL}</span>` : ''}</span>
            <span class="row__source" title="${esc(primary.attribution?.primary?.name || primary.source)}">${esc(primary.source)}</span>
            <span class="row__count">${countDisplay}</span>
          </summary>
          <div class="row__expand">
            <p class="row__desc">${esc(meta.description)}</p>
            ${sourceLine}
            ${primary.licence ? `<p class="row__lic-line">Licence: ${licenceBadgeHtml(primary.licence, nc)}</p>` : ''}
            ${primary.fetched_at ? `<p class="row__updated">Updated: <time datetime="${esc(primary.fetched_at.slice(0, 10))}">${esc(primary.fetched_at.slice(0, 10))}</time></p>` : ''}
            ${dlInline ? `<p class="row__downloads">Download: ${dlInline}</p>` : ''}
            ${viewerHint}
            ${altSection}
          </div>
        </details>
        <div class="row__actions">
          ${viewBtn}
        </div>
      </div>
    </section>`;
}

// Group layers by level (used by renderRow's primary + alternates logic).
const byLevel = {};
for (const l of catalog.layers) {
  // Community-baked layers (c_<id>, provenance:'community') render via the
  // community-card path, never as a curated level row. They have no admin
  // level, so keep them out of byLevel entirely — this isolates them from
  // every curated loop (rows, JSON-LD, category counts) in one place.
  if (l.provenance === 'community') continue;
  (byLevel[l.level] ||= []).push(l);
}

// Determine the category for each level (taken from its primary layer).
const categoryByLevel = {};
for (const lvl of Object.keys(byLevel)) {
  const primary = pickPrimary(byLevel[lvl]);
  categoryByLevel[lvl] = catOf(primary.category);
}

// Attribution links — used by the /about page footer only (the home page
// now shows per-card source links instead of a global dump).
const attrLinks = Object.entries(catalog.attribution || {})
  .filter(([k]) => !k.startsWith('_'))
  .map(([, val]) => `<a href="${esc(val.url)}" target="_blank" rel="noopener">${esc(val.name)}</a>`)
  .join(' · ');


// SEO head for the home page (+ JSON-LD Dataset for each curated layer)
const homeSeo = seoHead({
  title: "India's open atlas: every boundary, one search away",
  description:
    "Find your ward, district or village, or any of India's open map layers: forests, water, public money. View on a map, ask, or download. Free, no sign-up.",
  url: ORIGIN + '/',
  structuredData: {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        name: 'bharatlas',
        alternateName: 'geodata',
        url: ORIGIN + '/',
        description:
          "Open catalog, verifier and contribution flow for India's geo data: admin boundaries plus community layers.",
        publisher: {
          '@type': 'Organization',
          name: 'Urban Morph',
          url: 'https://urbanmorph.com',
        },
        // Sitelinks search box. ?q= is wired in src/main.ts so the
        // search input pre-fills + applies the filter on page load.
        potentialAction: {
          '@type': 'SearchAction',
          target: {
            '@type': 'EntryPoint',
            urlTemplate: ORIGIN + '/?q={search_term_string}',
          },
          'query-input': 'required name=search_term_string',
        },
      },
      // One Dataset per VISIBLE level — primary layer regardless of source.
      // (Used to filter to source === 'LGD' which dropped wildlife + eco
      // zones from Dataset Search visibility.)
      ...LEVEL_ORDER
        .filter((lvl) => byLevel[lvl]?.length)
        .map((lvl) => {
          const layers = byLevel[lvl];
          const l = pickPrimary(layers);
          const meta = LEVEL_META[lvl] || {};
          // Keywords for Google Dataset Search query matching. Dedup +
          // filter empties so we always emit a clean array; tests pin
          // ≥3 items including 'India'.
          const keywords = [...new Set([
            lvl, meta.label, l.source, l.category, 'India',
          ].filter((x) => typeof x === 'string' && x.length > 0))];
          return {
            '@type': 'Dataset',
            name: `${meta.label ?? l.id} (${l.source})`,
            description: padDatasetDescription(meta.description ?? l.notes ?? '', meta.label ?? l.id, l.source),
            url: ORIGIN + '/layers#' + lvl,
            license: licenceUrl(l.licence),
            isAccessibleForFree: true,
            keywords,
            creator: l.attribution?.primary
              ? { '@type': 'Organization', name: l.attribution.primary.name, url: l.attribution.primary.url }
              : undefined,
            distribution: [
              l.parquet?.url && { '@type': 'DataDownload', encodingFormat: 'application/x-parquet', contentUrl: l.parquet.url, contentSize: l.parquet.bytes },
              l.pmtiles?.url && { '@type': 'DataDownload', encodingFormat: 'application/vnd.pmtiles', contentUrl: l.pmtiles.url, contentSize: l.pmtiles.bytes },
              l.geojson?.url && { '@type': 'DataDownload', encodingFormat: 'application/geo+json', contentUrl: l.geojson.url, contentSize: l.geojson.bytes },
              l.kml?.url && { '@type': 'DataDownload', encodingFormat: 'application/vnd.google-earth.kml+xml', contentUrl: l.kml.url, contentSize: l.kml.bytes },
              l.shapefile?.url && { '@type': 'DataDownload', encodingFormat: 'application/zip', contentUrl: l.shapefile.url, contentSize: l.shapefile.bytes },
            ].filter(Boolean),
            spatialCoverage: { '@type': 'Place', name: 'India' },
          };
        })
        .filter((d) => d.distribution.length > 0),
    ],
  },
});

// Category chips: count = layers per category. A row holds a level's primary
// source plus its alternates, so it adds byLevel[lvl].length; the site talks
// about layers everywhere (chips, section headings, the All total).
// `categoryCounts` is initialised here from visible levels; community
// submissions get added below once communityByCategory is built; chip
// HTML is rendered AFTER that so the totals are final.
const categoryCounts = {};
for (const lvl of LEVEL_ORDER) {
  if (!byLevel[lvl]?.length) continue;
  const cat = categoryByLevel[lvl];
  categoryCounts[cat] = (categoryCounts[cat] || 0) + byLevel[lvl].length;
}

// Community submissions: query D1 (local for dev, --remote for the
// deployed main build). Returns [] on failure so dev / PR builds don't
// break when wrangler / D1 aren't reachable, but warns loudly to stderr
// so CI logs surface a regression instead of shipping an empty grid.
// Validate the env var up front: any value other than 'local' or 'remote'
// (e.g. the literal string "true" produced by a botched workflow YAML
// expression) gets caught here rather than handed to wrangler as a bogus
// --flag that silently errors.
// 'fixture' (npm test) reads tests/fixtures/community.json instead of D1, so test
// builds carry community cards as production does (tests/community-fixture).
const RAW_COMMUNITY_FROM = process.env.COMMUNITY_FROM || 'local';
const COMMUNITY_FROM = ['local', 'remote', 'fixture'].includes(RAW_COMMUNITY_FROM) ? RAW_COMMUNITY_FROM : null;
if (!COMMUNITY_FROM) {
  console.warn(
    `[prerender] COMMUNITY_FROM=${JSON.stringify(RAW_COMMUNITY_FROM)} is not 'local', 'remote' or 'fixture'. ` +
    `Falling back to 'local'. Community submissions will NOT appear in this build.`,
  );
}
const COMMUNITY_SCOPE = COMMUNITY_FROM ?? 'local';
// Prefer a PATH-resolved wrangler (mise / homebrew) over npx, which has
// hit a workerd arch mismatch on this machine's npx cache.
const WRANGLER_BIN = (() => {
  try { execFileSync('which', ['wrangler'], { stdio: 'pipe' }); return 'wrangler'; }
  catch { return null; }
})();
const wranglerPrefix = WRANGLER_BIN || 'npx --yes wrangler';
// The same row shape the D1 query returns, plus the derived score.
const withScores = (rows) =>
  rows.map((r) => ({
    ...r,
    up_count: Number(r.up_count) || 0,
    down_count: Number(r.down_count) || 0,
    score: (Number(r.up_count) || 0) - (Number(r.down_count) || 0),
  }));
function fetchCommunitySubmissions() {
  if (COMMUNITY_SCOPE === 'fixture') {
    return withScores(JSON.parse(readFileSync(resolve(WEB, 'tests', 'fixtures', 'community.json'), 'utf8')));
  }
  try {
    const out = execSync(
      `${wranglerPrefix} d1 execute geodata-submissions --${COMMUNITY_SCOPE} --json --command "${
        'SELECT s.id, s.name, s.description, s.category, s.attribution, s.is_original, ' +
        's.format, s.bytes, s.feature_count, s.r2_key, s.created_at, s.collection_id, ' +
        "COALESCE(SUM(CASE WHEN r.vote = 1 THEN 1 ELSE 0 END), 0) AS up_count, " +
        "COALESCE(SUM(CASE WHEN r.vote = -1 THEN 1 ELSE 0 END), 0) AS down_count " +
        'FROM submissions s LEFT JOIN submission_ratings r ON r.submission_id = s.id ' +
        "WHERE s.status='accepted' GROUP BY s.id ORDER BY s.created_at DESC LIMIT 200"
      }"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const data = JSON.parse(out);
    const rows = withScores(data?.[0]?.results || []);
    if (COMMUNITY_SCOPE === 'remote' && rows.length === 0) {
      console.warn(
        '[prerender] community fetch (remote) returned 0 rows. ' +
        'If submissions exist in D1, this is a regression — check wrangler auth or the SQL.',
      );
    }
    return rows;
  } catch (err) {
    console.warn(
      `[prerender] community fetch (${COMMUNITY_SCOPE}) failed: ${err.message || err}. ` +
      'Build continues with empty community grid.',
    );
    return [];
  }
}
const community = fetchCommunitySubmissions();

// Submissions a maintainer has baked into the catalog (scripts/bake_community.py)
// carry a c_<id> provenance:'community' entry with parquet/pmtiles/geojson/kml
// blocks. Those graduate from the lightweight /preview path to the full
// /view/<id> curated viewer + multi-format downloads. Key by submission id.
const bakedCommunity = new Map(
  catalog.layers
    .filter((l) => l.provenance === 'community')
    .map((l) => [String(l.id).replace(/^c_/, ''), l]),
);

function renderCommunityCard(s, opts = {}) {
  // Single-direction "Useful" voting (task #61). Display + sort key both
  // use up_count only; existing down_count rows in D1 are ignored here.
  const useful = s.up_count;
  const cat = catOf(s.category);
  const collapsed = opts.collapsed ? ' row--collapsed' : '';
  // Two-tier haystack (matches curated cards). Title is the only field
  // we trust as "this card is about X"; the rest is body. We also lift
  // 'community' and 'submission' into primary so searching either word
  // surfaces community-provenance cards alongside any curated card with
  // 'community' in its title (e.g. Community-development Blocks).
  const primaryHaystack = expandAliases([s.name || '', 'community submission'].join(' ')).toLowerCase();
  const bodyHaystack = expandAliases(
    [s.description || '', s.attribution || '', cat, s.format || ''].join(' '),
  ).toLowerCase();
  layerIndex.push({ p: primaryHaystack, b: bodyHaystack, t: s.name, s: `community · ${s.format}`, h: `/c/${s.id}` });
  const dataAttrs = [
    `data-id="${esc(s.id)}"`,
    `data-useful="${useful}"`,
    `data-created="${esc(s.created_at)}"`,
    `data-category="${esc(cat)}"`,
    `data-provenance="community"`,
    `data-title="${esc(s.name)}"`,
    `data-sub="${esc(`community · ${s.format}`)}"`,
    `data-href="/c/${esc(s.id)}"`,
    `data-search-primary="${esc(primaryHaystack)}"`,
    `data-search-body="${esc(bodyHaystack)}"`,
  ].join(' ');
  const credit = s.is_original ? `original work by ${esc(s.attribution)}` : `source: ${esc(s.attribution)}`;
  // View map + Download. The action targets depend on whether the submission
  // has been baked (communityCardActions decides):
  //   unbaked → /preview on the raw R2 file + a single raw download.
  //   baked   → /view/c_<id> (the identical full curated viewer) + the curated
  //             multi-format strip from the catalog entry.
  // /api/r2/community/... is the allowlisted same-origin proxy that streams
  // the R2 object (PR-A locked the prefix down to community/*).
  const baked = bakedCommunity.get(s.id);
  return `<article class="comm-card${collapsed}${baked ? ' comm-card--baked' : ''}" ${dataAttrs}>
    <div class="comm-card__head">
      <div class="comm-card__title"><a href="/c/${esc(s.id)}">${esc(s.name)}</a><span class="badge badge--community">community</span></div>
      <div class="comm-card__score" title="${useful} found this useful">
        <span class="useful">👍 ${useful}</span>
      </div>
    </div>
    ${s.description ? `<p class="comm-card__desc">${esc(s.description)}</p>` : ''}
    <div class="comm-card__meta">${esc(s.format)} · ${s.feature_count != null ? fmtInt(s.feature_count) + ' features · ' : ''}${credit} · <span class="comm-card__via">${esc(CHANNEL_LABEL[channelOf(s)])}</span></div>
    ${renderCommunityActions(s, baked, { esc, fmtBytes })}
  </article>`;
}

// Group community submissions by category — they slot into their topic's
// section alongside curated layers (no separate "community" wall).
const communityByCategory = {};
for (const s of community) {
  const cat = catOf(s.category);
  (communityByCategory[cat] ||= []).push(s);
}
for (const cat of Object.keys(communityByCategory)) {
  // Newest first; consumers re-sort if they want by score.
  communityByCategory[cat].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  // Top up the chip counts so pills include community contributions.
  categoryCounts[cat] = (categoryCounts[cat] || 0) + communityByCategory[cat].length;
}

// Derive `totalLayers` from the final chip counts so the "All" chip
// matches the sum of per-category chips exactly. Build chip HTML now
// that the counts are stable.
const totalLayers = Object.values(categoryCounts).reduce((a, b) => a + b, 0);
const activeCats = Object.entries(catalog.categories || {})
  .filter(([id]) => categoryCounts[id]);
// Theme cards ("Browse by theme"): each links to its section on /layers.
// Each card leads with its theme's map symbol (THEME_GLYPH), like a map legend.
const legendGlyph = (id) => {
  const g = THEME_GLYPH[id] ?? THEME_GLYPH.other;
  const paint = g.fill === 'ink' ? 'class="ink"' : `fill="${g.fill}"`;
  return `<svg class="legend-glyph" viewBox="0 0 28 28" width="26" height="26" aria-hidden="true"><path d="${g.d}" ${paint}/></svg>`;
};
// Theme cards link into /layers: each theme is a section there (Option B).
const themeHref = (id) => (id === 'community' ? '/layers?q=community' : `/layers#${id}`);
const themeCard = (id, name, n) =>
  `<a class="theme-card" href="${themeHref(id)}">` +
  legendGlyph(id) +
  `<span class="theme-card__name">${esc(name)}</span><span class="theme-card__n"><span class="count">${n}</span> layers</span>` +
  (THEME_DESC[id] ? `<span class="theme-card__desc">${esc(THEME_DESC[id])}</span>` : '') +
  `</a>`;
// No "All layers" card: the "See all N layers" button under the grid does that.
const chips = activeCats.map(([id, name]) => themeCard(id, name, categoryCounts[id]));
// A Community card when there are community layers: /layers filtered to them.
if (community.length > 0) {
  chips.push(themeCard('community', 'Community', community.length));
}
// Only render chips when there's more than one category to switch between.
const chipsHtml = activeCats.length > 1 || community.length > 0 ? chips.join('') : '';

// Render one section per non-empty category. Inside each: curated level rows
// first (in LEVEL_ORDER), then community cards (newest first). Both are
// searchable via data-search; the category pill picks one section to show.
//
// Density management: sections with > VISIBLE_LIMIT layers collapse the
// overflow under a "show all N" toggle (data-overflow attr); main.ts wires
// the toggle. Per-layer `.row--collapsed` class hides them by default.
// Quick links under the search: the most downloaded curated layers, one per
// level (the alternates of a level would read as duplicates).
const POPULAR_N = 8;
const curatedById = new Map(catalog.layers.filter((l) => l.provenance !== 'community').map((l) => [l.id, l]));
const popularLevels = new Set();
const popularIds = mostDownloaded(dlCounts, 80, (id) => curatedById.has(id))
  .filter((id) => {
    const lvl = curatedById.get(id).level;
    if (!LEVEL_META[lvl] || popularLevels.has(lvl)) return false;
    popularLevels.add(lvl);
    return true;
  })
  .slice(0, POPULAR_N);
// "Most popular": the most downloaded layers (one per level), with their counts.
const popularHtml = popularIds.length
  ? `<section class="home-section home-browse" id="popular" aria-labelledby="popular-title">` +
    `<h2 class="section-title" id="popular-title">Most popular</h2><div class="popular-list">${popularIds
      .map((id) => {
        const l = curatedById.get(id);
        const meta = LEVEL_META[l.level];
        const count = l.rows != null ? `${fmtInt(l.rows)} ${meta.unit || 'features'}` : '';
        return `<a class="popular-item" href="/view/${esc(id)}"><span class="popular-item__name">${esc(meta.label)}</span><span class="popular-item__count">${esc(count)}</span></a>`;
      })
      .join('')}<a class="popular-item popular-item--all" href="/layers"><span class="popular-item__name">All ${totalLayers} layers</span><span aria-hidden="true">→</span></a></div></section>`
  : '';

// Quick searches under the search box: real queries people make (ward
// lookups lead search demand). Each must find layers (tests/home-counts).
const QUICK_SEARCHES = [
  ['Ward 9, Ahmedabad', 'ward 9 ahmedabad'],
  ['Bengaluru wards', 'bengaluru wards'],
  ['Pincodes', 'pincode'],
  ['Villages', 'villages'],
  ['MGNREGA', 'mgnrega'],
  ['Groundwater', 'groundwater'],
];
const quickSearchHtml = `<nav class="quick-search" aria-label="Try a search"><span class="quick-search__label">Try:</span>${QUICK_SEARCHES
  .map(([label, q]) => `<a href="/?q=${encodeURIComponent(q).replace(/%20/g, '+')}" data-q="${esc(q)}">${esc(label)}</a>`)
  .join('')}</nav>`;

// "updated <date>": the newest layer fetch in the catalogue.
const newestFetch = catalog.layers.map((l) => l.fetched_at || '').sort().pop()?.slice(0, 10) || '';
const updatedHtml = newestFetch
  ? `<time datetime="${newestFetch}">${fmtDate(newestFetch)}</time>`
  : '';

const VISIBLE_LIMIT = 6;

function renderCategorySection(cat) {
  const levelsInCat = LEVEL_ORDER.filter((lvl) => byLevel[lvl]?.length && categoryByLevel[lvl] === cat);
  const commInCat = communityByCategory[cat] || [];
  if (!levelsInCat.length && !commInCat.length) return '';
  const catLabel = (catalog.categories || {})[cat] || cat;
  const total = levelsInCat.reduce((n, lvl) => n + byLevel[lvl].length, 0) + commInCat.length;
  const overflows = levelsInCat.length + commInCat.length > VISIBLE_LIMIT;

  // Tag rows beyond VISIBLE_LIMIT with `row--collapsed`; main.ts toggles
  // the section's `.expanded` state to reveal them. Search + category-pill
  // filters bypass this (visible regardless of overflow state).
  const rowsHtml = levelsInCat
    .map((lvl, i) => renderRow(lvl, byLevel[lvl], { collapsed: overflows && i >= VISIBLE_LIMIT }))
    .join('\n');
  const commHtml = commInCat
    .map((s, i) => renderCommunityCard(s, { collapsed: overflows && (levelsInCat.length + i) >= VISIBLE_LIMIT }))
    .join('\n');

  const showMore = overflows
    ? `<button type="button" class="show-more" data-show-more aria-expanded="false">Show all ${total} ${esc(catLabel.toLowerCase())} layers</button>`
    : '';

  return `<section class="category-section" id="${esc(cat)}" data-category="${esc(cat)}" ${overflows ? 'data-overflow' : ''}>
      <header class="category-section__head">
        <h2 class="category-section__title">${esc(catLabel)}</h2>
        <span class="category-section__count">${total} layer${total === 1 ? '' : 's'}</span>
      </header>
      <div class="category-section__body">
        ${rowsHtml}
        ${commHtml}
        ${showMore}
      </div>
      <a href="/preview?category=${esc(cat)}" class="category-cta">Contribute a ${esc(catLabel.toLowerCase())} layer</a>
    </section>`;
}

const allCategories = new Set([
  ...Object.values(categoryByLevel),
  ...Object.keys(communityByCategory),
]);
const sortedCats = [...new Set([...CATEGORY_ORDER, 'other'])].filter((c) => allCategories.has(c));
const sectionHtml = new Map(sortedCats.map((cat) => [cat, renderCategorySection(cat)]).filter(([, html]) => html));
const categorySections = [...sectionHtml.values()].join('\n');

// /layers: every theme with layers is a section, with an index beside them (Option B).
const sectionCats = [...sectionHtml.keys()];
const themeIndexHtml = sectionCats
  .map((cat) => {
    const n = categoryCounts[cat] ?? 0;
    const label = (catalog.categories || {})[cat] || cat;
    return `<a href="#${esc(cat)}">${legendGlyph(cat)}<span>${esc(label)}</span><span class="theme-index__n">${n}</span></a>`;
  })
  .join('');

const tmpl = await readFile(resolve(WEB, 'index.template.html'), 'utf8');
const homeDownloads = totalDownloads(dlCounts);
const out = fillTemplate(tmpl, {
  CATEGORY_CHIPS: chipsHtml,
  SEO_HEAD: homeSeo,
  TOKENS,
  NAV: renderNav('home'),
  FOOTER,
  POPULAR: popularHtml,
  MAP_BRAND: `<a class="map-brand" href="/" aria-label="bharatlas home">${brandMarkSvg(26)}</a>`,
  QUICK_SEARCH: quickSearchHtml,
  INDIA_MAP: indiaMapHtml({ wardBboxes: WARD_BBOXES, catalog }),
  LAYER_TOTAL: String(totalLayers),
  UPDATED: updatedHtml,
  DOWNLOAD_TOTAL: homeDownloads > 0 ? ` · <span class="search-meta__count">${fmtCount(homeDownloads)}</span> downloads` : '',
});

await writeFile(resolve(WEB, 'index.html'), out);

const layersSeo = seoHead({
  title: 'All layers',
  description: `All ${totalLayers} of India's open map layers by theme: boundaries, city wards, water, environment and more. View any of them on a map or download it.`,
  url: ORIGIN + '/layers',
  structuredData: {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN + '/' },
      { '@type': 'ListItem', position: 2, name: 'All layers', item: ORIGIN + '/layers' },
    ],
  },
});
const layersTmpl = await readFile(resolve(WEB, 'layers.template.html'), 'utf8');
await writeFile(
  resolve(WEB, 'layers.html'),
  fillTemplate(layersTmpl, {
    SEO_HEAD: layersSeo,
    TOKENS,
    NAV: renderNav('layers'),
    FOOTER,
    THEME_INDEX: themeIndexHtml,
    CATEGORY_SECTIONS: categorySections,
    LAYER_TOTAL: String(totalLayers),
    THEME_TOTAL: String(sectionCats.length),
  }),
);
await writeFile(resolve(WEB, 'public', 'layer-index.json'), JSON.stringify(layerIndex));
console.log(`prerendered /layers — ${sectionCats.length} themes, ${layerIndex.length} rows in the search index`);
console.log(`prerendered home — ${sortedCats.length} categories, ${LEVEL_ORDER.filter((l) => byLevel[l]?.length).length} curated levels, ${community.length} community`);

// Helper: prerender a page that just needs an SEO head.
async function renderPage(name, seoOpts, extra = {}, navKey = name) {
  const path = resolve(WEB, `${name}.template.html`);
  if (!existsSync(path)) return;
  const tmpl = await readFile(path, 'utf8');
  const out = fillTemplate(tmpl, {
    SEO_HEAD: seoHead(seoOpts),
    TOKENS,
    NAV: renderNav(navKey),
    FOOTER,
    ...extra,
  });
  await writeFile(resolve(WEB, `${name}.html`), out);
  console.log(`prerendered /${name}`);
}

// FAQ answers written as HTML are shown as written; their FAQPage JSON-LD carries
// the same words as plain text (Google wants the markup to match the page).
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
function htmlToText(html) {
  return html
    .replace(/<\/?(p|br)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, ' ')
    .trim();
}
const faqPage = (items) => ({
  '@type': 'FAQPage',
  mainEntity: items.map(({ q, text }) => ({
    '@type': 'Question',
    name: q,
    acceptedAnswer: { '@type': 'Answer', text },
  })),
});

// /about FAQ: the visible <dl class="faq wide"> and its FAQPage JSON-LD, from this one
// list (the wording the owner approved on 2026-11-17). `q` and `a` are HTML as shown;
// `id` is an anchor on the question.
const ABOUT_FAQ = [
  {
    q: `Do I need to sign up?`,
    a: `No. Viewing, slicing, downloading and contributing all work without an account. When you publish a layer you receive a one-time admin token (also downloadable as a <code>.txt</code> backup) that you keep forever to edit or delete that submission.`,
  },
  {
    q: `What data sources does bharatlas use?`,
    a: `Curated layers come from the Local Government Directory (LGD), Survey of India (SOI), NRSC/ISRO Bhuvan, OpenCity / Oorvani Foundation, PMGSY (Rural Roads), PM GatiShakti, Bharatmaps (NIC), bharatviz (pincode polygons), geoBoundaries and data.gov.in. Water, groundwater and agro-zone layers (CGWB aquifers and groundwater extraction, WRIS canals, ICAR-NBSS agro-ecological zones, Planning Commission agro-climatic zones, Wildlife Institute of India biogeographic zones) are republished via CoRE Stack (core-stack.org). Most admin levels carry several source variants you can compare on the same map; the layer's card shows "Per LGD · also: SOI, Bhuvan" with clickable alternates. Community submissions credit their own source on every card. Points of interest come from the Overture Maps Foundation, and district well counts from the Minor Irrigation Census (Ministry of Jal Shakti).`,
  },
  {
    q: `What licences apply?`,
    a: `Curated layers carry CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0, ODbL-1.0, GODL-India, MIT, or CDLA-Permissive-2.0 / Apache-2.0 depending on the source (each card names its licence). Layers under a non-commercial licence are marked <strong>Non-commercial only</strong>. Community submissions choose from an open-licence allowlist: CC0, CC-BY, CC-BY-SA, ODbL, ODC-PDDL, GODL-India or CDLA Permissive 2.0. Proprietary or "all rights reserved" content is rejected at submit.`,
  },
  {
    q: `How do you choose sources?`,
    id: 'sources-and-licensing',
    a: `
        <p>Curated layers come from Indian government bodies (central, state and city), public institutions, open-data communities such as DataMeet and OpenCity, and openly licensed research and industry datasets. We favour data you can't get from a map app: official boundaries and jurisdictions, regulatory zones, and measured or surveyed records.</p>
        <p><strong>Government data.</strong> Publicly funded geospatial data is meant to be freely available (National Geospatial Guidelines 2021, National Geospatial Policy 2022). We republish it with full credit to the publishing department, including where a portal's general website terms ask visitors to seek permission. A few layers carry a non-commercial licence: they are marked <strong>Non-commercial only</strong> on their card, on their map page and in every API and MCP answer, so check before using them in a product or for a client. We leave out privately owned data without an open licence, and personal data.</p>
        <p><strong>Licence labels.</strong> Where the publisher states an open licence (for example GODL-India or CC BY), the layer carries it. Where the publisher states none, the layer carries the licence of the open-data republisher we took it from (for example CC0 from DataMeet's indianopenmaps), and the card and notes credit both.</p>
        <p><strong>Changes and removal.</strong> If you publish a dataset shown here and want it corrected, credited differently or removed, email <a href="mailto:sathya@urbanmorph.com">sathya@urbanmorph.com</a> or open a <a href="https://github.com/urbanmorph/geodata/issues">GitHub issue</a>. We act on publisher requests promptly.</p>
      `,
  },
  {
    q: `Is my file uploaded when I drop it?`,
    a: `No, not until you click <strong>Publish</strong>. Parsing, validation and the map render all happen in your browser. Only the explicit Publish action ships the file to R2 and records metadata in D1.`,
  },
  {
    q: `What's the difference between dropping a file and collect?`,
    a: `Dropping a file (<a href="/preview">/preview</a>) is for data you already have as one complete file: validate it, then publish it. <a href="https://collect.bharatlas.com">collect</a> is for data you don't have yet: make a form, many people add points from the field over time, then you review and publish the result. One publishes; the other gathers.`,
  },
  {
    q: `How can I trust community submissions?`,
    a: `Each carries a source URL, attribution and an open licence on the card and the view page. Automated checks validate licence, attribution and basic geometry, then a curator reviews each submission before it appears; neither step verifies accuracy beyond the contributor's self-attestation. For sensitive use, follow the source link on the card to confirm provenance.`,
  },
  {
    q: `Can AI assistants read and recommend bharatlas?`,
    a: `Yes. The robots.txt explicitly allows GPTBot, ClaudeBot, PerplexityBot, Google-Extended and other major AI crawlers. Every layer page and every <code>/c/&lt;id&gt;</code> view page are server-rendered as plain HTML with JSON-LD <code>Dataset</code> structured data, easy for LLMs to ingest.`,
  },
];
const aboutFaqHtml = `<dl class="faq wide">\n${ABOUT_FAQ.map(({ q, a, id }) =>
  `      <dt${id ? ` id="${id}"` : ''}>${q}</dt>\n      <dd>${a}</dd>\n`).join('\n')}    </dl>`;

await renderPage('about', {
  title: 'About',
  description:
    "Show your data on a map of India: districts, forests, rivers, wards. Or browse, slice and download India's open map layers. No signup, no API key.",
  url: ORIGIN + '/about',
  image: ogImage('og-about'),
  structuredData: {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN + '/' },
          { '@type': 'ListItem', position: 2, name: 'About', item: ORIGIN + '/about' },
        ],
      },
      {
        '@type': 'AboutPage',
        name: 'About bharatlas',
        url: ORIGIN + '/about',
        author: { '@id': ORIGIN + '/about#sathya' },
        publisher: { '@type': 'Organization', name: 'Urban Morph', url: 'https://urbanmorph.com' },
      },
      {
        '@type': 'Person',
        '@id': ORIGIN + '/about#sathya',
        name: 'Sathya Sankaran',
        url: 'https://www.sathyasankaran.com',
        sameAs: [
          'https://linkedin.com/in/sathyasankaran',
          'https://github.com/urbanmorph',
        ],
        worksFor: { '@type': 'Organization', name: 'Urban Morph', url: 'https://urbanmorph.com' },
      },
      faqPage(ABOUT_FAQ.map(({ q, a }) => ({ q: htmlToText(q), text: htmlToText(a) }))),
    ],
  },
}, { ATTR_LINKS: attrLinks, ABOUT_FAQ: aboutFaqHtml });

// Turnstile site key — Cloudflare's test key (always passes) when no env override.
// In production, set TURNSTILE_SITEKEY in the deploy environment.
const TURNSTILE_SITEKEY = process.env.TURNSTILE_SITEKEY || '1x00000000000000000000AA';

await renderPage(
  'preview',
  {
    title: 'Preview · view, verify, or publish a geo file',
    description:
      "Drop a GeoJSON, KML, KMZ or Parquet file to see it on a map and validate it in your browser. Optionally publish to bharatlas under an open licence.",
    url: ORIGIN + '/preview',
    image: ogImage('og-preview'),
    structuredData: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN + '/' },
            { '@type': 'ListItem', position: 2, name: 'Preview', item: ORIGIN + '/preview' },
          ],
        },
        {
          '@type': 'WebApplication',
          name: 'bharatlas · preview',
          url: ORIGIN + '/preview',
          applicationCategory: 'UtilityApplication',
          operatingSystem: 'Web',
        },
      ],
    },
  },
  { TURNSTILE_SITEKEY },
);

// Shared minimal WebSite ref for legal pages' isPartOf.
const WEBSITE_REF = { '@type': 'WebSite', name: 'bharatlas', url: ORIGIN + '/' };

await renderPage('privacy', {
  title: 'Privacy',
  description:
    "Bharatlas runs without accounts, ad-tech or tracking cookies (only cookieless, aggregate traffic counts). This page explains what we store (very little) and what we don't.",
  url: ORIGIN + '/privacy',
  image: ogImage('og-default'),
  structuredData: {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN + '/' },
          { '@type': 'ListItem', position: 2, name: 'Privacy', item: ORIGIN + '/privacy' },
        ],
      },
      {
        '@type': 'WebPage',
        name: 'Privacy',
        url: ORIGIN + '/privacy',
        isPartOf: WEBSITE_REF,
        about: 'Privacy practices for bharatlas: no accounts, no ad-tech, no tracking cookies, cookieless aggregate analytics only.',
      },
    ],
  },
});

await renderPage('terms', {
  title: 'Terms',
  description:
    "Terms for using bharatlas: open-licence content only, no warranty of accuracy, contributor attests right to share. Short and plain-English.",
  url: ORIGIN + '/terms',
  image: ogImage('og-default'),
  structuredData: {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN + '/' },
          { '@type': 'ListItem', position: 2, name: 'Terms', item: ORIGIN + '/terms' },
        ],
      },
      {
        '@type': 'WebPage',
        name: 'Terms',
        url: ORIGIN + '/terms',
        isPartOf: WEBSITE_REF,
        about: 'Terms of use for bharatlas: open-licence content only, no warranty of accuracy, contributor attests right to share.',
      },
    ],
  },
});

// /docs FAQ — mirrors the visible "Common questions" section emitted into
// docs.template.html. Targets queries an LLM (or a human) is likely to ask
// before reading the full reference. Keep answers tight and curl-shaped so
// they're directly copy-pastable.
const DOCS_FAQ = [
  {
    q: 'Do I need an API key to use the bharatlas API?',
    a: 'No. The API is public, read-only and CORS-enabled. No auth, no signup, no API key. Rate limit is 120 requests per minute per IP, 60/min for the locate endpoints. Please send a User-Agent naming your app and a link. The full description is at https://bharatlas.com/api/v1/openapi.json (OpenAPI 3.1).',
  },
  {
    q: 'How do I list all geo layers via the API?',
    a: 'GET https://bharatlas.com/api/v1/layers returns every curated layer with pagination. Optional filters: ?category=, ?level=, ?source=, ?q= for full-text search.',
  },
  {
    q: 'How do I find what state or district a coordinate is in?',
    a: `GET https://bharatlas.com/api/v1/locate?lat=12.97&lng=77.59 runs point-in-polygon across ${LOCATE_N} admin and zone layers (plus the city ward layer covering the point) in a single call. Returns state, district, ward, pincode, seismic zone, eco-zone and more, with LGD codes to join on.`,
  },
  {
    q: 'How do I find features near a point?',
    a: 'GET https://bharatlas.com/api/v1/nearby?lat=12.97&lng=77.59&layer=wris_reservoirs&radius_km=50 finds features from any layer within a radius. Works for points, polygons and lines: reads bounding-box columns from the layer parquet and ranks features by Haversine distance to their bounding-box centres.',
  },
  {
    q: 'How do I query a layer with column filters?',
    a: 'GET https://bharatlas.com/api/v1/layers/:id/query?where=col=val&select=col1,col2&group_by=col. Reads parquet directly from R2 at runtime. Call /schema first to discover column names.',
  },
  {
    q: 'What download formats does bharatlas support?',
    a: 'Up to 5 formats per layer: parquet (DuckDB, Pandas, R, Spark), pmtiles (web maps), geojson (QGIS, D3), kml (Google Earth) and shapefile (ArcGIS). Use /api/v1/layers/:id to get direct download URLs.',
  },
  {
    q: 'How do I connect an LLM to the bharatlas API?',
    a: 'Use the bharatlas MCP server: add bharatlas-mcp to your MCP client config and run npx -y bharatlas-mcp@latest. Connects Claude, GPT, Gemini or any MCP-compatible LLM to query the layers (schema-first querying, spatial joins) and, with a collect share link, to author your own maps.',
  },
  {
    q: 'How do I collect map data from the field with a shared form?',
    a: 'Use collect (collect.bharatlas.com), the write side. Design a small form, share a link, and anyone who has it adds points from their phone with no account. You review incoming points, then publish the approved ones to bharatlas, where a curator approves the submission before it appears. API base: https://collect.bharatlas.com/api/collect/v1.',
  },
  {
    q: 'How do I manage or publish a collect map from an LLM?',
    a: 'Create the map online at collect.bharatlas.com (no account, no key), then use the bharatlas MCP (npx bharatlas-mcp@latest): register_map with a share link. The link scope sets what you can do: view reads and exports published points, collect adds in the browser, admin can edit, moderate, import and publish. The link is the credential, so no API key is needed for maps you made online.',
  },
  {
    q: 'How do I create a collect map programmatically?',
    a: 'POST https://collect.bharatlas.com/api/collect/v1/collections with an X-API-Key header (the anti-abuse gate; the browser flow uses Turnstile instead). It returns admin, collect and view links whose tokens live in the URL fragment. Then GET /collections/:id/records to review and POST /collections/:id/publish to submit approved points to bharatlas for review (a maintainer approves before it appears). Or from an LLM: the bharatlas MCP (npx bharatlas-mcp@latest) authors collect maps too, register your share link with register_map then moderate and publish.',
  },
  {
    q: 'Where do published collect maps show up?',
    a: 'As community submissions, once a curator approves them. GET https://bharatlas.com/api/v1/submissions lists approved submissions, and the read MCP tool list_submissions surfaces them to an LLM. An approved collect map is queryable via /api/v1/layers/:id/query like any other layer.',
  },
];

const docs = docsStats(catalog, totalDownloads(dlCounts));
// Plain-text answers: escaped on the page so "&select=" reads as typed (not "§lect").
const docsFaqHtml = `      <h2>Common questions</h2>\n${DOCS_FAQ.map(({ q, a }) => `      <h3>${esc(q)}</h3>\n      <p>${esc(a)}</p>`).join('\n')}\n`;

await renderPage('docs', {
  title: 'API v1',
  description:
    "Public JSON API for India's open geo layers. List, query and filter layers, locate a point across every admin and zone layer, find features nearby, download in open formats. No auth, no API key.",
  url: ORIGIN + '/docs',
  image: ogImage('og-default'),
  structuredData: {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN + '/' },
          { '@type': 'ListItem', position: 2, name: 'API v1', item: ORIGIN + '/docs' },
        ],
      },
      {
        '@type': 'WebAPI',
        name: 'bharatlas API v1',
        description: "Public JSON API for India's open geo layers. 13 endpoints: list, query, filter, locate, nearby, schema, categories, levels, counts, downloads, submissions.",
        url: ORIGIN + '/docs',
        provider: { '@type': 'Organization', name: 'Urban Morph', url: 'https://urbanmorph.com' },
        documentation: ORIGIN + '/docs',
      },
      faqPage(DOCS_FAQ.map(({ q, a }) => ({ q, text: a }))),
    ],
  },
}, {
  DOCS_FAQ_HTML: docsFaqHtml,
  DOCS_LAYERS: String(docs.layers),
  DOCS_DOWNLOADS: docs.downloads > 0 ? `${fmtInt(docs.downloads)} downloads so far.` : '',
  DOCS_LICENCES: docs.licences
    .map(([lic, n]) => `<li><b>${n}</b>${esc(lic)}</li>`)
    .join(''),
});

// /mcp "What you can ask": the visible questions (under their group headings) and the
// FAQPage JSON-LD, from this one list. Plain text, escaped on the page.
const MCP_FAQ = [
  {
    group: 'Counting and filtering',
    q: `How many national parks vs wildlife sanctuaries in India?`,
    a: `101 national parks, 560 sanctuaries (from the gs_wildlife layer, grouped by category)`,
  },
  {
    q: `How many villages are in Bengaluru Urban district?`,
    a: `949 villages (lgd_villages filtered by dtname=BENGALURU URBAN)`,
  },
  {
    q: `How many health facilities are in Bihar?`,
    a: `8,363 facilities: 3,232 sub-centres, 591 PHCs, 74 CHCs (nic_health filtered by state)`,
  },
  {
    q: `How many wards does Chennai have vs Pune?`,
    a: `Chennai: 200, Pune: 58 (from wards_chennai and wards_pune layer metadata)`,
  },
  {
    group: 'Location queries',
    q: `What state, district, and seismic zone is Bengaluru in?`,
    a: `Karnataka, Bengaluru Urban, Seismic Zone II (locate endpoint checks ${LOCATE_N} layers in one call)`,
  },
  {
    q: `Which blocks are in district 571?`,
    a: `10 blocks: Kunigal, Tumakuru, Gubbi, Turuvekere, Tiptur... (lgd_blocks filtered by dtcode11)`,
  },
  {
    group: 'Cross-layer queries',
    q: `How many airports in Bengaluru district? What are their types?`,
    a: `3 airports: HAL (Domestic), Yelahanka AFB (Civil Enclave), Kempegowda International. The MCP locates the district, then filters the airports layer by state and district.`,
  },
  {
    q: `Which airports in Karnataka are near water bodies?`,
    a: `Hubballi Airport (~3 km from Unkal Lake), Mangalore Airport (between Netravathi and Gurupura rivers), Jindal Vijaynagar (~7 km from JSW Reservoir). Cross-references airports + reservoirs layers.`,
  },
  {
    group: 'Spatial queries (multi-step)',
    q: `Which villages in Madhya Pradesh are in eco-sensitive zones?`,
    a: `MP has 4 eco-sensitive zones (Kharmor, Chambal, Orchha, Kheoni). The MCP narrows 47,571 MP villages by district, then tests each against the eco-zone boundaries.`,
  },
  {
    q: `Which districts does NH-44 pass through?`,
    a: `Delhi, UP, MP, Telangana, Karnataka. The MCP samples points along the route and locates the state at each point.`,
  },
  {
    q: `How many hospitals are in flood-prone areas of Assam?`,
    a: `3,909 health facilities in Assam (narrowed by state). For precise flood-zone overlap, the MCP tests hospital points against the India Flood Inventory layer.`,
  },
];
const mcpFaqHtml = MCP_FAQ.map(({ group, q, a }) =>
  `${group ? `      <h3>${esc(group)}</h3>\n` : ''}      <p class="question">${esc(q)}</p>\n      <p class="answer">${esc(a)}</p>\n`).join('\n');

await renderPage('mcp', {
  title: 'MCP Server',
  description:
    `Ask questions about India's geo data in natural language. Connect Claude, GPT, or any LLM to ${totalLayers} geo layers via the bharatlas MCP server.`,
  url: ORIGIN + '/mcp',
  image: ogImage('og-default'),
  structuredData: {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN + '/' },
          { '@type': 'ListItem', position: 2, name: 'MCP Server', item: ORIGIN + '/mcp' },
        ],
      },
      {
        '@type': 'SoftwareApplication',
        name: 'bharatlas-mcp',
        description: "MCP server for India's open geo data. 17 tools for LLMs: 8 for reading (list, schema, query, locate, nearby, categories, submissions, downloads) plus 9 for authoring collect maps (register, create, edit, moderate, import, publish and more).",
        url: ORIGIN + '/mcp',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Any',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        softwareRequirements: 'Node.js, any MCP-compatible LLM client',
      },
      faqPage(MCP_FAQ.map(({ q, a }) => ({ q, text: a }))),
    ],
  },
}, { MCP_FAQ: mcpFaqHtml });

// Static sitemap.xml — emitted at build time. Edge function later stitches in /c/[id].
const sitemapUrls = [
  { loc: ORIGIN + '/', changefreq: 'weekly', priority: '1.0' },
  { loc: ORIGIN + '/layers', changefreq: 'weekly', priority: '0.9' },
  { loc: ORIGIN + '/about', changefreq: 'monthly', priority: '0.8' },
  { loc: ORIGIN + '/preview', changefreq: 'monthly', priority: '0.8' },
  { loc: ORIGIN + '/privacy', changefreq: 'yearly', priority: '0.3' },
  { loc: ORIGIN + '/terms', changefreq: 'yearly', priority: '0.3' },
  { loc: ORIGIN + '/docs', changefreq: 'monthly', priority: '0.7' },
  { loc: ORIGIN + '/mcp', changefreq: 'monthly', priority: '0.7' },
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
