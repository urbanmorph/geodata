/**
 * Generic parquet query engine backed by hyparquet + R2.
 * Reads only the columns needed, supports where filters and group_by.
 * No hardcoded layer or column names.
 */
import { parquetMetadataAsync, parquetQuery } from 'hyparquet/src/index.js';
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

  // Read a few rows to get sample values
  if (rowCount > 0 && columns.length > 0) {
    const colNames = columns.map((c) => c.name);
    const sampleRows: Record<string, unknown>[] = [];
    await parquetQuery({
      file,
      columns: colNames,
      rowEnd: Math.min(SAMPLE_SIZE, rowCount),
      onComplete: (rows: Record<string, unknown>[]) => sampleRows.push(...rows),
    });
    for (const col of columns) {
      const vals = sampleRows
        .map((r) => r[col.name])
        .filter((v) => v !== null && v !== undefined);
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
    orderBy?: string;
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

  const limit = Math.min(opts.limit ?? 100, MAX_ROWS);
  const allRows: Record<string, unknown>[] = [];

  await parquetQuery({
    file,
    columns: selectCols,
    onComplete: (rows: Record<string, unknown>[]) => allRows.push(...rows),
  });

  // Apply where filters in JS (hyparquet reads all rows, we filter post-hoc)
  let filtered = allRows;
  if (opts.where && Object.keys(opts.where).length > 0) {
    filtered = allRows.filter((row) =>
      Object.entries(opts.where!).every(([col, val]) => {
        const rv = row[col];
        if (rv === null || rv === undefined) return false;
        return String(rv).toLowerCase() === val.toLowerCase();
      }),
    );
  }

  const total = filtered.length;
  const truncated = total > limit;
  const rows = filtered.slice(0, limit);

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

  // Read only the columns needed: groupBy col + any where filter cols
  const readCols = new Set([groupCol]);
  if (where) Object.keys(where).forEach((c) => readCols.add(c));
  const colList = [...readCols].filter((c) => allCols.includes(c));

  const allRows: Record<string, unknown>[] = [];
  await parquetQuery({
    file,
    columns: colList,
    onComplete: (rows: Record<string, unknown>[]) => allRows.push(...rows),
  });

  // Apply where filters
  let filtered = allRows;
  if (where && Object.keys(where).length > 0) {
    filtered = allRows.filter((row) =>
      Object.entries(where).every(([col, val]) => {
        const rv = row[col];
        if (rv === null || rv === undefined) return false;
        return String(rv).toLowerCase() === val.toLowerCase();
      }),
    );
  }

  // Group by
  const counts: Record<string, number> = {};
  for (const row of filtered) {
    const key = String(row[groupCol] ?? '(null)');
    counts[key] = (counts[key] || 0) + 1;
  }

  // Sort by count descending, cap at MAX_GROUP_BY_VALUES
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
