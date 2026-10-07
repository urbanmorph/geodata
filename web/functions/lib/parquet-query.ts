/**
 * Generic parquet query engine backed by hyparquet + R2.
 * Reads only the columns needed, supports where filters and group_by.
 * No hardcoded layer or column names.
 */
import { parquetMetadataAsync, parquetQuery, parquetSchema } from 'hyparquet';
import type { FileMetaData, SchemaElement } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import type { AsyncBuffer } from './parquet-r2';

export interface ColumnSchema {
  name: string;
  type: string;
  distinct_values?: unknown[];
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  truncated: boolean;
  hints?: Record<string, unknown[]>;
}

export interface GroupByResult {
  column: string;
  counts: Record<string, number>;
  total: number;
  /** Per-group totals of the requested `sum` columns; absent when none asked. */
  sums?: Record<string, Record<string, number>>;
  hints?: Record<string, unknown[]>;
}

/** A caller mistake (bad column, wrong type, missing group_by): maps to HTTP 400. */
export class QueryInputError extends Error {}

const MAX_ROWS = 1000;
const MAX_GROUP_BY_VALUES = 500;
const MAX_DISTINCT_SAMPLE = 20;

const JUNK_COLUMNS = new Set([
  'shape_leng', 'shape_area', 'shape_length', 'shape.starea()', 'shape.stlength()',
  'shape_le_1', 'st_area(shape)', 'st_perimeter(shape)',
  'inpoly_fid', 'simpgnflag', 'maxsimptol', 'minsimptol',
  'ogc_fid', 'objectid', 'objectid_1', 'objectid_2', 'objectid_3',
]);

function isJunkColumn(name: string): boolean {
  return JUNK_COLUMNS.has(name.toLowerCase());
}

/**
 * Top-level columns. The flat `metadata.schema` also lists struct/list/map
 * children (`primary`, `list`, `element`, `key_value`...), which are not
 * columns: Overture places has 19 columns but 97 flat schema entries.
 */
export function topLevelColumns(metadata: FileMetaData): { name: string; element: SchemaElement; nested: boolean }[] {
  return parquetSchema(metadata).children.map((c) => ({
    name: c.element.name, element: c.element, nested: c.children.length > 0,
  }));
}

/** Nested columns can't be compared to a value or used as a group key. */
function assertFlat(cols: ReturnType<typeof topLevelColumns>, names: string[]): void {
  const nested = new Set(cols.filter((c) => c.nested).map((c) => c.name));
  const flat = cols.filter((c) => !c.nested && !c.name.toLowerCase().includes('geom')).map((c) => c.name);
  for (const n of names) {
    if (nested.has(n)) {
      throw new QueryInputError(`Column "${n}" is nested (struct, list or map) and can't be filtered or grouped. Flat columns: ${flat.join(', ')}`);
    }
  }
}

// FIX #5: sample from distinct values, not first N rows
export async function getSchema(file: AsyncBuffer): Promise<{
  row_count: number;
  columns: ColumnSchema[];
}> {
  const metadata = await parquetMetadataAsync(file);
  const rowCount = metadata.row_groups.reduce((s, rg) => s + Number(rg.num_rows), 0);

  const columns: ColumnSchema[] = [];
  for (const { name, element: el, nested } of topLevelColumns(metadata)) {
    if (!name || name.toLowerCase().includes('geom') || name === 'wkb_geometry') continue;
    columns.push({ name, type: nested ? 'nested' : schemaType(el.type, el.converted_type) });
  }

  // Read a sample of rows spread across the dataset for distinct value discovery
  // (flat columns only: nested values would stringify as "[object Object]").
  const flatCols = columns.filter((c) => c.type !== 'nested');
  if (rowCount > 0 && flatCols.length > 0) {
    const colNames = flatCols.map((c) => c.name);
    const sampleSize = Math.min(200, rowCount);
    const sampleRows = await parquetQuery({
      compressors, file, columns: colNames, rowEnd: sampleSize,
    });

    for (const col of flatCols) {
      const distinct = new Set<string>();
      for (const r of sampleRows as Record<string, unknown>[]) {
        const v = r[col.name];
        if (v !== null && v !== undefined) distinct.add(String(v));
        if (distinct.size >= MAX_DISTINCT_SAMPLE) break;
      }
      if (distinct.size > 0 && distinct.size <= MAX_DISTINCT_SAMPLE) {
        col.distinct_values = [...distinct].sort();
      }
    }
  }

  return { row_count: rowCount, columns };
}

