// Pure shape-builders: catalog row / D1 submission row → OgMetadata.

import type { OgMetadata } from './og-template';

type CatalogLayer = {
  id: string;
  level: string;
  source: string;
  rows: number | null;
  licence?: string;
};

type LayerLevelMeta = {
  label: string;
  unit?: string;
};

export type CuratedInput = {
  layer: CatalogLayer;
  levelMeta?: LayerLevelMeta;
};

export function curatedMetadata(input: CuratedInput): OgMetadata {
  const { layer, levelMeta } = input;
  const title = levelMeta?.label || layer.id.replace(/_/g, ' ');
  const unit = levelMeta?.unit || 'features';
  const count = layer.rows != null ? layer.rows.toLocaleString('en-IN') : null;
  const subtitle = count
    ? `${count} ${unit} · ${layer.source}`
    : layer.source;
  return {
    title,
    subtitle,
    tag: 'curated',
    footerLeft: layer.licence ? `licence · ${layer.licence}` : undefined,
  };
}

type Submission = {
  id: string;
  name: string;
  category?: string | null;
  license: string;
  attribution: string;
  feature_count: number | null;
  format: string;
  geometry_types?: string | null;
};

export function communityMetadata(submission: Submission): OgMetadata {
  const title = submission.name;
  const count = submission.feature_count;
  const countStr = count != null ? count.toLocaleString('en-IN') : '';
  const parts: string[] = [];
  if (countStr) parts.push(`${countStr} features`);
  if (submission.geometry_types) parts.push(submission.geometry_types);
  if (submission.category) parts.push(submission.category);
  return {
    title,
    subtitle: parts.join(' · ') || submission.format,
    tag: 'community',
    footerLeft: `${submission.attribution} · ${submission.license}`,
  };
}
