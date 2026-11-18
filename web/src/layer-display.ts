// Human-facing title for the /view map chrome (top bar and About heading).
//
// The same title the layer's /layers card shows: the level label (built-in
// shared/level-meta.mjs, or the layer's own catalog level_meta entry), then the
// layer name, then the prettified id. The long seo_title is for <title> and the
// crawler <h1> only (functions/lib/view-dataset.ts), never the map chrome.
//
// A year in the title belongs to the layer. A built-in level label ("Blocks
// (2024)") describes the level's primary layer (LGD's 2024 snapshot), so an
// alternate source drops that year and shows one only from its own fields.
import { resolveLevelMeta, type CatalogLayer, type LevelMeta } from '../functions/lib/view-dataset';
import { pickPrimary } from '../../shared/level-meta.mjs';

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

type HeadingLayer = Pick<CatalogLayer, 'id' | 'level' | 'source' | 'rows' | 'provenance'> & {
  name?: string | null;
  title?: string | null;
  /** The data's own year, when the catalog entry records one. */
  vintage?: string | number | null;
};

/** A trailing parenthetical that holds a year: "(2024)", "(2008 delimitation)". */
const LABEL_YEAR = /\s*\([^()]*\b\d{4}\b[^()]*\)\s*$/;
const YEAR = /\b(?:19|20)\d{2}\b/;

/** The layer's own year: its vintage field, else a year in its own name or title. */
export function ownYear(layer: HeadingLayer): string | null {
  if (layer.vintage != null && String(layer.vintage).trim()) return String(layer.vintage).trim();
  return [layer.name, layer.title].map((s) => clean(s).match(YEAR)?.[0]).find(Boolean) ?? null;
}

/** True when the layer borrows its level's built-in label: it shares a level
 *  with other curated layers and is not the one the label describes. */
function borrowsLevelLabel(layer: HeadingLayer, catalogLevelMeta: Record<string, LevelMeta> | undefined, layers: readonly HeadingLayer[]): boolean {
  if (!layer.level || catalogLevelMeta?.[layer.id]) return false;
  const siblings = layers.filter((l) => l.level === layer.level && l.provenance !== 'community');
  return siblings.length > 1 && pickPrimary(siblings)?.id !== layer.id;
}

export function layerHeading(
  layer: HeadingLayer,
  catalogLevelMeta: Record<string, LevelMeta> | undefined,
  /** Every catalog layer: tells a level's primary layer from its alternates. */
  layers: readonly HeadingLayer[],
): LayerHeading {
  const meta = resolveLevelMeta(layer as CatalogLayer, catalogLevelMeta);
  const unit = clean(meta?.unit) || 'features';
  const count = layer.rows != null ? `${layer.rows.toLocaleString('en-IN')} ${unit}` : '';
  let title = displayTitle(layer, meta);
  if (borrowsLevelLabel(layer, catalogLevelMeta, layers)) {
    const year = ownYear(layer);
    title = title.replace(LABEL_YEAR, '') + (year ? ` (${year})` : '');
  }
  return {
    title,
    unit,
    meta: [count, clean(layer.source)].filter(Boolean).join(' · '),
  };
}
