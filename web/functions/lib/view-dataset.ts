import { WARD_PLACES, mugiluUrl, yellideUrl } from './ward-places';
import { escapeHtml as esc, fmtBytes } from '../../../shared/format.mjs';
import { licenceUrl, licenceBadgeHtml, layerIsNonCommercial } from '../../../shared/licences.mjs';
import { LEVEL_META, pickPrimary, type LevelMeta } from '../../../shared/level-meta.mjs';
import { PUBLISHER_LD } from '../../../shared/brand.mjs';
// Pure builder for the /view/<id> page's per-layer meta + Dataset JSON-LD.
// Extracted from functions/view/[id].ts so the description-length rule
// (Google Dataset Search requires ≥50 chars) is unit-testable.

export type CatalogLayer = {
  id: string;
  /** null for community layers, which sit outside the admin-level ladder. */
  level: string | null;
  source: string;
  rows: number | null;
  /** Display name for layers without a LEVEL_META entry (e.g. community). */
  name?: string;
  description?: string;
  /** Some ingested layers carry a display title alongside `name`. */
  title?: string | null;
  /** The data's own year, when the catalog entry records one. */
  vintage?: string | number | null;
  provenance?: string;
  category?: string;
  licence?: string;
  non_commercial?: boolean;
  notes?: string;
  parquet?: { url: string; bytes: number } | null;
  pmtiles?: { url: string; bytes: number } | null;
  geojson?: { url: string; bytes: number } | null;
  kml?: { url: string; bytes: number } | null;
  shapefile?: { url: string; bytes: number } | null;
  /** Who to credit: the original source, and the republisher bharatlas took it from. */
  attribution?: { primary?: NamedLink | null; publisher?: NamedLink | null } | string | null;
  /** When bharatlas last fetched the layer from its source (ISO date or datetime). */
  fetched_at?: string | null;
  /** Dated releases of this layer, newest first (served catalog only). */
  versions?: Array<{ code: string; released?: string; sha256?: string; w3id?: string; url?: string }>;
};

type NamedLink = { name?: string | null; url?: string | null };

export type { LevelMeta };

export type ViewDataset = {
  title: string;
  /** Snippet-safe meta description (≤158 chars for Google's SERP cap). */
  description: string;
  /** JSON-LD Dataset description, padded to ≥80 chars to clear Google's
   * Dataset Search ≥50 minimum with margin. */
  ldDescription: string;
  canonical: string;
  ogImage: string;
  jsonLd: Record<string, unknown>;
  breadcrumbJsonLd: Record<string, unknown>;
  /** Ward pages only: a HowTo "find your ward number" block for AEO / the
   * "how to find my ward number in <city>" query. Omitted elsewhere. */
  howToJsonLd?: Record<string, unknown>;
  /** Ward pages with an area-name index only: an ItemList of ward→area pairs,
   * the structured answer for the "ward N <city> area name" query cluster. */
  wardListJsonLd?: Record<string, unknown>;
};

const META_DESC_MAX = 158;
const LD_DESC_MIN = 80;

export function resolveLevelMeta(
  layer: CatalogLayer,
  catalogLevelMeta: Record<string, LevelMeta> | undefined,
): LevelMeta | undefined {
  return catalogLevelMeta?.[layer.id] ?? (layer.level ? LEVEL_META[layer.level] : undefined);
}

/** The layer fields the alternate-source rule reads. */
export type LevelLayer = Pick<CatalogLayer, 'id' | 'level' | 'source' | 'provenance' | 'name' | 'title' | 'vintage'>;

/** A trailing parenthetical that holds a year: "(2024)", "(2008 delimitation)". */
const LABEL_YEAR = /\s*\([^()]*\b\d{4}\b[^()]*\)\s*$/;
const YEAR = /\b(?:19|20)\d{2}\b/;
const clean = (s: string | null | undefined): string => (s ?? '').trim();

