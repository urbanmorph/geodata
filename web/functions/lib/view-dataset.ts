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
  provenance?: string;
  licence?: string;
  notes?: string;
  parquet?: { url: string; bytes: number } | null;
  pmtiles?: { url: string; bytes: number } | null;
  geojson?: { url: string; bytes: number } | null;
  kml?: { url: string; bytes: number } | null;
  shapefile?: { url: string; bytes: number } | null;
};

export type LevelMeta = {
  label: string;
  unit?: string;
  description?: string;
  /** SEO-tuned <title>/<h1>, overrides the short display `label` on the
   * /view page only (home-page cards keep `label`). Used for ward layers. */
  seo_title?: string;
  /** SEO-tuned meta description, overrides `description` on the /view page. */
  seo_description?: string;
};

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
};

const META_DESC_MAX = 158;
const LD_DESC_MIN = 80;

const BUILTIN_LEVEL_META: Record<string, LevelMeta> = {
  country: { label: 'India national boundary (2024)', unit: 'country (MultiPolygon)', description: "India's national boundary as a single MultiPolygon, dissolved from the 36 LGD state and UT polygons. LGD snapshot 2024." },
  state: { label: 'States (2024)', unit: 'states & UTs', description: 'Authoritative state and Union Territory boundaries from India\'s Local Government Directory (LGD). 36 polygons with the full LGD code chain. LGD snapshot 2024.' },
  district: { label: 'Districts (2024)', unit: 'districts', description: 'Every district in India. Joins to states via the LGD code. LGD snapshot 2024.' },
  subdistrict: { label: 'Sub-districts (2024)', unit: 'sub-districts', description: 'Tehsils, talukas and sub-divisions, the layer below a district. LGD snapshot 2024.' },
  block: { label: 'Blocks (2024)', unit: 'community-development blocks', description: 'Community-development blocks. The administrative unit that groups villages. LGD snapshot 2024.' },
  panchayat: { label: 'Gram Panchayats (2024)', unit: 'gram panchayats', description: 'Village-level local governance units. The constitutional tier below block, above village. LGD snapshot 2024.' },
  village: { label: 'Villages (2024)', unit: 'villages', description: 'Every revenue village in India. The finest admin polygon. LGD snapshot 2024.' },
  parliament_constituency: { label: 'Lok Sabha constituencies (2008 delimitation)', unit: 'parliament constituencies', description: 'All 543 Lok Sabha constituency polygons from the 2008 Delimitation Commission. In effect since the 2009 general election.' },
  assembly_constituency: { label: 'Vidhan Sabha constituencies (2008 delimitation)', unit: 'assembly constituencies', description: 'State legislative assembly constituency polygons across India. 2008 Delimitation Commission boundaries.' },
  high_court: { label: 'High Court jurisdictions (2024)', unit: 'high courts', description: "Territorial jurisdiction of India's 25 High Courts. Dissolved from LGD 2024 state polygons." },
  ngt_zone: { label: 'NGT zonal benches (2017)', unit: 'NGT zones', description: "National Green Tribunal's 5 zonal bench jurisdictions. Per the 2017 gazette notification." },
  nclt_bench: { label: 'NCLT benches (2024)', unit: 'NCLT benches', description: "National Company Law Tribunal's 15 bench jurisdictions. Per nclt.gov.in bench assignments." },
  pincode: { label: 'Pin codes (2025)', unit: 'pincode polygons', description: 'India Post pincode boundary polygons. Generated 2025.' },
  wildlife: { label: 'Wildlife sanctuaries + national parks (2024)', unit: 'protected areas', description: 'Protected-area polygons across India. Via PM GatiShakti, snapshot 2024.' },
  eco_zone: { label: 'Eco-sensitive zones (2024)', unit: 'eco-sensitive zones', description: 'MoEFCC-notified eco-sensitive zones around protected areas. Via Bharatmaps Parivesh, snapshot 2024.' },
  forest: { label: 'Forest boundaries (SOI)', unit: 'forest polygons', description: 'Reserved, protected, and unclassed forest boundary polygons from Survey of India topographic maps.' },
  ramsar: { label: 'Ramsar wetlands (2024)', unit: 'Ramsar sites', description: "India's wetland sites of international importance under the Ramsar Convention. Via Bharatmaps Parivesh, snapshot 2024." },
  wetland: { label: 'Wetland boundaries (2024)', unit: 'wetlands', description: 'All wetland polygons notified under MoEFCC Wetland Rules 2017. Via Bharatmaps Parivesh, snapshot 2024.' },
  river_basin: { label: 'River basins (2024)', unit: 'major river basins', description: "India's major river basin polygons from CWC WRIS, snapshot 2024." },
  river_subbasin: { label: 'River sub-basins (2024)', unit: 'sub-basins', description: 'For catchment-scale water-resources analysis. From CWC WRIS, snapshot 2024.' },
  river: { label: 'Rivers + streams (2024)', unit: 'river segments', description: "India's river network as line geometry from CWC WRIS, snapshot 2024." },
  flood_event: { label: 'Historical flood polygons (1960s-2020)', unit: 'flood events', description: 'India Flood Inventory v3.0. 1,006 flood event polygons across India from the 1960s to 2020.' },
  seismic_zone: { label: 'Seismic zones (IS 1893:2016)', unit: 'seismic zones', description: 'BIS IS 1893:2016 earthquake hazard zones II-V covering all of India.' },
  dam: { label: 'Dams (2024)', unit: 'dams', description: 'Dam point locations across India from Bharatmaps and CWC WRIS, both snapshot 2024.' },
  reservoir: { label: 'Reservoirs (2024)', unit: 'reservoirs', description: 'Reservoir polygons from CWC WRIS, snapshot 2024.' },
  airport: { label: 'Airports (2024)', unit: 'airports', description: 'Airports across India. Point features with name, type, district, and state. From data.gov.in, snapshot 2024.' },
  national_highway: { label: 'National highways (2024)', unit: 'highway segments', description: 'National highway centerlines from MoRTH via PM GatiShakti, snapshot 2024.' },
  health_facility: { label: 'Health facilities (2020)', unit: 'health facilities', description: 'Primary Health Centres, Community Health Centres, sub-centres, and district hospitals from NIC HealthGIS. Scraped March 2020.' },
};

