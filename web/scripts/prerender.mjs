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

// Keep in sync with web/src/format-hints.ts:fmtBytes
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
// Keep in sync with web/src/util.ts:escapeHtml
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
    'MIT':           'https://opensource.org/licenses/MIT',
  };
  if (!id) return undefined;
  // dual e.g. "CC0-1.0 / CC-BY-4.0" — pick the most permissive.
  const first = id.split('/')[0].trim();
  return map[first] || undefined;
}

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

// Display order for category sections on the home page. Categories not in
// this list fall to the end in catalog.categories declaration order.
const CATEGORY_ORDER = [
  'administrative', 'people', 'environment', 'agriculture',
  'transport', 'infrastructure', 'culture', 'health-edu', 'other',
];

// Search-index alias dictionary. If any KEY (case-insensitive) appears in a
// card's text, the EXPANSIONS get appended to its haystack. Lets users find
// PMGSY by typing "rural roads", LGD by typing the long name, etc.
// Keep tight — these add bytes to every page. No fuzzy / NLP, just synonyms.
const SEARCH_ALIASES = {
  'PMGSY':       ['Pradhan Mantri Gram Sadak Yojana', 'rural roads'],
  'LGD':         ['Local Government Directory'],
  'SOI':         ['Survey of India'],
  'NRSC':        ['ISRO Bhuvan', 'national remote sensing centre'],
  'MoRTH':       ['Ministry of Road Transport Highways', 'NHAI', 'highways'],
  'MoEFCC':      ['Ministry of Environment Forest Climate Change'],
  'ESZ':         ['eco sensitive zone'],
  'CRZ':         ['coastal regulation zone'],
  // pincode + wildlife aliases moved below (merged with court/ward block)
  'parliament':  ['lok sabha', 'PC', 'constituency', 'election', 'vote', 'MP'],
  'assembly':    ['vidhan sabha', 'AC', 'MLA', 'election', 'vote'],
  'ward':        ['municipality', 'corporation', 'municipal', 'city', 'urban'],
  'pincode':     ['pin code', 'postal code', 'zip', 'post office'],
  'wildlife':    ['national park', 'sanctuary', 'reserve forest', 'protected area'],
  'eco':         ['protected area', 'environment', 'pollution'],
  'country':     ['India outline', 'national boundary', 'India map'],
  'GatiShakti':  ['PM GatiShakti'],
  'Bharatmaps':  ['NIC', 'national informatics centre'],
  'CC0':         ['public domain'],
  'CC-BY':       ['attribution'],
  'ODbL':        ['open database license'],
  'district':    ['district court', 'district courts', 'sessions court', 'magistrate court', 'consumer forum', 'consumer commission', 'courts'],
  'subdistrict': ['tehsil court', 'tehsil courts', 'revenue court', 'taluk court', 'courts'],
  'state':       ['state consumer commission', 'courts'],
  'high_court':  ['high court', 'high courts', 'HC', 'appellate court'],
  'NGT':         ['national green tribunal', 'environment tribunal', 'green court', 'courts'],
  'NCLT':        ['national company law tribunal', 'company court', 'courts', 'insolvency', 'IBC'],
  'parquet':     ['arrow', 'columnar'],
  'pmtiles':     ['vector tiles', 'maplibre'],
  'geojson':     ['gis', 'qgis'],
  'kml':         ['google earth'],
};

