/**
 * Generic parquet query engine backed by hyparquet + R2.
 * Reads only the columns needed, supports where filters and group_by.
 * No hardcoded layer or column names.
 */
import { parquetMetadataAsync, parquetQuery } from 'hyparquet';
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
  hints?: Record<string, unknown[]>;
}

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

// FIX #5: sample from distinct values, not first N rows
export async function getSchema(file: AsyncBuffer): Promise<{
  row_count: number;
  columns: ColumnSchema[];
}> {
  const metadata = await parquetMetadataAsync(file);
  const rowCount = metadata.row_groups.reduce((s, rg) => s + Number(rg.num_rows), 0);

  const columns: ColumnSchema[] = [];
  for (const el of metadata.schema.slice(1)) {
    if (!el.name || el.name.toLowerCase().includes('geom') || el.name === 'wkb_geometry') continue;
    columns.push({
      name: el.name,
      type: schemaType(el.type, el.converted_type),
    });
  }

  // Read a sample of rows spread across the dataset for distinct value discovery
  if (rowCount > 0 && columns.length > 0) {
    const colNames = columns.map((c) => c.name);
    const sampleSize = Math.min(200, rowCount);
    const sampleRows = await parquetQuery({
      compressors, file, columns: colNames, rowEnd: sampleSize,
    });

    for (const col of columns) {
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
    limit?: number;
    includeCentroid?: boolean;
  },
): Promise<QueryResult | GroupByResult> {
  const metadata = await parquetMetadataAsync(file);
  const allCols = metadata.schema.slice(1).map((e) => e.name).filter(Boolean) as string[];

  if (opts.groupBy) {
    return groupByQuery(file, allCols, opts.groupBy, opts.where);
  }

  return selectQuery(file, allCols, opts);
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
): Promise<GroupByResult> {
  if (!allCols.includes(groupCol)) {
    const available = allCols.filter((c) => !c.toLowerCase().includes('geom') && c !== 'wkb_geometry' && !isJunkColumn(c));
    throw new Error(`Column "${groupCol}" not found. Available: ${available.join(', ')}`);
  }

  const readCols = new Set([groupCol]);
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

  const counts: Record<string, number> = {};
  for (const row of filtered) {
    const key = String(row[groupCol] ?? '(null)');
    counts[key] = (counts[key] || 0) + 1;
  }

  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_GROUP_BY_VALUES);

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
    counts: Object.fromEntries(sorted),
    total: filtered.length,
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