export function resolveLevelMeta(
  layer: CatalogLayer,
  catalogLevelMeta: Record<string, LevelMeta> | undefined,
): LevelMeta | undefined {
  return catalogLevelMeta?.[layer.id] ?? (layer.level ? BUILTIN_LEVEL_META[layer.level] : undefined);
}

function mapLicenceUrl(licence: string): string {
  if (licence.includes('CC0')) return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (licence.includes('CC-BY-SA')) return 'https://creativecommons.org/licenses/by-sa/4.0/';
  if (licence.includes('CC-BY')) return 'https://creativecommons.org/licenses/by/4.0/';
  if (licence.includes('ODbL')) return 'https://opendatacommons.org/licenses/odbl/1-0/';
  return licence;
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

function buildDistribution(layer: CatalogLayer): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [key, encodingFormat] of DISTRIBUTION_FORMATS) {
    const ref = layer[key] as { url: string; bytes: number } | null | undefined;
    if (ref?.url) {
      out.push({
        '@type': 'DataDownload',
        encodingFormat,
        contentUrl: ref.url,
        ...(ref.bytes ? { contentSize: String(ref.bytes) } : {}),
      });
    }
  }
  return out;
}

export function buildViewDataset(
  layer: CatalogLayer,
  levelMeta: LevelMeta | undefined,
  origin: string,
): ViewDataset {
  const title = levelMeta?.seo_title || levelMeta?.label || layer.name || layer.id.replace(/_/g, ' ');
  const unit = levelMeta?.unit || 'features';
  const count = layer.rows != null ? layer.rows.toLocaleString('en-IN') : null;
  const baseDescription =
    levelMeta?.seo_description ??
    levelMeta?.description ??
    (layer.description || `${title} — ${count ? count + ' ' + unit + ' · ' : ''}${layer.source}.`);
  const description = baseDescription.slice(0, META_DESC_MAX);
  // Same padding template as prerender's homeSeo Dataset block: lifts
  // terse base descriptions over the ≥50 floor and seeds format/provenance
  // keywords for SERP rich snippets. Keep in sync with prerender.mjs's
  // padDatasetDescription suffix.
  const ldDescription =
    baseDescription.length >= LD_DESC_MIN
      ? baseDescription
      : `${baseDescription} Free to view, slice and download as Parquet, PMTiles, GeoJSON or KML. Open atlas of India by Urban Morph, sourced from ${layer.source}.`;
  const canonical = `${origin}/view/${layer.id}`;
  const ogImage = `${origin}/og/view/${layer.id}.png`;
  const distribution = buildDistribution(layer);

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
      license: layer.licence ? mapLicenceUrl(layer.licence) : undefined,
      isAccessibleForFree: true,
      creator: { '@type': 'Organization', name: layer.source },
      publisher: { '@type': 'Organization', name: 'bharatlas', url: 'https://bharatlas.com' },
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
        { '@type': 'ListItem', position: 2, name: 'Catalog', item: `${origin}/` },
        { '@type': 'ListItem', position: 3, name: title, item: canonical },
      ],
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));

function fmtSize(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function buildViewContent(
  layer: CatalogLayer,
  levelMeta: LevelMeta | undefined,
  origin: string,
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
      downloads.push(`<a href="${esc(obj.url)}">${label}</a> (${fmtSize(obj.bytes)})`);
    }
  }

  return `<article class="view-seo" style="max-width:720px;margin:80px auto;padding:0 24px;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;color:#444">
  <p style="font-size:13px;color:#888"><a href="/" style="color:#0a58ca">bharatlas</a> / <a href="/" style="color:#0a58ca">catalog</a> / ${esc(title)}</p>
  <h1 style="font-size:24px;font-weight:600;margin:8px 0">${esc(title)}</h1>
  <p>${count ? `<strong>${count}</strong> ${esc(unit)}` : ''} ${layer.source ? `· Source: ${esc(layer.source)}` : ''} ${layer.licence ? `· Licence: ${esc(layer.licence)}` : ''}</p>
  ${desc ? `<p>${esc(desc)}</p>` : ''}
  ${downloads.length ? `<p>Download: ${downloads.join(' · ')}</p>` : ''}
  <p>View this layer on an interactive map at <a href="${esc(origin)}/view/${esc(layer.id)}">${esc(origin)}/view/${esc(layer.id)}</a>. Filter by what the data contains and export as Parquet, GeoJSON, or KML.</p>
  <p><a href="/">Browse all layers on bharatlas</a></p>
</article>`;
}
