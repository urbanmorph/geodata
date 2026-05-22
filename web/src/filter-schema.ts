// v4.2 commit 1: schema → affordance picker.
// Pure functions: no DOM, no DuckDB. Inputs are baked column stats (from
// scripts/build_filter_stats.py) or live-probed DESCRIBE output (commit 4).
// Outputs are an Affordance per column that the UI knows how to render.

export type ColumnType =
  | 'string'
  | 'int'
  | 'float'
  | 'bool'
  | 'date'
  | 'geometry'
  | 'blob';

export type ColumnStats = {
  name: string;
  type: ColumnType;
  distinct: number;
  nullFrac: number;
  min?: number | string;
  max?: number | string;
  // `label` is an optional display string for a top value — used to render
  // numeric state codes as their state names, etc. The filter still keys on
  // `v` (the actual data value); `label` only affects the chip text.
  topValues?: Array<{ v: string | number; n: number; label?: string }>;
};

export type Affordance =
  | { kind: 'facet'; values: Array<{ v: string | number; n: number; label?: string }> }
  | { kind: 'searchable'; sampleValues: Array<string | number> }
  | { kind: 'search' }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'boolean' }
  | { kind: 'drop'; reason: string };

export const DISPLAY_CAP = 6;

// Below this row count, all-unique drops are skipped — small tables
// trivially have unique values even in genuinely useful columns.
export const ALL_UNIQUE_MIN_ROWS = 50;

const ID_NAME_RX = /^(id|fid|objectid|gid|uuid|hash|geohash)$|_id$/i;
const GEOM_NAME_RX = /^(geom|geometry|shape|wkb|wkt)$/i;

const BOOL_VALUE_SETS: Array<Set<string>> = [
  new Set(['0', '1']),
  new Set(['true', 'false']),
  new Set(['yes', 'no']),
  new Set(['y', 'n']),
];

function isBooleanByValues(top: Array<{ v: string | number; n: number }>): boolean {
  if (top.length !== 2) return false;
  const got = new Set(top.map((v) => String(v.v).trim().toLowerCase()));
  return BOOL_VALUE_SETS.some(
    (set) => set.size === got.size && [...set].every((x) => got.has(x)),
  );
}

export function pickAffordance(col: ColumnStats, rowCount: number): Affordance {
  if (col.type === 'geometry' || col.type === 'blob') {
    return { kind: 'drop', reason: 'geometry/blob' };
  }
  if (GEOM_NAME_RX.test(col.name)) {
    return { kind: 'drop', reason: 'geometry-like name' };
  }
  if (col.distinct <= 1) return { kind: 'drop', reason: 'all-same' };
  if (col.nullFrac > 0.95) return { kind: 'drop', reason: 'mostly null' };
  if (ID_NAME_RX.test(col.name)) return { kind: 'drop', reason: 'id-like name' };

  // High-uniqueness numeric/int columns are almost always OBJECTID-style row
  // keys with no filter value. High-uniqueness STRINGS (village_name etc.)
  // stay — they're the natural target of free-text search.
  if (rowCount >= ALL_UNIQUE_MIN_ROWS && col.distinct > 50 && col.type !== 'string') {
    const nonNull = rowCount * (1 - col.nullFrac);
    if (nonNull > 0 && col.distinct / nonNull > 0.97) {
      return { kind: 'drop', reason: 'all-unique' };
    }
  }

  if (col.type === 'bool') return { kind: 'boolean' };
  if (col.distinct === 2 && col.topValues && isBooleanByValues(col.topValues)) {
    return { kind: 'boolean' };
  }

  if (col.type === 'int' || col.type === 'float' || col.type === 'date') {
    if (col.distinct <= 20) return { kind: 'facet', values: col.topValues ?? [] };
    if (typeof col.min === 'number' && typeof col.max === 'number') {
      return { kind: 'range', min: col.min, max: col.max };
    }
    // Numeric without baked min/max: fall through to string-style handling.
  }

  if (col.distinct <= 50) return { kind: 'facet', values: col.topValues ?? [] };
  if (col.distinct <= 2000) {
    return {
      kind: 'searchable',
      sampleValues: (col.topValues ?? []).slice(0, 10).map((v) => v.v),
    };
  }
  return { kind: 'search' };
}

const KIND_PRIORITY: Record<Affordance['kind'], number> = {
  facet: 5,
  boolean: 4,
  range: 3,
  searchable: 2,
  search: 1,
  drop: 0,
};

export function rankColumns(cols: ColumnStats[], rowCount: number): ColumnStats[] {
  return cols
    .map((c) => ({ c, aff: pickAffordance(c, rowCount) }))
    .filter((x) => x.aff.kind !== 'drop')
    .map((x) => ({
      c: x.c,
      score: KIND_PRIORITY[x.aff.kind] * 10 + (1 - x.c.nullFrac),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, DISPLAY_CAP)
    .map((x) => x.c);
}