export async function query(
  file: AsyncBuffer,
  opts: {
    select?: string[];
    where?: Record<string, string>;
    groupBy?: string;
    /** Numeric columns to total per group (requires groupBy). */
    sum?: string[];
    limit?: number;
    includeCentroid?: boolean;
  },
): Promise<QueryResult | GroupByResult> {
  const metadata = await parquetMetadataAsync(file);
  const cols = topLevelColumns(metadata);
  const allCols = cols.map((c) => c.name);
  assertFlat(cols, [...Object.keys(opts.where ?? {}), ...(opts.groupBy ? [opts.groupBy] : [])]);

  const sumCols = opts.sum?.length ? opts.sum : [];
  if (sumCols.length && !opts.groupBy) {
    throw new QueryInputError('sum requires group_by (it totals numeric columns per group)');
  }

  if (opts.groupBy) {
    if (sumCols.length) {
      validateSumColumns(sumCols, Object.fromEntries(cols.map((c) => [c.name, c.nested ? undefined : c.element.type])));
    }
    return groupByQuery(file, allCols, opts.groupBy, opts.where, sumCols);
  }

  return selectQuery(file, allCols, opts);
}

// Parquet physical types we can total. INT96 is a legacy timestamp and BYTE_ARRAY
// / FIXED_LEN_BYTE_ARRAY are strings or decimals, so neither is summed.
const NUMERIC_TYPES = new Set(['INT32', 'INT64', 'FLOAT', 'DOUBLE']);

/** Throws QueryInputError unless every sum column exists and is numeric. */
export function validateSumColumns(
  sumCols: string[],
  types: Record<string, string | undefined>,
): void {
  const numeric = Object.keys(types).filter((c) => NUMERIC_TYPES.has(types[c] ?? '') && !isJunkColumn(c));
  for (const c of sumCols) {
    if (!(c in types)) {
      throw new QueryInputError(`Sum column "${c}" not found. Numeric columns: ${numeric.join(', ')}`);
    }
    if (!NUMERIC_TYPES.has(types[c] ?? '')) {
      throw new QueryInputError(`Sum column "${c}" is not numeric. Numeric columns: ${numeric.join(', ')}`);
    }
  }
}

/**
 * Group rows by `groupCol`: a row count per group (largest first, capped at
 * MAX_GROUP_BY_VALUES), plus per-group totals of `sumCols` when asked. INT64
 * values arrive from hyparquet as BigInt, so they are converted; null/undefined
 * are skipped; float noise is rounded to 6 decimals.
 */
export function aggregateGroups(
  rows: Record<string, unknown>[],
  groupCol: string,
  sumCols: string[] = [],
): { counts: Record<string, number>; total: number; sums?: Record<string, Record<string, number>> } {
  const counts: Record<string, number> = {};
  const sums: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const key = String(row[groupCol] ?? '(null)');
    counts[key] = (counts[key] || 0) + 1;
    if (!sumCols.length) continue;
    if (!sums[key]) sums[key] = Object.fromEntries(sumCols.map((c) => [c, 0]));
    for (const c of sumCols) {
      const v = row[c];
      if (v === null || v === undefined) continue;
      const n = Number(v);
      if (Number.isFinite(n)) sums[key][c] += n;
    }
  }

  const kept = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_GROUP_BY_VALUES);
  const result: { counts: Record<string, number>; total: number; sums?: Record<string, Record<string, number>> } = {
    counts: Object.fromEntries(kept),
    total: rows.length,
  };
  if (sumCols.length) {
    const round = (x: number) => Math.round(x * 1e6) / 1e6;
    result.sums = Object.fromEntries(kept.map(([k]) => [
      k,
      Object.fromEntries(sumCols.map((c) => [c, round(sums[k][c])])),
    ]));
  }
  return result;
}

// FIX #3: centroid support via bbox columns
const BBOX_COLS = ['xmin', 'ymin', 'xmax', 'ymax'];

