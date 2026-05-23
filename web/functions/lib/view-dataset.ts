// Pure builder for the /view/<id> page's per-layer meta + Dataset JSON-LD.
// Extracted from functions/view/[id].ts so the description-length rule
// (Google Dataset Search requires ≥50 chars) is unit-testable.

export type CatalogLayer = {
  id: string;
  level: string;
  source: string;
  rows: number | null;
  licence?: string;
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
};

const META_DESC_MAX = 158;
const LD_DESC_MIN = 80;

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
  const ldDescription =
    baseDescription.length >= LD_DESC_MIN
      ? baseDescription
      : `${baseDescription} Part of the bharatlas open atlas of India's geospatial data, sourced from ${layer.source}.`;
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
  };
}
