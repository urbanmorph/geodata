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
  sample?: unknown[];
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  truncated: boolean;
}

export interface GroupByResult {
  column: string;
  counts: Record<string, number>;
  total: number;
}

const MAX_ROWS = 1000;
const MAX_GROUP_BY_VALUES = 500;
const SAMPLE_SIZE = 5;

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

  if (rowCount > 0 && columns.length > 0) {
    const colNames = columns.map((c) => c.name);
    const sampleRows = await parquetQuery({
      compressors,
      file,
      columns: colNames,
      rowEnd: Math.min(SAMPLE_SIZE, rowCount),
    });
    for (const col of columns) {
      const vals = sampleRows
        .map((r: Record<string, unknown>) => r[col.name])
        .filter((v: unknown) => v !== null && v !== undefined);
      if (vals.length > 0) col.sample = vals.slice(0, SAMPLE_SIZE);
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
  },
): Promise<QueryResult | GroupByResult> {
  const metadata = await parquetMetadataAsync(file);
  const allCols = metadata.schema.slice(1).map((e) => e.name).filter(Boolean) as string[];

  if (opts.groupBy) {
    return groupByQuery(file, allCols, opts.groupBy, opts.where);
  }

  return selectQuery(file, allCols, opts);
}

async function selectQuery(
  file: AsyncBuffer,
  allCols: string[],
  opts: { select?: string[]; where?: Record<string, string>; limit?: number },
): Promise<QueryResult> {
  const selectCols = opts.select?.length
    ? opts.select.filter((c) => allCols.includes(c))
    : allCols.filter((c) => !c.toLowerCase().includes('geom') && c !== 'wkb_geometry');

  if (selectCols.length === 0) {
    return { columns: [], rows: [], total: 0, truncated: false };
  }

  // Include where-filter columns in the read set so filtering works
  const readCols = new Set(selectCols);
  if (opts.where) Object.keys(opts.where).forEach((c) => { if (allCols.includes(c)) readCols.add(c); });

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
  // Project back to only the requested columns
  const rows = filtered.slice(0, limit).map((row) => {
    const out: Record<string, unknown> = {};
    for (const c of selectCols) out[c] = row[c];
    return out;
  });

  return { columns: selectCols, rows, total, truncated };
}

async function groupByQuery(
  file: AsyncBuffer,
  allCols: string[],
  groupCol: string,
  where?: Record<string, string>,
): Promise<GroupByResult> {
  if (!allCols.includes(groupCol)) {
    const available = allCols.filter((c) => !c.toLowerCase().includes('geom') && c !== 'wkb_geometry');
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

  return {
    column: groupCol,
    counts: Object.fromEntries(sorted),
    total: filtered.length,
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