async function selectQuery(
  file: AsyncBuffer,
  allCols: string[],
  opts: { select?: string[]; where?: Record<string, string>; limit?: number; includeCentroid?: boolean },
): Promise<QueryResult> {
  const selectCols = opts.select?.length
    ? opts.select.filter((c) => allCols.includes(c))
    : allCols.filter((c) => !c.toLowerCase().includes('geom') && c !== 'wkb_geometry' && !isJunkColumn(c));

  if (selectCols.length === 0) {
    return { columns: [], rows: [], total: 0, truncated: false };
  }

  const readCols = new Set(selectCols);
  if (opts.where) Object.keys(opts.where).forEach((c) => { if (allCols.includes(c)) readCols.add(c); });
  // FIX #3: include bbox columns if centroid requested and they exist
  if (opts.includeCentroid) {
    for (const bc of BBOX_COLS) if (allCols.includes(bc)) readCols.add(bc);
  }

  const limit = Math.min(opts.limit ?? 100, MAX_ROWS);
  const allRows = await parquetQuery({ compressors, file, columns: [...readCols] });

  let filtered = allRows as Record<string, unknown>[];
  if (opts.where && Object.keys(opts.where).length > 0) {
    filtered = filtered.filter((row) =>
      Object.entries(opts.where!).every(([col, val]) => {
        const rv = row[col];
        if (rv === null || rv === undefined) return false;
        return String(rv).toLowerCase() === val.toLowerCase();
      }),
    );
  }

  const total = filtered.length;
  const truncated = total > limit;

  const rows = filtered.slice(0, limit).map((row) => {
    const out: Record<string, unknown> = {};
    for (const c of selectCols) out[c] = row[c];
    // FIX #3: compute centroid from bbox if available
    if (opts.includeCentroid && row.xmin != null && row.ymin != null) {
      out._lat = (Number(row.ymin) + Number(row.ymax ?? row.ymin)) / 2;
      out._lng = (Number(row.xmin) + Number(row.xmax ?? row.xmin)) / 2;
    }
    return out;
  });

  // FIX #2: on zero results, provide hints (distinct values for filtered columns)
  let hints: Record<string, unknown[]> | undefined;
  if (total === 0 && opts.where && Object.keys(opts.where).length > 0) {
    hints = {};
    for (const [col] of Object.entries(opts.where)) {
      if (!allCols.includes(col)) {
        hints[col] = [`Column "${col}" not found. Available: ${allCols.filter((c) => !c.toLowerCase().includes('geom')).join(', ')}`];
        continue;
      }
      const distinct = new Set<string>();
      for (const row of allRows as Record<string, unknown>[]) {
        const v = row[col];
        if (v !== null && v !== undefined) distinct.add(String(v));
        if (distinct.size >= 15) break;
      }
      hints[col] = [...distinct].sort();
    }
  }

  return { columns: selectCols, rows, total, truncated, hints };
}

async function groupByQuery(
  file: AsyncBuffer,
  allCols: string[],
  groupCol: string,
  where?: Record<string, string>,
  sumCols: string[] = [],
): Promise<GroupByResult> {
  if (!allCols.includes(groupCol)) {
    const available = allCols.filter((c) => !c.toLowerCase().includes('geom') && c !== 'wkb_geometry' && !isJunkColumn(c));
    throw new QueryInputError(`Column "${groupCol}" not found. Available: ${available.join(', ')}`);
  }

  const readCols = new Set([groupCol, ...sumCols]);
  if (where) Object.keys(where).forEach((c) => readCols.add(c));
  const colList = [...readCols].filter((c) => allCols.includes(c));

  const allRows = await parquetQuery({ compressors, file, columns: colList });

  let filtered = allRows as Record<string, unknown>[];
  if (where && Object.keys(where).length > 0) {
    filtered = filtered.filter((row) =>
      Object.entries(where).every(([col, val]) => {
        const rv = row[col];
        if (rv === null || rv === undefined) return false;
        return String(rv).toLowerCase() === val.toLowerCase();
      }),
    );
  }

  const agg = aggregateGroups(filtered, groupCol, sumCols);

  // FIX #2: hints on zero results
  let hints: Record<string, unknown[]> | undefined;
  if (filtered.length === 0 && where && Object.keys(where).length > 0) {
    hints = {};
    for (const [col] of Object.entries(where)) {
      const distinct = new Set<string>();
      for (const row of allRows as Record<string, unknown>[]) {
        const v = row[col];
        if (v !== null && v !== undefined) distinct.add(String(v));
        if (distinct.size >= 15) break;
      }
      hints[col] = [...distinct].sort();
    }
  }

  return {
    column: groupCol,
    counts: agg.counts,
    total: agg.total,
    ...(agg.sums ? { sums: agg.sums } : {}),
    hints,
  };
}

function schemaType(type?: string | number, convertedType?: string | number): string {
  const t = String(type ?? '').toUpperCase();
  if (t.includes('INT') || t.includes('FLOAT') || t.includes('DOUBLE')) return 'number';
  if (t.includes('BYTE_ARRAY') || t.includes('FIXED')) {
    const ct = String(convertedType ?? '').toUpperCase();
    if (ct.includes('UTF8') || ct.includes('STRING')) return 'string';
    return 'binary';
  }
  if (t.includes('BOOLEAN')) return 'boolean';
  return 'string';
}