/** The layer's own year: its vintage field, else a year in its own name or title. */
export function ownYear(layer: LevelLayer): string | null {
  if (layer.vintage != null && String(layer.vintage).trim()) return String(layer.vintage).trim();
  return [layer.name, layer.title].map((s) => clean(s).match(YEAR)?.[0]).find(Boolean) ?? null;
}

/** True when the layer borrows its level's built-in meta: it shares a level
 *  with other curated layers and is not the one the meta describes. */
function borrowsLevelMeta(
  layer: LevelLayer, catalogLevelMeta: Record<string, LevelMeta> | undefined, layers: readonly LevelLayer[],
): boolean {
  if (!layer.level || catalogLevelMeta?.[layer.id]) return false;
  const siblings = layers.filter((l) => l.level === layer.level && l.provenance !== 'community');
  return siblings.length > 1 && pickPrimary(siblings)?.id !== layer.id;
}

/** The level meta a layer's pages use. A built-in level entry ("Blocks (2024)",
 *  "... LGD snapshot 2024.") describes the level's primary layer, so an
 *  alternate source keeps only the level's name and count noun: the year comes
 *  from its own fields, the page title names its source (siblings would share
 *  one title otherwise), and the description falls back to its own. */
export function layerLevelMeta(
  layer: LevelLayer,
  catalogLevelMeta: Record<string, LevelMeta> | undefined,
  /** Every catalog layer: tells a level's primary layer from its alternates. */
  layers: readonly LevelLayer[],
): LevelMeta | undefined {
  const meta = resolveLevelMeta(layer as CatalogLayer, catalogLevelMeta);
  if (!meta || !borrowsLevelMeta(layer, catalogLevelMeta, layers)) return meta;
  const year = ownYear(layer);
  const label = meta.label.replace(LABEL_YEAR, '') + (year ? ` (${year})` : '');
  const source = clean(layer.source);
  return { label, unit: meta.unit, ...(source ? { seo_title: `${label} from ${source}` } : {}) };
}

// schema.org DataDownload entries for every format the layer publishes. This
// is the field Google Dataset Search keys on to surface the actual files —
// without it a Dataset is eligible but has no downloads to show.
const DISTRIBUTION_FORMATS: Array<[
  'parquet' | 'pmtiles' | 'geojson' | 'kml' | 'shapefile',
  string,
]> = [
  ['parquet', 'application/vnd.apache.parquet'],
  ['pmtiles', 'application/vnd.pmtiles'],
  ['geojson', 'application/geo+json'],
  ['kml', 'application/vnd.google-earth.kml+xml'],
  ['shapefile', 'application/zip'],
];

const FORMAT_NAMES: Record<(typeof DISTRIBUTION_FORMATS)[number][0], string> = {
  parquet: 'Parquet', pmtiles: 'PMTiles', geojson: 'GeoJSON', kml: 'KML', shapefile: 'Shapefile',
};

/** "Parquet, PMTiles or GeoJSON": the formats this layer actually ships. */
function formatList(layer: CatalogLayer): string {
  const names = DISTRIBUTION_FORMATS.filter(([key]) => layer[key]?.url).map(([key]) => FORMAT_NAMES[key]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names.join('');
}

/** schema.org `license`: the terms URL, or both URLs for a dual licence
 *  ("CC0-1.0 / CC-BY-4.0"); the id itself when it has no known URL. */
function licenceLd(licence: string | undefined): string | string[] | undefined {
  if (!licence) return undefined;
  const urls = licence.split('/').map((part) => licenceUrl(part.trim()) ?? part.trim());
  return urls.length > 1 ? urls : urls[0];
}

/** The credit to reproduce: the source by its own name, and the republisher
 *  bharatlas took it from (unless that is bharatlas itself). */
function creditLine(layer: CatalogLayer): string {
  const a = typeof layer.attribution === 'object' && layer.attribution ? layer.attribution : null;
  const source = a?.primary?.name?.trim() || layer.source;
  const via = a?.publisher?.name?.trim();
  const credit = via && via !== PUBLISHER_LD.name ? `${source}, via ${via}` : source;
  return `Source: ${credit}. Published via bharatlas (bharatlas.com).${layer.licence ? ` Licence: ${layer.licence}.` : ''}`;
}

function buildDistribution(layer: CatalogLayer): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [key, encodingFormat] of DISTRIBUTION_FORMATS) {
    const ref = layer[key] as { url: string; bytes: number } | null | undefined;
    if (ref?.url) {
      out.push({
        '@type': 'DataDownload',
        // A layer split per state ships its GeoJSON/KML as a zip of state files.
        encodingFormat: ref.url.endsWith('.zip') ? 'application/zip' : encodingFormat,
        contentUrl: ref.url,
        ...(ref.bytes ? { contentSize: String(ref.bytes) } : {}),
      });
    }
  }
  return out;
}

