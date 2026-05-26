// Pure builder for the /view/<id> page's per-layer meta + Dataset JSON-LD.
// Extracted from functions/view/[id].ts so the description-length rule
// (Google Dataset Search requires ≥50 chars) is unit-testable.

export type CatalogLayer = {
  id: string;
  level: string;
  source: string;
  rows: number | null;
  licence?: string;
  notes?: string;
  parquet?: { url: string; bytes: number } | null;
  geojson?: { url: string; bytes: number } | null;
  kml?: { url: string; bytes: number } | null;
  shapefile?: { url: string; bytes: number } | null;
};

export type LevelMeta = {
  label: string;
  unit?: string;
  description?: string;
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
  country: { label: 'India national boundary', unit: 'country (MultiPolygon)', description: "India's national boundary as a single MultiPolygon, dissolved from the 36 LGD state and UT polygons." },
  state: { label: 'States', unit: 'states & UTs', description: 'Authoritative state and Union Territory boundaries from India\'s Local Government Directory (LGD). 36 polygons with the full LGD code chain, enabling joins with district, subdistrict, block and village layers.' },
  district: { label: 'Districts', unit: 'districts', description: 'Every district in India. Joins to states via the LGD code.' },
  subdistrict: { label: 'Sub-districts', unit: 'sub-districts', description: 'Tehsils, talukas and sub-divisions, the layer below a district.' },
  block: { label: 'Blocks', unit: 'community-development blocks', description: 'Community-development blocks. The administrative unit that groups villages.' },
  panchayat: { label: 'Gram Panchayats', unit: 'gram panchayats', description: 'Village-level local governance units. The constitutional tier below block, above village.' },
  village: { label: 'Villages', unit: 'villages', description: 'Every revenue village in India. The finest admin polygon.' },
  parliament_constituency: { label: 'Lok Sabha constituencies', unit: 'parliament constituencies', description: 'All 543 Lok Sabha constituency polygons, latest delimitation.' },
  assembly_constituency: { label: 'Vidhan Sabha constituencies', unit: 'assembly constituencies', description: 'State legislative assembly constituency polygons across India.' },
  high_court: { label: 'High Court jurisdictions', unit: 'high courts', description: "Territorial jurisdiction of India's 25 High Courts. Dissolved from LGD state polygons." },
  ngt_zone: { label: 'NGT zonal benches', unit: 'NGT zones', description: "National Green Tribunal's 5 zonal bench jurisdictions." },
  nclt_bench: { label: 'NCLT benches', unit: 'NCLT benches', description: "National Company Law Tribunal's 15 bench jurisdictions." },
  pincode: { label: 'Pin codes', unit: 'pincode polygons', description: 'India Post pincode boundary polygons.' },
  wildlife: { label: 'Wildlife sanctuaries + national parks', unit: 'protected areas', description: 'Protected-area polygons across India. Via PM GatiShakti.' },
  eco_zone: { label: 'Eco-sensitive zones', unit: 'eco-sensitive zones', description: 'MoEFCC-notified eco-sensitive zones around protected areas.' },
  forest: { label: 'Forest boundaries', unit: 'forest polygons', description: 'Reserved, protected, and unclassed forest boundary polygons from Survey of India.' },
  ramsar: { label: 'Ramsar wetlands', unit: 'Ramsar sites', description: "India's wetland sites of international importance under the Ramsar Convention." },
  wetland: { label: 'Wetland boundaries', unit: 'wetlands', description: 'All wetland polygons notified under MoEFCC Wetland Rules 2017.' },
  river_basin: { label: 'River basins', unit: 'major river basins', description: "India's major river basin polygons from CWC WRIS." },
  river_subbasin: { label: 'River sub-basins', unit: 'sub-basins', description: 'Finer than basins, for catchment-scale water-resources analysis. From CWC WRIS.' },
  river: { label: 'Rivers + streams', unit: 'river segments', description: "India's river network as line geometry from CWC WRIS." },
  flood_event: { label: 'Historical flood polygons', unit: 'flood events', description: 'Historical flood event polygons across India from the 1960s to 2020.' },
  seismic_zone: { label: 'Seismic zones', unit: 'seismic zones', description: 'BIS IS 1893:2016 earthquake hazard zones II-V covering all of India.' },
  dam: { label: 'Dams', unit: 'dams', description: 'Dam point locations across India from Bharatmaps and CWC WRIS.' },
  reservoir: { label: 'Reservoirs', unit: 'reservoirs', description: 'Reservoir polygons from CWC WRIS.' },
  airport: { label: 'Airports', unit: 'airports', description: 'Airports across India. Point features with name, type, district, and state.' },
  national_highway: { label: 'National highways', unit: 'highway segments', description: 'National highway centerlines from the Ministry of Road Transport and Highways.' },
  health_facility: { label: 'Health facilities', unit: 'health facilities', description: 'Primary Health Centres, Community Health Centres, sub-centres, and district hospitals from NIC HealthGIS.' },
};

export function resolveLevelMeta(
  layer: CatalogLayer,
  catalogLevelMeta: Record<string, LevelMeta> | undefined,
): LevelMeta | undefined {
  return catalogLevelMeta?.[layer.id] ?? BUILTIN_LEVEL_META[layer.level];
}

function mapLicenceUrl(licence: string): string {
  if (licence.includes('CC0')) return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (licence.includes('CC-BY-SA')) return 'https://creativecommons.org/licenses/by-sa/4.0/';
  if (licence.includes('CC-BY')) return 'https://creativecommons.org/licenses/by/4.0/';
  if (licence.includes('ODbL')) return 'https://opendatacommons.org/licenses/odbl/1-0/';
  return licence;
}

export function buildViewDataset(
  layer: CatalogLayer,
  levelMeta: LevelMeta | undefined,
  origin: string,
): ViewDataset {
  const title = levelMeta?.label || layer.id.replace(/_/g, ' ');
  const unit = levelMeta?.unit || 'features';
  const count = layer.rows != null ? layer.rows.toLocaleString('en-IN') : null;
  const baseDescription =
    levelMeta?.description ??
    `${title} — ${count ? count + ' ' + unit + ' · ' : ''}${layer.source}.`;
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
      creator: { '@type': 'Organization', name: layer.source },
      spatialCoverage: { '@type': 'Place', name: 'India' },
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
  const title = levelMeta?.label || layer.id.replace(/_/g, ' ');
  const count = layer.rows != null ? layer.rows.toLocaleString('en-IN') : null;
  const unit = levelMeta?.unit || 'features';
  const desc = levelMeta?.description || layer.notes || '';

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
