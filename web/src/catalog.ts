import { memoRetry } from './memo-retry';
import type { CatalogLayer, LevelMeta as EdgeLevelMeta } from '../functions/lib/view-dataset';
import type { ChoroplethSpec } from '../../shared/choropleth.mjs';

/** One catalog layer: the shape the edge reads (functions/lib/view-dataset.ts),
 *  plus what only the browser uses. The one layer type in web/src. */
export type Layer = CatalogLayer & {
  /** Value layers: colour polygons by one column (shared/choropleth.mjs). */
  choropleth?: ChoroplethSpec;
  fetched_at?: string;
  attribution?: { primary?: { name: string; url: string }; publisher?: { name: string; url: string } | null };
};

// v4.2: per-layer column statistics baked at build time (commit 3) so the
// FilterPanel can render its affordances with zero browser-side probe.
// External / community layers without baked stats fall back to live
// describeParquet via web/src/filter-probe.ts.
export type FilterStatsColumn = {
  name: string;
  type: 'string' | 'int' | 'float' | 'bool' | 'date' | 'geometry' | 'blob';
  distinct: number;
  null_frac: number;
  min?: string | number;
  max?: string | number;
  top_values?: Array<{ v: string | number; n: number }>;
};

export type LayerFilterStats = {
  row_count: number;
  columns: FilterStatsColumn[];
  // Pairs of columns that DuckDB detected as bijective at build time
  // (e.g. {state_lgd, stcode11, stname}). Only the canonical is shown
  // in the filter UI; the other members carry the same information and
  // would just confuse the user into ANDing them.
  column_groups?: Array<{ canonical: string; members: string[] }>;
};

/** Per-layer (or per-level) display metadata: the edge's level meta
 *  (functions/lib/view-dataset.ts, which reads the same field for /view SEO)
 *  plus the locate toolbar item's opt-in. */
export type LevelMeta = EdgeLevelMeta & { locate_label?: string; locate_mode?: string };

export type Catalog = {
  layers?: Layer[];
  level_meta?: Record<string, LevelMeta>;
  states?: Array<{ code: number; name: string }>;
  state_counts?: Record<string, Record<string, number>>;
  state_bounds?: Record<string, [number, number, number, number]>;
  extracts?: Record<string, Record<string, Record<string, { url: string; bytes: number }>>>;
  filter_stats?: Record<string, LayerFilterStats>;
  generated?: string;
  attribution?: Record<string, unknown>;
};

/**
 * The catalog (layers, level metadata, extracts, filter stats), fetched once
 * per page. Not inlined in the HTML: the home page would carry ~38 KB gzipped
 * that only the map uses. main.ts starts this fetch early (hover on a map link,
 * or a /view load) so it runs alongside the map chunk download.
 */
export const getCatalog: () => Promise<Catalog> = memoRetry(() =>
  fetch('/catalog.json').then((r) => {
    // Shown to the reader ("failed to load layer: ..."), so plain words, no file name or status.
    if (!r.ok) throw new Error("couldn't load the layer list");
    return r.json() as Promise<Catalog>;
  }));