// Ward pages get a task-framed snippet + a HowTo, matching the real GSC
// queries ("which ward is my location", "[city] ward map", "ward number/name",
// "how to find my ward number in <city>") instead of the dataset-framed
// "Map of N wards… download GeoJSON" that was leaking the click. `subject` is
// the seo_title's "<City> Ward Map" prefix (split on ":"); `place` is that minus
// "Ward Map". Kept ≤158 chars by construction so the snippet never truncates.
// `origDescription` is the layer's hand-authored seo_description — its
// "boundaries and names" vs "…and numbers" wording is the only signal we have
// (the catalog carries no column schema) for whether the layer actually has
// area names. Only claim "name" / "area names" when it's there; never promise
// data the layer doesn't have. Data is what it is.
export function wardSeo(seoTitle: string, count: string | null, origDescription?: string, zones = 0): {
  description: string;
  howTo: Record<string, unknown>;
} {
  const subject = seoTitle.split(':')[0].trim() || seoTitle.trim();
  const place = subject.replace(/\s*ward map\s*$/i, '').trim() || subject;
  const n = count ? `${count} ` : '';
  const named = /\bnames?\b/i.test(origDescription || '');
  const youGet = named ? 'ward number and name' : 'ward number';
  // A layer with zones answers "zone wise ward list <city>"; say so instead of the ward count.
  const tail = zones
    ? `${place} zone-wise ward list for ${zones} zones`
    : named ? `${n}${place} wards with area names` : `${n}${place} wards`;
  return {
    description:
      `Which ward is your location in? Tap the map for your ${youGet}. ` +
      `${tail}, free to view or download.`,
    howTo: {
      '@context': 'https://schema.org',
      '@type': 'HowTo',
      name: `How to find your ward number in ${place}`,
      step: [
        { '@type': 'HowToStep', name: 'Open the ward map', text: `Open the ${subject} on bharatlas.` },
        { '@type': 'HowToStep', name: 'Tap your location', text: 'Tap "My ward" and allow location access.' },
        { '@type': 'HowToStep', name: 'Read your ward',
          text: named ? 'Your ward number and name appear on the map.' : 'Your ward number appears on the map.' },
      ],
    },
  };
}

/** One ward: its number, its name as the layer gives it ('' when none), and, view-only, the OpenStreetMap
 *  places inside it (scripts/fetch_osm_areas.py; never part of the layer or its downloads). */
export type WardRow = { no: string; name: string; areas?: string[]; zone?: string; group?: string };

// A ward layer's resolved number↔area pairs, baked by scripts/build_ward_index.py
// (which reads the parquet and maps each layer's idiosyncratic columns down to
// {no, name}). Served as a per-layer sidecar at /ward-index/<id>.json and fetched
// by the /view edge function for ward pages only — kept OUT of catalog.json so it
// never bloats the home document.
export type WardIndex = {
  id: string;
  /** Friendly city name for the caption/heading, e.g. "Ahmedabad". */
  place: string;
  /** Bake-snapshot date (YYYY-MM-DD); shown as the table's source line. */
  updated?: string;
  /** Header for the name column ("Area"/"Locality"/…); null when the source is
   *  number-only (Kolkata, Mumbai) and carries no area name. */
  nameLabel: string | null;
  /** Pre-sorted ward rows; `name` is '' when the layer has no name for it. */
  rows: WardRow[];
  /** Set when ward numbers restart per sub-body (Greater Bengaluru's corporations):
   *  each row carries its `group`, and a ward is (group, number). */
  groupCol?: string;
  groupLabel?: string;
  /** Credit for the rows' `areas`, when they come from OpenStreetMap. */
  areasSource?: { name: string; licence: string; fetched?: string | null };
};

