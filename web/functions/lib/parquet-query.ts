/**
 * Generic parquet query engine backed by hyparquet + R2.
 * Reads only the columns needed, supports where filters and group_by.
 * No hardcoded layer or column names.
 */
import { parquetReadObjects, parquetSchema } from 'hyparquet';
import type { FileMetaData, SchemaElement } from 'hyparquet';
import { compressors } from './zstd';
import { cachedMetadata, type AsyncBuffer } from './parquet-r2';
import { mapConcurrent, R2_CONCURRENCY } from './concurrency';
import { QUERY_JUNK_COLUMNS } from './junk-columns';
import { apiError, serverError } from './http';

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

/** The catch for a read route: a QueryInputError is the caller's 400, anything
 *  else the generic 500 for `what` (its detail goes to the log only). */
export const queryFailure = (what: string) => (e: unknown): Response =>
  e instanceof QueryInputError ? apiError(400, e.message) : serverError(what, e);

/** The Filter panel's filters (web/src/filter-where.ts ActiveFilter), sent as
 *  `filter=` JSON for layers too large to filter in the browser. */
export type FilterSpec =
  | { col: string; kind: 'in'; values: Array<string | number> }
  | { col: string; kind: 'range'; min?: number; max?: number }
  | { col: string; kind: 'search'; q: string }
  | { col: string; kind: 'bool'; v: boolean };

type RowMatch = (row: Record<string, unknown>) => boolean;

/** One predicate for `where` (case-insensitive equality) and `filters`:
 *  `in` is case-insensitive membership, `range` numeric bounds, `search` a
 *  case-insensitive substring, `bool` exact. Nulls never match. */
export function rowMatcher(where: Array<[string, string]>, filters: FilterSpec[] = []): RowMatch {
  const tests: RowMatch[] = where.map(([col, val]) => (row) => {
    const rv = row[col];
    return rv !== null && rv !== undefined && String(rv).toLowerCase() === val;
  });
  for (const f of filters) {
    const get = (row: Record<string, unknown>) => row[f.col];
    if (f.kind === 'in') {
      const set = new Set(f.values.map((v) => String(v).toLowerCase()));
      tests.push((row) => { const v = get(row); return v != null && set.has(String(v).toLowerCase()); });
    } else if (f.kind === 'range') {
      tests.push((row) => {
        const v = get(row);
        if (v == null) return false;
        const n = Number(v);
        return Number.isFinite(n) && (f.min == null || n >= f.min) && (f.max == null || n <= f.max);
      });
    } else if (f.kind === 'search') {
      const q = f.q.toLowerCase();
      tests.push((row) => { const v = get(row); return v != null && String(v).toLowerCase().includes(q); });
    } else {
      tests.push((row) => { const v = get(row); return v != null && Boolean(v) === f.v; });
    }
  }
  return (row) => tests.every((t) => t(row));
}

const MAX_ROWS = 1000;
const MAX_GROUP_BY_VALUES = 500;
const MAX_DISTINCT_SAMPLE = 20;
/** Most distinct group keys one group_by holds while counting. Every key is an
 *  object entry (plus a sums record), so grouping 4.8M Overture names by name
 *  would hold millions of them in a 128 MB Worker before the top 500 are cut. */
export const MAX_GROUP_KEYS = 50_000;

/** Most consecutive row numbers one read covers. A row group's matches were
 *  read in one go (up to 20,000 rows with every column and the shapes) and a
 *  41,448-row export ran a local Worker out of heap; production has 128 MB. */
export const READ_WINDOW_ROWS = 1000;

/** Sorted row numbers -> runs whose first and last are within `span` rows. */
export function readWindows(idxs: number[], span: number): number[][] {
  const out: number[][] = [];
  for (const i of idxs) {
    const cur = out[out.length - 1];
    if (cur && i - cur[0] < span) cur.push(i);
    else out.push([i]);
  }
  return out;
}


