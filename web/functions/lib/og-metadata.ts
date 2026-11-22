// Pure shape-builders: catalog row / D1 submission row → OgMetadata.

import type { OgMetadata } from './og-template';
import type { CatalogLayer as ApiCatalogLayer } from './catalog-api';
import { isAlternateSource, layerLevelMeta, viewTitle, type LevelLayer, type LevelMeta } from './view-dataset';

type CatalogLayer = Pick<ApiCatalogLayer, 'id' | 'source' | 'rows' | 'licence'>;

type LayerLevelMeta = {
  label: string;
  unit?: string;
};

export type CuratedInput = {
  layer: CatalogLayer;
  levelMeta?: LayerLevelMeta;
  /** Overrides the level label as the card title. */
  title?: string;
};

export function curatedMetadata(input: CuratedInput): OgMetadata {
  const { layer, levelMeta } = input;
  const title = input.title || levelMeta?.label || layer.id.replace(/_/g, ' ');
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

/** A curated layer's card, titled by the /view page's level rule. An alternate
 *  source takes the page's own title ("Blocks from Bhuvan"), since its
 *  siblings share the level label; every other layer keeps the short label. */
export function curatedCard(
  layer: CatalogLayer & LevelLayer,
  catalogLevelMeta: Record<string, LevelMeta> | undefined,
  layers: readonly LevelLayer[],
): OgMetadata {
  const levelMeta = layerLevelMeta(layer, catalogLevelMeta, layers);
  const alternate = isAlternateSource(layer, catalogLevelMeta, layers);
  return curatedMetadata({ layer, levelMeta, title: alternate ? viewTitle(layer, levelMeta) : undefined });
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