// The crawlable ward#→area answer table. This is the payload for the loudest
// 0-click GSC cluster ("ward 22 ahmedabad area name", "vmc ward list area wise
// vadodara") that a map page can't satisfy in the SERP. Renders ONLY the columns
// the layer actually carries: a number-only layer gets a number list and no
// ItemList JSON-LD — we never invent an area name. Data is what it is.
function wardTable(idx: WardIndex | null | undefined): {
  html: string;
  jsonLd: Record<string, unknown> | null;
} {
  if (!idx || !idx.rows?.length) return { html: '', jsonLd: null };
  const hasNames = idx.nameLabel != null && idx.rows.some((r) => r.name);
  const hasAreas = idx.rows.some((r) => r.areas?.length);
  const label = hasNames ? idx.nameLabel! : null;
  const caption = hasNames
    ? `${idx.place} ward numbers and ${label!.toLowerCase()} names`
    : hasAreas
      ? `${idx.place} ward numbers and the areas in each`
      : `${idx.place} ward numbers`;
  const grouped = !!idx.groupLabel && idx.rows.some((r) => r.group);
  const head =
    `<tr>` + (grouped ? `<th scope="col">${esc(idx.groupLabel!)}</th>` : '') + `<th scope="col">Ward</th>` +
    (hasNames ? `<th scope="col">${esc(label!)}</th>` : '') +
    (hasAreas ? `<th scope="col">Areas (OpenStreetMap)</th>` : '') +
    `</tr>`;
  const body = idx.rows
    .map(
      (r) =>
        `<tr>` + (grouped ? `<td>${esc(r.group ?? '')}</td>` : '') + `<td>${esc(r.no)}</td>` +
        (hasNames ? `<td>${esc(r.name)}</td>` : '') +
        (hasAreas ? `<td>${esc((r.areas ?? []).join(', '))}</td>` : '') +
        `</tr>`,
    )
    .join('');
  const updated = idx.updated ? ` <span class="ward-index__src">Source snapshot: ${esc(idx.updated)}.</span>` : '';
  // OSM's places are placed in the ward that contains their point; they are a guide for readers, credited to OSM,
  // and kept out of the layer: its downloads carry only what the source published.
  const src = idx.areasSource;
  const osm = hasAreas
    ? ` <span class="ward-index__src">Areas: places from ${esc(src?.name ?? 'OpenStreetMap contributors')} (${esc(src?.licence ?? 'ODbL-1.0')}), ` +
      `placed in the ward that contains them${src?.fetched ? `, ${esc(src.fetched)}` : ''}; not part of the ward layer or its downloads.</span>`
    : '';
  const html =
    `<table class="ward-index"><caption>${esc(caption)}.${updated}${osm}</caption>` +
    `<thead>${head}</thead><tbody>${body}</tbody></table>`;
  const listed = idx.rows
    .map((r) => {
      const parts = [r.name, r.areas?.length ? `${r.areas.join(', ')} (OpenStreetMap)` : ''].filter(Boolean);
      const no = grouped && r.group ? `${r.no} (${r.group})` : r.no;
      return parts.length ? { no, text: parts.join('; ') } : null;
    })
    .filter((x): x is { no: string; text: string } => x != null);
  const jsonLd = hasNames || hasAreas
    ? {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: caption,
        numberOfItems: idx.rows.length,
        itemListElement: listed.map((r, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: `Ward ${r.no}: ${r.text}`,
        })),
      }
    : null;
  return { html, jsonLd };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
