// /api/v1/layers/{id}/schema from the layer's baked stats file, a static asset
// (/api-data/filter-stats/<id>.json, scripts/bake_filter_stats.py), instead of
// sampling the parquet on R2: the live read took 16 to 109 range reads and a
// p50 of 3 s per edge-cache miss (Nov 2026). The file is used only while it
// was baked from the catalog's parquet (same url and bytes); a community layer
// (c_*) or a missing or stale file falls back to the live read (getSchema).
import { bakedFrom, fetchBakedJson, type AssetCtx } from './catalog-loader';
import { statsPath } from './catalog-api';
import { isGeomColumn, MAX_DISTINCT_SAMPLE, schemaType, type ColumnSchema, type LayerSchema } from './parquet-query';

/** A baked stats file: the Filter panel's column stats, plus the parquet it was
 *  baked from and the parquet's top-level columns with their types. */
export interface BakedStats {
  row_count: number;
  columns: Array<{ name: string; distinct: number; top_values?: Array<{ v: unknown; n: number }> }>;
  parquet?: { url: string; bytes: number | null };
  schema?: Array<{ name: string; type?: string; converted_type?: string; nested?: boolean }>;
}

/** The file has a schema and was baked from the parquet the catalog names now. */
export function isBakedFor(stats: BakedStats, layer: { parquet?: { url: string; bytes: number | null } | null }): boolean {
  return !!stats.schema && bakedFrom(stats.parquet, layer);
}

/**
 * The /schema answer from a stats file, shaped as getSchema's: every top-level
 * column but the geometry, typed as schemaType types it, with distinct_values
 * (as text, sorted) when the whole file has 1 to MAX_DISTINCT_SAMPLE of them.
 * Added: distinct_count (whole file) and, for a column with more values than
 * that, the baked top values with their row counts, unless every value
 * appears once (an id column: the list would only add bytes).
 */
export function schemaFromStats(stats: BakedStats): LayerSchema {
  const byName = new Map(stats.columns.map((c) => [c.name, c]));
  const columns: ColumnSchema[] = [];
  for (const s of stats.schema ?? []) {
    if (!s.name || isGeomColumn(s.name)) continue;
    if (s.nested) { columns.push({ name: s.name, type: 'nested' }); continue; }
    const col: ColumnSchema = { name: s.name, type: schemaType(s.type, s.converted_type) };
    const st = byName.get(s.name);
    if (st && st.distinct >= 0) {
      const top = (st.top_values ?? []).map((t) => ({ value: String(t.v), count: t.n }));
      if (st.distinct >= 1 && st.distinct <= MAX_DISTINCT_SAMPLE && top.length === st.distinct) {
        col.distinct_values = top.map((t) => t.value).sort();
      } else if (top.some((t) => t.count > 1)) {
        col.top_values = top;
      }
      col.distinct_count = st.distinct;
    }
    columns.push(col);
  }
  return { row_count: stats.row_count, columns };
}

/** The layer's schema from its baked file, or null when there is no fresh one. */
export async function bakedSchema(
  ctx: AssetCtx,
  layer: { id: string; parquet?: { url: string; bytes: number | null } | null },
): Promise<LayerSchema | null> {
  if (layer.id.startsWith('c_')) return null;
  const stats = await fetchBakedJson<BakedStats>(ctx, statsPath(layer.id));
  return stats && isBakedFor(stats, layer) ? schemaFromStats(stats) : null;
}