function expandAliases(text) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const [key, expansions] of Object.entries(SEARCH_ALIASES)) {
    if (lower.includes(key.toLowerCase())) hits.push(...expansions);
  }
  return hits.length ? text + ' ' + hits.join(' ') : text;
}

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
  if (layer.kml?.url) items.push({ fmt: 'kml', url: dlUrl(layer.kml.url, 'kml'), size: layer.kml.bytes, count: countFor(layer, 'kml') });
  if (layer.shapefile?.url) items.push({ fmt: 'shp', url: dlUrl(layer.shapefile.url, 'shapefile'), size: layer.shapefile.bytes, count: countFor(layer, 'shapefile') });
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
    ? `<a href="/view/${esc(primary.id)}" class="btn-primary">View map →</a>`
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

  // Viewer-hint message adapts to what's already on the card:
  // - If geojson/kml/shp are baked whole-layer, the hint is just about state slicing.
  // - Otherwise it still advertises the in-viewer instant-convert path.
  const hasBakedDerivative = !!(primary.geojson?.url || primary.kml?.url || primary.shapefile?.url);
  const viewerHint = filterable
    ? (hasBakedDerivative
      ? `<p class="row__viewer-hint">↳ Inside the viewer: slice by state for a single-state subset (full-layer downloads above are India-wide)</p>`
      : `<p class="row__viewer-hint">↳ Inside the viewer: slice by state · instant download as <strong>GeoJSON</strong> (QGIS, web) or <strong>KML</strong> (Google Earth & Maps)</p>`)
    : '';

  const freshnessSpan = primary.fetched_at
    ? `<span class="row__freshness${isStale(primary.fetched_at) ? ' stale' : ''}" title="${esc(primary.fetched_at)}">${relativeTime(primary.fetched_at)}</span>`
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
    .map((l) => `<a href="/view/${esc(l.id)}">${esc(l.source)}</a>`);
  const sourceText = primary.attribution?.primary
    ? `Per <a href="${esc(primary.attribution.primary.url)}" target="_blank" rel="noopener">${esc(primary.attribution.primary.name)}</a>${altSources.length ? ` <span class="row__alts">also: ${altSources.join(', ')}</span>` : ''}`
    : '';
  const sourceLine =
    sourceText || freshnessSpan
      ? `<p class="row__source">${sourceText}${sourceText && freshnessSpan ? ' <span class="dot">·</span> ' : ''}${freshnessSpan}</p>`
      : '';

  // Two haystacks so the client filter can do high-signal title matching
  // first, then fall back to body. Without the split, "villages" surfaced
  // Districts / Sub-districts / Blocks whose descriptions explain how they
  // join to villages. See src/catalog-filter.ts for the matcher.
  const primaryHaystack = expandAliases([meta.label, level].join(' ')).toLowerCase();
  const bodyHaystack = expandAliases(
    [
      meta.description,
      primary.attribution?.primary?.name || '',
      primary.notes || '',
      primary.source || '',
      primary.licence || '',
      primary.category || '',
      formatTokens(primary),
      // Source codes from alt layers — so a card surfaces when searching
      // for any of its providers (e.g. "Bhuvan" on the States row).
      layersForLevel.map((l) => l.source).join(' '),
    ].join(' '),
  ).toLowerCase();

  const dataAttrs = [
    `data-id="${esc(primary.id)}"`,
    `data-level="${esc(level)}"`,
    `data-category="${esc(primary.category || 'administrative')}"`,
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
    ? `<span class="row__num">${fmtRows(primary.rows)}</span><span class="row__unit">${esc(meta.unit || '')}</span>`
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
            <span class="row__title" title="${esc(meta.label)}">${esc(meta.label)}</span>
            <span class="row__source" title="${esc(primary.attribution?.primary?.name || primary.source)}">${esc(primary.source)}</span>
            <span class="row__count">${countDisplay}</span>
          </summary>
          <div class="row__expand">
            <p class="row__desc">${esc(meta.description)}</p>
            ${sourceLine}
            ${primary.licence ? `<p class="row__lic-line">Licence: <code>${esc(primary.licence)}</code></p>` : ''}
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
  (byLevel[l.level] ||= []).push(l);
}

// Determine the category for each level (taken from its primary layer).
const categoryByLevel = {};
for (const lvl of Object.keys(byLevel)) {
  const primary = pickPrimary(byLevel[lvl]);
  categoryByLevel[lvl] = primary.category || 'other';
}

// Attribution links — used by the /about page footer only (the home page
// now shows per-card source links instead of a global dump).
const attrLinks = Object.entries(catalog.attribution || {})
  .filter(([k]) => !k.startsWith('_'))
  .map(([, val]) => `<a href="${esc(val.url)}" target="_blank" rel="noopener">${esc(val.name)}</a>`)
  .join(' · ');

// Inline the SMALL parts of the catalog so map + filter open with zero
// network roundtrips for the common case. The extracts manifest, state
// extracts and filter_stats are only needed when the user opens a layer's
// Filter & export panel — that lazy-fetches the full catalog.
const inlineCatalogObj = { ...catalog };
delete inlineCatalogObj.extracts;
delete inlineCatalogObj.state_extracts;
delete inlineCatalogObj.filter_stats;

// Escape sequences that are unsafe inside a <script> tag. JSON.stringify
// already escapes 0x00–0x1F, but parse5 (and other strict HTML parsers)
// reject C1 control chars (0x80–0x9F) too, and U+2028 / U+2029 break some
// older JS parsers when JSON is embedded as literal JS.
function safeForHtmlScript(s) {
  return s
    .replace(/</g, '\\u003c')
    .replace(new RegExp('\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\u2029', 'g'), '\\u2029')
    .replace(/[\x7f-\x9f]/g, (m) => '\\u' + m.charCodeAt(0).toString(16).padStart(4, '0'));
}
const inlineCatalog = safeForHtmlScript(JSON.stringify(inlineCatalogObj));