// "1" reads "Zone 1"; a value that names itself ("North Zone", "Zone-3") stays as the source writes it.
const zoneLabel = (z: string) => (/zone/i.test(z) ? z : `Zone ${z}`);
const wardItem = (r: WardRow) => `<li>Ward ${esc(r.no)}${r.name && r.name !== r.zone ? ` ${esc(r.name)}` : ''}</li>`;

// The zone-wise ward list ("zone wise ward list lucknow", "bhopal nagar nigam zone list"): the wards grouped under
// the zone the layer's own zone column gives them (scripts/build_ward_index.py). Rendered only when the layer has
// at least two zones; wards the source gives no zone are named as such, never placed in one.
function zoneList(idx: WardIndex | null | undefined): { html: string; zones: number } {
  const groups = new Map<string, WardRow[]>();
  for (const r of idx?.rows ?? []) {
    if (r.zone) groups.set(r.zone, [...(groups.get(r.zone) ?? []), r]);
  }
  if (!idx || groups.size < 2) return { html: '', zones: 0 };
  const zoned = [...groups.values()].reduce((n, rows) => n + rows.length, 0);
  const unzoned = idx.rows.filter((r) => !r.zone);
  const sections = [...groups]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([z, rows]) => `<h3>${esc(zoneLabel(z))} (${plural(rows.length, 'ward')})</h3><ul>${rows.map(wardItem).join('')}</ul>`)
    .join('');
  const none = unzoned.length
    ? ` ${plural(unzoned.length, 'ward')} ${unzoned.length === 1 ? 'has' : 'have'} no zone in the source: ` +
      `${unzoned.map((r) => `Ward ${esc(r.no)}`).join(', ')}.`
    : '';
  const html =
    `<section class="ward-zones"><h2>${esc(idx.place)} zone-wise ward list</h2>` +
    `<p>${plural(zoned, 'ward')} in ${groups.size} zones, as the source groups them.${none}</p>${sections}</section>`;
  return { html, zones: groups.size };
}

// A ward page uses each table twice (the article, and the description or the
// ItemList JSON-LD): build them once per ward index.
function oncePerIndex<T>(build: (idx: WardIndex | null | undefined) => T): (idx: WardIndex | null | undefined) => T {
  const memo = new WeakMap<WardIndex, T>();
  return (idx) => {
    if (!idx) return build(idx);
    if (!memo.has(idx)) memo.set(idx, build(idx));
    return memo.get(idx)!;
  };
}
export const buildWardTable = oncePerIndex(wardTable);
export const buildZoneList = oncePerIndex(zoneList);

