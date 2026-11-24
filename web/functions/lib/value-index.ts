// A large layer's value index (/api-data/value-index/<id>.json, scripts/bake_value_index.py):
// for each low-cardinality text column, the row groups each value is in and how many rows.
// A filtered query must count every match for `total`, so without it a query read the filter
// column of every row group (overture_places_india: 388 groups, about 15 s, Nov 2026); with
// it a one-value filter takes its total from the index and reads only the groups it needs.
// The file is used only while it was baked from the catalog's parquet (same url and bytes),
// and parquet-query.ts checks its row-group and row counts against the file it reads.
import { bakedFrom, fetchBakedJson, type AssetCtx } from './catalog-loader';
import { ResolvedCache } from './isolate-cache';

/** The file as baked: per column, each value's "group:count," pairs in hex; nulls apart. */
export interface ValueIndexFile {
  parquet: { url: string; bytes: number | null };
  row_groups: number;
  rows: number;
  columns: Record<string, { values: Record<string, string>; nulls?: string }>;
}

export interface ValueIndex {
  rowGroups: number;
  rows: number;
  /** Row group -> rows of `col` equal to `lower` (case-insensitive, as where matches), in
   *  row-group order; an empty map when none; null when `col` is not indexed. */
  groups(col: string, lower: string): Map<number, number> | null;
  /** Rows per stored value of `col` (nulls as "(null)", as group_by counts them); null when
   *  not indexed. Frozen: shared by every query of the isolate. */
  counts(col: string): Readonly<Record<string, number>> | null;
}

const pairs = (s: string | undefined): Array<[number, number]> =>
  (s ?? '').split(',').filter(Boolean).map((p) => {
    const [g, n] = p.split(':');
    return [parseInt(g, 16), parseInt(n, 16)];
  });

const sum = (ps: Array<[number, number]>) => ps.reduce((n, [, k]) => n + k, 0);

export function parseValueIndex(file: ValueIndexFile): ValueIndex {
  // Parsed lazily, one column at a time: a request touches one or two.
  const parsed = new Map<string, { byLower: Map<string, Map<number, number>>; counts: Readonly<Record<string, number>> }>();
  const column = (col: string) => {
    if (!Object.hasOwn(file.columns, col)) return null;
    let c = parsed.get(col);
    if (!c) {
      const byLower = new Map<string, Array<[number, number]>>();
      const counts: Record<string, number> = Object.create(null);
      for (const [value, s] of Object.entries(file.columns[col].values)) {
        const ps = pairs(s);
        counts[value] = sum(ps);
        byLower.set(value.toLowerCase(), [...(byLower.get(value.toLowerCase()) ?? []), ...ps]);
      }
      // A value spelled "(null)" and the nulls are one group, as group_by's String(v ?? '(null)').
      const nulls = sum(pairs(file.columns[col].nulls));
      if (nulls) counts['(null)'] = (counts['(null)'] ?? 0) + nulls;
      const merged = new Map<string, Map<number, number>>();
      for (const [key, ps] of byLower) {
        const m = new Map<number, number>();
        for (const [g, k] of ps.sort((a, b) => a[0] - b[0])) m.set(g, (m.get(g) ?? 0) + k);
        merged.set(key, m);
      }
      c = { byLower: merged, counts: Object.freeze(counts) };
      parsed.set(col, c);
    }
    return c;
  };
  return {
    rowGroups: file.row_groups,
    rows: file.rows,
    groups: (col, lower) => {
      const c = column(col);
      return c ? (c.byLower.get(lower) ?? new Map()) : null;
    },
    counts: (col) => column(col)?.counts ?? null,
  };
}

export const valueIndexPath = (id: string): string => `/api-data/value-index/${encodeURIComponent(id)}.json`;

// Parsed indexes, and misses (null), kept for the isolate: assets change only with a deploy,
// which starts new isolates. ResolvedCache shares only settled loads across requests (a load
// in flight dies with its request, isolate-cache.ts).
const loaded = new ResolvedCache<ValueIndex | null>(64);

/** The layer's value index, or null (none baked, stale, or unreadable: the query scans). */
export function loadValueIndex(
  ctx: AssetCtx, layer: { id: string; parquet?: { url: string; bytes: number | null } | null },
): Promise<ValueIndex | null> {
  if (layer.id.startsWith('c_') || !layer.parquet?.url) return Promise.resolve(null);
  return loaded.get(`${layer.id}@${layer.parquet.url}#${layer.parquet.bytes}`, async () => {
    const file = await fetchBakedJson<ValueIndexFile>(ctx, valueIndexPath(layer.id));
    return file && bakedFrom(file.parquet, layer) ? parseValueIndex(file) : null;
  }, ctx.request);
}

export function clearValueIndexCache(): void {
  loaded.clear();
}