// SEO head for the home page (+ JSON-LD Dataset for each curated layer)
const homeSeo = seoHead({
  title: "India's open atlas · view, verify, contribute",
  description:
    "India's open atlas: view, slice and download open boundary layers, or drop your own geo file and share it. Open licences, no signup, no tracking.",
  url: ORIGIN + '/',
  structuredData: {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN + '/' },
          { '@type': 'ListItem', position: 2, name: 'Catalog', item: ORIGIN + '/' },
        ],
      },
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
          return {
            '@type': 'Dataset',
            name: `${meta.label ?? l.id} (${l.source})`,
            description: padDatasetDescription(meta.description ?? l.notes ?? '', meta.label ?? l.id, l.source),
            url: ORIGIN + '/#' + lvl,
            license: licenseUrl(l.licence),
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

// Category chips: count = visible level rows per category (not raw layer
// rows). Raw-layer counts double-counted alt sources and included dead
// gb_adm placeholders, making the pill total mismatch the section title.
// `categoryCounts` is initialised here from visible levels; community
// submissions get added below once communityByCategory is built; chip
// HTML is rendered AFTER that so the totals are final.
const knownCats = new Set(Object.keys(catalog.categories || {}));
const categoryCounts = {};
for (const lvl of LEVEL_ORDER) {
  if (!byLevel[lvl]?.length) continue;
  const cat = knownCats.has(categoryByLevel[lvl]) ? categoryByLevel[lvl] : 'other';
  categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
}

// Community submissions: query D1 (local by default; --remote in prod build
// once that's wired). Silently empty on failure so a missing wrangler /
// missing DB doesn't break the build.
const COMMUNITY_FROM = process.env.COMMUNITY_FROM || 'local'; // local | remote
// Prefer a PATH-resolved wrangler (mise / homebrew) over npx, which has
// hit a workerd arch mismatch on this machine's npx cache.
import { execFileSync } from 'node:child_process';
const WRANGLER_BIN = (() => {
  try { execFileSync('which', ['wrangler'], { stdio: 'pipe' }); return 'wrangler'; }
  catch { return null; }
})();
const wranglerPrefix = WRANGLER_BIN || 'npx --yes wrangler';
function fetchCommunitySubmissions() {
  try {
    const out = execSync(
      `${wranglerPrefix} d1 execute geodata-submissions --${COMMUNITY_FROM} --json --command "${
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

function renderCommunityCard(s, opts = {}) {
  // Single-direction "Useful" voting (task #61). Display + sort key both
  // use up_count only; existing down_count rows in D1 are ignored here.
  const useful = s.up_count;
  const cat = s.category || 'other';
  const collapsed = opts.collapsed ? ' row--collapsed' : '';
  // Two-tier haystack (matches curated cards). Title is the only field
  // we trust as "this card is about X"; the rest is body.
  const primaryHaystack = expandAliases(s.name || '').toLowerCase();
  const bodyHaystack = expandAliases(
    [s.description || '', s.attribution || '', cat, s.format || '', 'community'].join(' '),
  ).toLowerCase();
  const dataAttrs = [
    `data-id="${esc(s.id)}"`,
    `data-useful="${useful}"`,
    `data-created="${esc(s.created_at)}"`,
    `data-category="${esc(cat)}"`,
    `data-provenance="community"`,
    `data-search-primary="${esc(primaryHaystack)}"`,
    `data-search-body="${esc(bodyHaystack)}"`,
  ].join(' ');
  const credit = s.is_original ? `original work by ${esc(s.attribution)}` : `source: ${esc(s.attribution)}`;
  return `<article class="comm-card${collapsed}" ${dataAttrs}>
    <div class="comm-card__head">
      <div class="comm-card__title"><a href="/c/${esc(s.id)}">${esc(s.name)}</a><span class="badge badge--community">community</span></div>
      <div class="comm-card__score" title="${useful} found this useful">
        <span class="useful">👍 ${useful}</span>
      </div>
    </div>
    ${s.description ? `<p class="comm-card__desc">${esc(s.description)}</p>` : ''}
    <div class="comm-card__meta">${esc(s.format)} · ${s.feature_count != null ? s.feature_count.toLocaleString('en-IN') + ' features · ' : ''}${credit}</div>
  </article>`;
}

// Group community submissions by category — they slot into their topic's
// section alongside curated layers (no separate "community" wall).
const communityByCategory = {};
for (const s of community) {
  const cat = (s.category && (catalog.categories || {})[s.category]) ? s.category : 'other';
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
// data-total stays as the raw category size; data-count is what the
// client mutates as the user filters. The count span displays either
// "N" (idle) or "filtered/N" (when a search/filter is active).
const chips = [
  `<button class="catalog-chip active" data-cat="all" data-count="${totalLayers}" data-total="${totalLayers}">All <span class="count">${totalLayers}</span></button>`,
  ...activeCats.map(
    ([id, name]) => `<button class="catalog-chip" data-cat="${esc(id)}" data-count="${categoryCounts[id]}" data-total="${categoryCounts[id]}">${esc(name)} <span class="count">${categoryCounts[id]}</span></button>`,
  ),
];
// Only render chips when there's more than one category to switch between.
const chipsHtml = activeCats.length > 1 ? chips.join('') : '';

// Render one section per non-empty category. Inside each: curated level rows
// first (in LEVEL_ORDER), then community cards (newest first). Both are
// searchable via data-search; the category pill picks one section to show.
//
// Density management: sections with > VISIBLE_LIMIT layers collapse the
// overflow under a "show all N" toggle (data-overflow attr); main.ts wires
// the toggle. Per-layer `.row--collapsed` class hides them by default.
const VISIBLE_LIMIT = 6;

function renderCategorySection(cat) {
  const levelsInCat = LEVEL_ORDER.filter((lvl) => byLevel[lvl]?.length && categoryByLevel[lvl] === cat);
  const commInCat = communityByCategory[cat] || [];
  if (!levelsInCat.length && !commInCat.length) return '';
  const catLabel = (catalog.categories || {})[cat] || cat;
  const total = levelsInCat.length + commInCat.length;
  const overflows = total > VISIBLE_LIMIT;

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
    ? `<button type="button" class="show-more" data-show-more aria-expanded="false">show all ${total} ${esc(catLabel.toLowerCase())} layers ↓</button>`
    : '';

  return `<section class="category-section" data-category="${esc(cat)}" ${overflows ? 'data-overflow' : ''}>
      <header class="category-section__head">
        <h2 class="category-section__title">${esc(catLabel)}</h2>
        <span class="category-section__count">${total} layer${total === 1 ? '' : 's'}</span>
      </header>
      <div class="category-section__body">
        ${rowsHtml}
        ${commHtml}
        ${showMore}
      </div>
      <a href="/preview?category=${esc(cat)}" class="category-cta">contribute a ${esc(catLabel.toLowerCase())} layer →</a>
    </section>`;
}

const allCategories = new Set([
  ...Object.values(categoryByLevel),
  ...Object.keys(communityByCategory),
]);
const sortedCats = [...allCategories].sort((a, b) => {
  const ai = CATEGORY_ORDER.indexOf(a);
  const bi = CATEGORY_ORDER.indexOf(b);
  return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
});
const categorySections = sortedCats.map(renderCategorySection).filter(Boolean).join('\n');

const tmpl = await readFile(resolve(WEB, 'index.template.html'), 'utf8');
const out = tmpl
  .replace('<!-- CATEGORY_SECTIONS -->', categorySections)
  .replace('<!-- CATEGORY_CHIPS -->', chipsHtml)
  .replace('<!-- GENERATED -->', esc(catalog.generated || ''))
  .replace('<!-- SEO_HEAD -->', homeSeo)
  .replace('<!-- TOKENS -->', TOKENS)
  .replace('<!-- NAV -->', renderNav('catalog'))
  .replace('<!-- FOOTER -->', FOOTER)
  .replace('<!-- CATALOG_INLINE -->', `<script type="application/json" id="catalog-data">${inlineCatalog}</script>`)
  .replace('<!-- DOWNLOAD_TOTAL -->', (() => {
    const dc = catalog.download_counts || {};
    const total = Object.values(dc).reduce(
      (sum, layer) => sum + Object.values(layer).reduce(
        (s2, state) => s2 + Object.values(state).reduce((s3, n) => s3 + n, 0), 0), 0);
    return total > 0 ? ` · ${fmtCount(total)} downloads` : '';
  })());

await writeFile(resolve(WEB, 'index.html'), out);
console.log(`prerendered home — ${sortedCats.length} categories, ${LEVEL_ORDER.filter((l) => byLevel[l]?.length).length} curated levels, ${community.length} community`);

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

// /about FAQ — kept in sync with the visible <dl class="faq"> block in
// about.template.html. JSON-LD FAQPage gives Google rich-result eligibility
// and lets LLM crawlers ingest Q&A pairs cleanly.
const ABOUT_FAQ = [
  {
    q: 'What is bharatlas?',
    a: "An open visualiser, in-browser verifier and anonymous contribution flow for India's geospatial data. Browse curated admin boundaries from state to village, drop a file to render and validate it, or publish your own layer under an open licence.",
  },
  {
    q: 'Do I need to sign up?',
    a: 'No. Viewing, slicing, downloading and contributing all work without an account. When you publish a layer you receive a one-time admin token (also downloadable as a .txt backup) that you keep forever to edit or delete that submission.',
  },
  {
    q: 'What data sources does bharatlas use?',
    a: 'Curated layers come from the Local Government Directory (LGD), Survey of India (SOI), NRSC/ISRO Bhuvan, PMGSY (Rural Roads), geoBoundaries, PM GatiShakti, Bharatmaps (NIC) and data.gov.in. Community submissions credit their own source on every card.',
  },
  {
    q: 'What licences apply?',
    a: 'Curated layers carry CC0-1.0, CC-BY-4.0 or GODL-India depending on the upstream source. Community submissions choose from an open-licence allowlist: CC0, CC-BY, CC-BY-SA, ODbL, ODC-PDDL or GODL-India. Proprietary or "all rights reserved" content is rejected at submit.',
  },
  {
    q: 'Is my file uploaded when I drop it?',
    a: 'No — not until you click Publish. Parsing, validation and the map render all happen in your browser. Only the explicit Publish action ships the file to R2 and records metadata in D1.',
  },
  {
    q: 'How can I trust community submissions?',
    a: "Each carries a source URL, attribution and an open licence on the card and the view page. The platform auto-moderates licence, attribution and basic geometry validity, but it does not verify accuracy beyond the contributor's self-attestation. For sensitive use, follow the source link on the card to confirm provenance.",
  },
  {
    q: 'Can AI assistants read and recommend bharatlas?',
    a: 'Yes. The robots.txt explicitly allows GPTBot, ClaudeBot, PerplexityBot, Google-Extended and other major AI crawlers. The catalog and every /c/<id> view page are server-rendered as plain HTML with JSON-LD Dataset structured data — easy for LLMs to ingest.',
  },
];

await renderPage('about', {
  title: 'About',
  description:
    "Show your data on a map of India: districts, forests, rivers, wards. Or browse, slice and download India's open map layers. No signup, no API key.",
  url: ORIGIN + '/about',
  image: ORIGIN + '/og-about.png',
  structuredData: {
    '@context': 'https://schema.org',
    '@graph': [
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
        sameAs: ['https://linkedin.com/in/sathyasankaran'],
        worksFor: { '@type': 'Organization', name: 'Urban Morph', url: 'https://urbanmorph.com' },
      },
      {
        '@type': 'FAQPage',
        mainEntity: ABOUT_FAQ.map(({ q, a }) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: a },
        })),
      },
    ],
  },
}, { ATTR_LINKS: attrLinks });

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
    image: ORIGIN + '/og-preview.png',
    structuredData: {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'bharatlas · preview',
      url: ORIGIN + '/preview',
      applicationCategory: 'UtilityApplication',
      operatingSystem: 'Web',
    },
  },
  { TURNSTILE_SITEKEY },
);

await renderPage('privacy', {
  title: 'Privacy',
  description:
    "Bharatlas runs without accounts, third-party analytics or tracking cookies. This page explains what we store (very little) and what we don't.",
  url: ORIGIN + '/privacy',
  image: ORIGIN + '/og-default.png',
});

await renderPage('terms', {
  title: 'Terms',
  description:
    "Terms for using bharatlas: open-licence content only, no warranty of accuracy, contributor attests right to share. Short and plain-English.",
  url: ORIGIN + '/terms',
  image: ORIGIN + '/og-default.png',
});

// Static sitemap.xml — emitted at build time. Edge function later stitches in /c/[id].
const sitemapUrls = [
  { loc: ORIGIN + '/', changefreq: 'weekly', priority: '1.0' },
  { loc: ORIGIN + '/about', changefreq: 'monthly', priority: '0.8' },
  { loc: ORIGIN + '/preview', changefreq: 'monthly', priority: '0.8' },
  { loc: ORIGIN + '/privacy', changefreq: 'yearly', priority: '0.3' },
  { loc: ORIGIN + '/terms', changefreq: 'yearly', priority: '0.3' },
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