export function buildViewDataset(
  layer: CatalogLayer,
  levelMeta: LevelMeta | undefined,
  origin: string,
  wardIndex?: WardIndex | null,
): ViewDataset {
  const title = levelMeta?.seo_title || levelMeta?.label || layer.name || layer.id.replace(/_/g, ' ');
  const unit = levelMeta?.unit || 'features';
  const count = layer.rows != null ? layer.rows.toLocaleString('en-IN') : null;
  // Ward layers are the #1 search intent ("which ward am I in"); override the
  // dataset-framed snippet with a task-framed one + HowTo. Titles stay as-is —
  // they already match the dominant "<city> ward map" / "<corp> ward map" query.
  const ward = /^wards_/.test(layer.id)
    ? wardSeo(title, count, levelMeta?.seo_description, buildZoneList(wardIndex).zones)
    : null;
  const baseDescription =
    ward?.description ??
    levelMeta?.seo_description ??
    levelMeta?.description ??
    (layer.description || `${title}: ${count ? count + ' ' + unit + ' · ' : ''}${layer.source}.`);
  const description = baseDescription.slice(0, META_DESC_MAX);
  const formats = formatList(layer);
  // Lifts terse base descriptions over Google Dataset Search's ≥50 floor and
  // seeds format/provenance words for SERP rich snippets.
  const ldDescription =
    baseDescription.length >= LD_DESC_MIN
      ? baseDescription
      : `${baseDescription} Free to view, slice and download${formats ? ` as ${formats}` : ''}. Open atlas of India by bharatlas, sourced from ${layer.source}.`;
  const canonical = `${origin}/view/${layer.id}`;
  const ogImage = `${origin}/og/view/${layer.id}.png`;
  const distribution = buildDistribution(layer);
  const wardListJsonLd = buildWardTable(wardIndex).jsonLd;
  // Machine-readable rights that travel with the data to AI agents and dataset
  // crawlers (PDGI "humans in the loop"): the credit to reproduce, that access
  // is unrestricted, and where the usage terms live.
  const creditText = creditLine(layer);
  const primary = typeof layer.attribution === 'object' ? layer.attribution?.primary : null;
  const dateModified = /^\d{4}-\d{2}-\d{2}/.test(layer.fetched_at || '') ? layer.fetched_at!.slice(0, 10) : undefined;
  const version = layer.versions?.[0]?.code;
  // Google Dataset Search matches queries on keywords (the home page's
  // per-level Dataset blocks carried them before they moved here).
  const keywords = [...new Set([layer.level, levelMeta?.label, layer.source, layer.category, 'India']
    .filter((k): k is string => typeof k === 'string' && k.length > 0))];

  return {
    title,
    description,
    ldDescription,
    canonical,
    ogImage,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: title,
      description: ldDescription,
      url: canonical,
      license: licenceLd(layer.licence),
      isAccessibleForFree: true,
      keywords,
      creditText,
      conditionsOfAccess: 'Free and open. No account or API key required.',
      usageInfo: `${origin}/terms`,
      creator: primary?.name
        ? { '@type': 'Organization', name: primary.name, ...(primary.url ? { url: primary.url } : {}) }
        : { '@type': 'Organization', name: layer.source },
      publisher: PUBLISHER_LD,
      ...(dateModified ? { dateModified } : {}),
      ...(version ? { version } : {}),
      spatialCoverage: { '@type': 'Place', name: 'India' },
      ...(distribution.length ? { distribution } : {}),
    },
    // Sibling JSON-LD block. Google honors multiple <script type="application/
    // ld+json"> blocks on one page and de-dupes by @type. Surfaces breadcrumb
    // trail under the URL in SERPs without coupling Dataset payload tests to
    // a wrapping @graph.
    breadcrumbJsonLd: {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}/` },
        { '@type': 'ListItem', position: 2, name: 'All layers', item: `${origin}/layers` },
        { '@type': 'ListItem', position: 3, name: title, item: canonical },
      ],
    },
    ...(ward ? { howToJsonLd: ward.howTo } : {}),
    ...(wardListJsonLd ? { wardListJsonLd } : {}),
  };
}


// Prominent city ward maps, cross-linked from every ward page so the cluster
// shares internal link equity — the lever for the ward pages stuck at GSC pos
// 8-10 (Ahmedabad, Kolkata, Mumbai, Vadodara, Bhubaneswar, Surat) which each
// convert ~0% because nothing points authority at them. Crawlable, additive,
// ~1 KB. Labels are the plain city name the query uses ("kolkata ward map").
const WARD_SIBLINGS: ReadonlyArray<readonly [string, string]> = [
  ['wards_ahmedabad', 'Ahmedabad'], ['wards_mumbai', 'Mumbai'], ['wards_delhi', 'Delhi'],
  ['wards_bengaluru_gba', 'Bengaluru'], ['wards_hyderabad', 'Hyderabad'], ['wards_chennai', 'Chennai'],
  ['wards_kolkata', 'Kolkata'], ['wards_pune', 'Pune'], ['wards_surat', 'Surat'],
  ['wards_vadodara', 'Vadodara'], ['wards_bhubaneshwar', 'Bhubaneswar'], ['wards_indore', 'Indore'],
];

// The "Ward maps for other cities" nav, omitting the current layer.
function renderWardCrosslinks(currentId: string): string {
  const links = WARD_SIBLINGS.filter(([id]) => id !== currentId).map(
    ([id, label]) => `<a href="/view/${esc(id)}">${esc(label)} ward map</a>`,
  );
  if (!links.length) return '';
  return `<nav class="view-seo__wards" aria-label="Ward maps for other cities"><p>Ward maps for other cities: ${links.join(' · ')}</p></nav>`;
}

// The same place on the sister sites: the sky over the city now (mugilu) and the species of its state (yellide).
// Plain links, so readers and search engines follow them.
function renderAround(layerId: string): string {
  const p = WARD_PLACES[layerId];
  if (!p) return '';
  return `<nav class="view-seo__around" aria-label="Around ${esc(p.city)}"><p>Around ${esc(p.city)}: ` +
    `<a href="${esc(mugiluUrl(p))}">Air, heat and warnings in ${esc(p.city)} now (mugilu)</a> · ` +
    `<a href="${esc(yellideUrl(p))}">Species of ${esc(p.stateName)} (yellide)</a></p></nav>`;
}

export function buildViewContent(
  layer: CatalogLayer,
  levelMeta: LevelMeta | undefined,
  origin: string,
  wardIndex?: WardIndex | null,
): string {
  // H1 uses the SEO title (keyword-aligned with the <title>); the body
  // paragraph keeps the richer `description` (official corp name + zones).
  const title = levelMeta?.seo_title || levelMeta?.label || layer.name || layer.id.replace(/_/g, ' ');
  const count = layer.rows != null ? layer.rows.toLocaleString('en-IN') : null;
  const unit = levelMeta?.unit || 'features';
  const desc = levelMeta?.description || layer.description || layer.notes || '';

  const downloads: string[] = [];
  for (const [fmt, label] of [['parquet', 'Parquet'], ['geojson', 'GeoJSON'], ['kml', 'KML'], ['shapefile', 'Shapefile']]) {
    const obj = (layer as Record<string, unknown>)[fmt] as { url: string; bytes: number } | null | undefined;
    if (obj?.url) {
      downloads.push(`<a href="${esc(obj.url)}">${label}</a> (${fmtBytes(obj.bytes)})`);
    }
  }

  // Ward pages only: the crawlable ward→area answer table (when the layer
  // carries names) and the city cross-link cluster. Both are empty strings on
  // non-ward layers, so the article shape is unchanged there.
  const isWard = /^wards_/.test(layer.id);
  const wardTable = isWard ? buildZoneList(wardIndex).html + buildWardTable(wardIndex).html : '';
  const crosslinks = isWard ? renderWardCrosslinks(layer.id) : '';
  const around = isWard ? renderAround(layer.id) : '';

  // Colors/layout live in the .view-seo CSS in index.template.html (theme-aware
  // via tokens) — NOT inline hex, which fails contrast in dark mode and gives
  // no-JS readers low-contrast text. Links are underlined there too.
  return `<article class="view-seo">
  <p class="view-seo__crumb"><a href="/">bharatlas</a> / <a href="/layers">all layers</a> / ${esc(title)}</p>
  <h1>${esc(title)}</h1>
  <p>${count ? `<strong>${count}</strong> ${esc(unit)}` : ''} ${layer.source ? `· Source: ${esc(layer.source)}` : ''} ${layer.licence ? `· Licence: ${licenceBadgeHtml(layer.licence, layerIsNonCommercial(layer))}` : ''}</p>
  ${desc ? `<p>${esc(desc)}</p>` : ''}
  ${downloads.length ? `<p>Download: ${downloads.join(' · ')}</p>` : ''}
  ${wardTable}
  ${around}
  <p>View this layer on an interactive map at <a href="${esc(origin)}/view/${esc(layer.id)}">${esc(origin)}/view/${esc(layer.id)}</a>. Filter by what the data contains and export as Parquet, GeoJSON, or KML.</p>
  ${crosslinks}
  <p><a href="/">Browse all layers on bharatlas</a></p>
</article>`;
}