function isJunkColumn(name: string): boolean {
  return QUERY_JUNK_COLUMNS.has(name.toLowerCase());
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

/** Geometry columns hold the shapes, never a filter value. By name, exactly:
 *  "anything containing geom" also caught source columns such as GEOM_UNIT and
 *  geom_landf (groundwater prospects), hiding them from results and filters. */
const GEOM_NAMES = new Set(['geometry', 'geom', 'wkb_geometry', 'the_geom']);
export function isGeomColumn(name: string): boolean {
  return GEOM_NAMES.has(name.toLowerCase());
}

/**
 * Nested and geometry columns can't be compared to a value or used as a group
 * key. Checking `?geometry=true` as a filter read every polygon of lgd_blocks
 * and the Worker hit its resource limit (503), so it is refused before any read.
 */
function assertFlat(cols: ReturnType<typeof topLevelColumns>, names: string[]): void {
  const nested = new Set(cols.filter((c) => c.nested).map((c) => c.name));
  const flat = cols.filter((c) => !c.nested && !isGeomColumn(c.name)).map((c) => c.name);
  for (const n of names) {
    if (nested.has(n)) {
      throw new QueryInputError(`Column "${n}" is nested (struct, list or map) and can't be filtered or grouped. Flat columns: ${flat.join(', ')}`);
    }
    if (isGeomColumn(n) && cols.some((c) => c.name === n)) {
      throw new QueryInputError(`Column "${n}" is the geometry and can't be filtered or grouped. For a point per row use include_centroid=true; for shapes use the layer's downloads. Flat columns: ${flat.join(', ')}`);
    }
  }
}

/** Every filter column exists and is flat (not the geometry, not nested). */
export function assertFilterColumns(cols: ReturnType<typeof topLevelColumns>, names: string[]): void {
  if (!names.length) return;
  assertFlat(cols, names);
  const known = new Set(cols.map((c) => c.name));
  const missing = names.filter((n) => !known.has(n));
  if (missing.length) {
    const flat = cols.filter((c) => !c.nested && !isGeomColumn(c.name)).map((c) => c.name);
    throw new QueryInputError(`Filter column(s) ${missing.map((m) => `"${m}"`).join(', ')} not found. Flat columns: ${flat.join(', ')}`);
  }
}

/** Rows sampled per row group, and how many row groups (spread through the
 *  file) are sampled, for each column's distinct values. Files are often
 *  sorted by state or region, so the first rows alone show one state's values. */
const SAMPLE_ROWS_PER_GROUP = 50;
const SAMPLE_GROUPS = 4;

/** Up to SAMPLE_GROUPS row groups spread through the file (first, last and
 *  between), SAMPLE_ROWS_PER_GROUP rows from the start of each. */
export function sampleSpans(metadata: FileMetaData): Array<{ start: number; end: number }> {
  const spans = rowGroupSpans(metadata).filter((s) => s.end > s.start);
  const n = Math.min(SAMPLE_GROUPS, spans.length);
  const picks = new Set(Array.from({ length: n }, (_, i) => (n === 1 ? 0 : Math.round((i * (spans.length - 1)) / (n - 1)))));
  return [...picks].map((i) => ({ start: spans[i].start, end: Math.min(spans[i].end, spans[i].start + SAMPLE_ROWS_PER_GROUP) }));
}

export async function getSchema(file: AsyncBuffer): Promise<{
  row_count: number;
  columns: ColumnSchema[];
}> {
  const metadata = await cachedMetadata(file);
  const rowCount = metadata.row_groups.reduce((s, rg) => s + Number(rg.num_rows), 0);

  const columns: ColumnSchema[] = [];
  for (const { name, element: el, nested } of topLevelColumns(metadata)) {
    if (!name || isGeomColumn(name)) continue;
    columns.push({ name, type: nested ? 'nested' : schemaType(el.type, el.converted_type) });
  }

  // Distinct-value samples from a few row groups spread through the file
  // (flat columns only: nested values would stringify as "[object Object]").
  const flatCols = columns.filter((c) => c.type !== 'nested');
  if (rowCount > 0 && flatCols.length > 0) {
    const colNames = flatCols.map((c) => c.name);
    const sampleRows = (await mapConcurrent(sampleSpans(metadata), R2_CONCURRENCY, (span) => parquetReadObjects({
      file, metadata, compressors, columns: colNames, rowStart: span.start, rowEnd: span.end,
    }) as Promise<Record<string, unknown>[]>)).flat();

    for (const col of flatCols) {
      const distinct = new Set<string>();
      for (const r of sampleRows) {
        const v = r[col.name];
        if (v !== null && v !== undefined) distinct.add(String(v));
        if (distinct.size > MAX_DISTINCT_SAMPLE) break;
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
    filters?: FilterSpec[];
    /** Distinct-group cap (default MAX_GROUP_KEYS); tests lower it. */
    maxGroupKeys?: number;
  },
): Promise<QueryResult | GroupByResult> {
  const metadata = await cachedMetadata(file);
  const cols = topLevelColumns(metadata);
  const allCols = cols.map((c) => c.name);
  // Every check before any row is read: an unknown where column used to scan
  // the whole file and answer 200 with nothing.
  if (opts.groupBy) assertFlat(cols, [opts.groupBy]);
  assertFilterColumns(cols, [...Object.keys(opts.where ?? {}), ...(opts.filters ?? []).map((f) => f.col)]);
  // A shape per row (decoded to GeoJSON) for up to 1,000 rows of state or
  // block polygons is a one-request Worker kill: shapes come from downloads.
  const geomSelected = (opts.select ?? []).filter((c) => isGeomColumn(c) && allCols.includes(c));
  if (geomSelected.length) {
    throw new QueryInputError(`Column "${geomSelected[0]}" is the geometry and can't be selected. For a point per row use include_centroid=true; for shapes use the layer's downloads or /export.`);
  }
  // An unknown select column used to be dropped silently (all unknown: total 0).
  const unknownSelect = (opts.select ?? []).filter((c) => !allCols.includes(c));
  if (unknownSelect.length) {
    const selectable = allCols.filter((c) => !isGeomColumn(c));
    throw new QueryInputError(`Select column(s) ${unknownSelect.map((c) => `"${c}"`).join(', ')} not found. Columns: ${selectable.join(', ')}`);
  }

  const sumCols = opts.sum?.length ? opts.sum : [];
  if (sumCols.length && !opts.groupBy) {
    throw new QueryInputError('sum requires group_by (it totals numeric columns per group)');
  }

  if (opts.groupBy) {
    if (sumCols.length) {
      validateSumColumns(sumCols, Object.fromEntries(cols.map((c) => [c.name, c.nested ? undefined : c.element.type])));
    }
    return groupByQuery(file, metadata, allCols, opts.groupBy, opts.where, sumCols, opts.filters, opts.maxGroupKeys);
  }

  return selectQuery(file, metadata, allCols, opts);
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
 * Incremental group-by: add() batches of (already filtered) rows, then
 * result(): a row count per group (largest first, capped at
 * MAX_GROUP_BY_VALUES), plus per-group totals of `sumCols` when asked. INT64
 * values arrive from hyparquet as BigInt, so they are converted; null/undefined
 * are skipped; float noise is rounded to 6 decimals. More than `maxKeys`
 * distinct groups is a QueryInputError (see MAX_GROUP_KEYS).
 */
export function groupAccumulator(groupCol: string, sumCols: string[] = [], maxKeys = MAX_GROUP_KEYS) {
  // No prototype: a group named "constructor" or "__proto__" is just a key.
  const counts: Record<string, number> = Object.create(null);
  const sums: Record<string, Record<string, number>> = Object.create(null);
  let total = 0;
  let keys = 0;
  return {
    add(rows: Record<string, unknown>[]): void {
      total += rows.length;
      for (const row of rows) {
        const key = String(row[groupCol] ?? '(null)');
        if (counts[key] === undefined && ++keys > maxKeys) {
          throw new QueryInputError(
            `Column "${groupCol}" has more than ${maxKeys.toLocaleString('en-IN')} distinct values: too many to group. `
            + 'Group by a coarser column, or narrow the rows with a where filter first.',
          );
        }
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
    },
    result(): { counts: Record<string, number>; total: number; sums?: Record<string, Record<string, number>> } {
      const kept = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_GROUP_BY_VALUES);
      const out: { counts: Record<string, number>; total: number; sums?: Record<string, Record<string, number>> } = {
        counts: Object.fromEntries(kept),
        total,
      };
      if (sumCols.length) {
        const round = (x: number) => Math.round(x * 1e6) / 1e6;
        out.sums = Object.fromEntries(kept.map(([k]) => [
          k,
          Object.fromEntries(sumCols.map((c) => [c, round(sums[k][c])])),
        ]));
      }
      return out;
    },
  };
}

/** Flat bounding-box columns baked into every curated parquet (for nearby and
 *  centroids): read when needed, never part of a default select. */
export const BBOX_COLS: readonly string[] = ['xmin', 'ymin', 'xmax', 'ymax'];

/** Row range of each row group. */
function rowGroupSpans(metadata: FileMetaData): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const rg of metadata.row_groups) {
    const end = start + Number(rg.num_rows);
    spans.push({ start, end });
    start = end;
  }
  return spans;
}

/** where entries with the values lowercased once, for rowMatcher. */
function lowerWhere(where: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(where ?? {}).map(([c, v]) => [c, v.toLowerCase()]);
}

function distinctSample(rows: Record<string, unknown>[], col: string): string[] {
  const distinct = new Set<string>();
  for (const row of rows) {
    const v = row[col];
    if (v !== null && v !== undefined) distinct.add(String(v));
    if (distinct.size >= 15) break;
  }
  return [...distinct].sort();
}

/** Pass 1 of a filtered read: only the match columns, row groups in parallel
 *  (bounded); per group, the match count and the first `keep` matching row
 *  numbers (in row order). The first group also keeps a distinct-value sample
 *  of each match column, for zero-result hints. */
export async function scanMatches(
  file: AsyncBuffer,
  metadata: FileMetaData,
  cols: string[],
  match: (row: Record<string, unknown>) => boolean,
  keep: number,
): Promise<{ perGroup: Array<{ idxs: number[]; count: number; last: number; sample?: Record<string, string[]> }>; total: number }> {
  const perGroup = await mapConcurrent(rowGroupSpans(metadata), R2_CONCURRENCY, async (span) => {
    const rows = await parquetReadObjects({
      file, metadata, compressors, columns: cols, rowStart: span.start, rowEnd: span.end,
    }) as Record<string, unknown>[];
    const idxs: number[] = [];
    let count = 0;
    let last = -1;
    rows.forEach((row, i) => {
      if (!match(row)) return;
      count++;
      last = span.start + i;
      if (idxs.length < keep) idxs.push(last);
    });
    const sample = span.start === 0 ? Object.fromEntries(cols.map((c) => [c, distinctSample(rows, c)])) : undefined;
    return { idxs, count, last, sample };
  });
  return { perGroup, total: perGroup.reduce((n, g) => n + g.count, 0) };
}

/**
 * Rows are read row group by row group (bounded parallel), never the whole
 * table at once: pass 1 reads only the where columns and keeps the first
 * `limit` matching row numbers (counting all matches); pass 2 reads the
 * selected columns only for those rows. Without a where, only the first
 * `limit` rows are read.
 */
async function selectQuery(
  file: AsyncBuffer,
  metadata: FileMetaData,
  allCols: string[],
  opts: {
    select?: string[]; where?: Record<string, string>; limit?: number; includeCentroid?: boolean;
    filters?: FilterSpec[];
  },
): Promise<QueryResult> {
  // query() has checked every select column exists. The default leaves out the
  // bounding box (`_lat`/`_lng` carry it as a point); a select can still ask.
  const selectCols = opts.select?.length
    ? opts.select
    : allCols.filter((c) => !isGeomColumn(c) && !isJunkColumn(c) && !BBOX_COLS.includes(c));

  const readCols = new Set(selectCols);
  if (opts.includeCentroid) {
    for (const bc of BBOX_COLS) if (allCols.includes(bc)) readCols.add(bc);
  }
  const limit = Math.min(opts.limit ?? 100, MAX_ROWS);
  const shape = (row: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const c of selectCols) out[c] = row[c];
    if (opts.includeCentroid && row.xmin != null && row.ymin != null) {
      out._lat = (Number(row.ymin) + Number(row.ymax ?? row.ymin)) / 2;
      out._lng = (Number(row.xmin) + Number(row.xmax ?? row.xmin)) / 2;
    }
    return out;
  };

  const where = lowerWhere(opts.where);
  const filters = opts.filters ?? [];
  if (where.length === 0 && filters.length === 0) {
    const total = Number(metadata.num_rows);
    const rows = await parquetReadObjects({
      file, metadata, compressors, columns: [...readCols], rowStart: 0, rowEnd: Math.min(limit, total),
    }) as Record<string, unknown>[];
    return { columns: selectCols, rows: rows.map(shape), total, truncated: total > limit };
  }

  // Pass 1: where and filter columns only; each group is reduced to its match
  // count and first `limit` row numbers as soon as it arrives.
  const matchCols = [...new Set([...where.map(([c]) => c), ...filters.map((f) => f.col)])];
  const { perGroup, total } = await scanMatches(file, metadata, matchCols, rowMatcher(where, filters), limit);
  const hitGroups: number[][] = []; // row numbers to return, per row group, in order
  let kept = 0;
  for (const g of perGroup) {
    if (kept >= limit) break;
    const idxs = g.idxs.slice(0, limit - kept);
    if (idxs.length) hitGroups.push(idxs);
    kept += idxs.length;
  }

  // Pass 2: selected columns only for the kept rows, in row order, in windows
  // of at most READ_WINDOW_ROWS rows: sparse matches across a row group must
  // not decode every row between the first and the last.
  const windows = hitGroups.flatMap((idxs) => readWindows(idxs, READ_WINDOW_ROWS));
  const shaped = await mapConcurrent(windows, R2_CONCURRENCY, async (idxs) => {
    const lo = idxs[0];
    const rows = await parquetReadObjects({
      file, metadata, compressors, columns: [...readCols], rowStart: lo, rowEnd: idxs[idxs.length - 1] + 1,
    }) as Record<string, unknown>[];
    return idxs.map((i) => shape(rows[i - lo]));
  });
  const out = shaped.flat();

  const hints = total === 0 ? perGroup[0]?.sample : undefined;
  return { columns: selectCols, rows: out, total, truncated: total > limit, hints };
}

/** group_by: row groups read in parallel (bounded) into one accumulator. */
async function groupByQuery(
  file: AsyncBuffer,
  metadata: FileMetaData,
  allCols: string[],
  groupCol: string,
  whereObj?: Record<string, string>,
  sumCols: string[] = [],
  filters: FilterSpec[] = [],
  maxKeys = MAX_GROUP_KEYS,
): Promise<GroupByResult> {
  if (!allCols.includes(groupCol)) {
    const available = allCols.filter((c) => !isGeomColumn(c) && !isJunkColumn(c));
    throw new QueryInputError(`Column "${groupCol}" not found. Available: ${available.join(', ')}`);
  }

  const where = lowerWhere(whereObj);
  const readCols = new Set([groupCol, ...sumCols, ...where.map(([c]) => c), ...filters.map((f) => f.col)]);
  const filtered = where.length > 0 || filters.length > 0;
  const match = rowMatcher(where, filters);
  const colList = [...readCols]; // query() has checked each exists
  const acc = groupAccumulator(groupCol, sumCols, maxKeys);
  let sample: Record<string, string[]> | undefined;
  await mapConcurrent(rowGroupSpans(metadata), R2_CONCURRENCY, async (span) => {
    const rows = await parquetReadObjects({
      file, metadata, compressors, columns: colList, rowStart: span.start, rowEnd: span.end,
    }) as Record<string, unknown>[];
    if (span.start === 0) sample = Object.fromEntries(where.map(([c]) => [c, distinctSample(rows, c)]));
    acc.add(filtered ? rows.filter(match) : rows);
  });
  const agg = acc.result();

  // FIX #2: hints on zero results
  const hints = agg.total === 0 && where.length ? sample : undefined;

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
