// Human-facing title for the /view map chrome (top bar and About heading).
//
// The same title the layer's /layers card shows: the level label (built-in
// shared/level-meta.mjs, or the layer's own catalog level_meta entry), then the
// layer name, then the prettified id. The long seo_title is for <title> and the
// crawler <h1> only (functions/lib/view-dataset.ts), never the map chrome.
import { resolveLevelMeta, type CatalogLayer, type LevelMeta } from '../functions/lib/view-dataset';

export type DisplayLayer = { id: string; name?: string | null };
export type DisplayLevelMeta = { label?: string | null } | null | undefined;

/** "wards_bengaluru_bbmp_2022" -> "wards bengaluru bbmp 2022". Last-resort
 *  fallback when a layer has neither level meta nor a display name. */
export function prettifyId(id: string): string {
  return id.replace(/_/g, ' ').trim();
}

const clean = (s: string | null | undefined): string => (s ?? '').trim();

export function displayTitle(layer: DisplayLayer, levelMeta?: DisplayLevelMeta): string {
  return clean(levelMeta?.label) || clean(layer.name) || prettifyId(layer.id);
}

export type LayerHeading = {
  /** The card title, e.g. "Districts (2024)". */
  title: string;
  /** The count noun, e.g. "districts" ("features" when the level has none). */
  unit: string;
  /** A short line under or beside the title, e.g. "785 districts · LGD". */
  meta: string;
};

type HeadingLayer = Pick<CatalogLayer, 'id' | 'level' | 'source' | 'rows'> & { name?: string | null };

export function layerHeading(layer: HeadingLayer, catalogLevelMeta: Record<string, LevelMeta> | undefined): LayerHeading {
  const meta = resolveLevelMeta(layer as CatalogLayer, catalogLevelMeta);
  const unit = clean(meta?.unit) || 'features';
  const count = layer.rows != null ? `${layer.rows.toLocaleString('en-IN')} ${unit}` : '';
  return {
    title: displayTitle(layer, meta),
    unit,
    meta: [count, clean(layer.source)].filter(Boolean).join(' · '),
  };
}
