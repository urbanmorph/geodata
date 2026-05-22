// v4.2 commit 4: live schema probe for layers without baked filter_stats.
// Runs DuckDB-WASM DESCRIBE + a single aggregate sweep over a remote parquet
// URL. Used by the FilterPanel (commit 5) when catalog.filter_stats doesn't
// cover the layer (external opencity wards, geoBoundaries, future community
// uploads).

import { query } from './db';
import type { ColumnStats, ColumnType } from './filter-schema';

const DUCKDB_TO_NORM: Record<string, ColumnType> = {
  BOOLEAN: 'bool',
  TINYINT: 'int', SMALLINT: 'int', INTEGER: 'int', BIGINT: 'int',
  UTINYINT: 'int', USMALLINT: 'int', UINTEGER: 'int', UBIGINT: 'int',
  HUGEINT: 'int',
  FLOAT: 'float', DOUBLE: 'float', DECIMAL: 'float', REAL: 'float',
  VARCHAR: 'string', TEXT: 'string', CHAR: 'string',
  DATE: 'date', TIMESTAMP: 'date', TIME: 'date',
  TIMESTAMP_NS: 'date', TIMESTAMP_MS: 'date', TIMESTAMP_S: 'date',
  GEOMETRY: 'geometry',
  BLOB: 'blob', BIT: 'blob',
};

const FACET_THRESHOLD = 50;
const MAX_TOP_VALUES = 50;

function normaliseType(t: string): ColumnType {
  const base = t.split('(')[0].trim().toUpperCase();
  return DUCKDB_TO_NORM[base] ?? 'string';
}

function escIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

// Aggregate column aliases need to be valid SQL identifiers — strip anything
// that isn't alnum/underscore.
function safeAlias(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

function coerceMinMax(v: string, norm: ColumnType): string | number {
  if (norm === 'int') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : v;
  }
  if (norm === 'float') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

export type ProbeResult = { rowCount: number; columns: ColumnStats[] };

export async function describeParquet(url: string): Promise<ProbeResult> {
  const desc = await query<{ column_name: string; column_type: string }>(
    `DESCRIBE SELECT * FROM '${url}' LIMIT 0`,
  );

  const eligible = desc.filter((d) => {
    const norm = normaliseType(d.column_type);
    return norm !== 'geometry' && norm !== 'blob';
  });

  let rowCount = 0;
  const aggRow: Record<string, unknown> = {};

  if (eligible.length) {
    const fragments = eligible.flatMap((d) => {
      const col = escIdent(d.column_name);
      const a = safeAlias(d.column_name);
      return [
        `COUNT(DISTINCT ${col}) AS distinct_${a}`,
        `CAST(COUNT(*) FILTER (WHERE ${col} IS NULL) AS DOUBLE) / NULLIF(COUNT(*), 0) AS null_${a}`,
        `MIN(${col})::VARCHAR AS min_${a}`,
        `MAX(${col})::VARCHAR AS max_${a}`,
      ];
    });
    const [agg] = await query<Record<string, unknown>>(
      `SELECT COUNT(*) AS row_count, ${fragments.join(', ')} FROM '${url}'`,
    );
    rowCount = Number(agg.row_count) || 0;
    Object.assign(aggRow, agg);
  } else {
    const [{ row_count }] = await query<{ row_count: number | bigint }>(
      `SELECT COUNT(*) AS row_count FROM '${url}'`,
    );
    rowCount = Number(row_count) || 0;
  }

  const lowCardCols = eligible.filter((d) => {
    const a = safeAlias(d.column_name);
    const distinct = Number(aggRow[`distinct_${a}`]) || 0;
    return distinct >= 2 && distinct <= FACET_THRESHOLD;
  });

  const topValues: Record<string, Array<{ v: string | number; n: number }>> = {};
  for (const d of lowCardCols) {
    try {
      const rows = await query<{ v: unknown; n: bigint | number }>(
        `SELECT ${escIdent(d.column_name)}::VARCHAR AS v, COUNT(*) AS n
         FROM '${url}' WHERE ${escIdent(d.column_name)} IS NOT NULL
         GROUP BY 1 ORDER BY n DESC LIMIT ${MAX_TOP_VALUES}`,
      );
      topValues[d.column_name] = rows.map((r) => ({
        v: String(r.v),
        n: Number(r.n),
      }));
    } catch {
      // A single column's top_values failure isn't fatal — the facet just
      // renders without baked values; the UI handles that.
    }
  }

  const columns: ColumnStats[] = desc.map((d) => {
    const norm = normaliseType(d.column_type);
    if (norm === 'geometry' || norm === 'blob') {
      return { name: d.column_name, type: norm, distinct: -1, nullFrac: 0 };
    }
    const a = safeAlias(d.column_name);
    const out: ColumnStats = {
      name: d.column_name,
      type: norm,
      distinct: Number(aggRow[`distinct_${a}`]) || 0,
      nullFrac: Number(aggRow[`null_${a}`]) || 0,
    };
    const minV = aggRow[`min_${a}`];
    const maxV = aggRow[`max_${a}`];
    if (minV != null) out.min = coerceMinMax(String(minV), norm);
    if (maxV != null) out.max = coerceMinMax(String(maxV), norm);
    if (topValues[d.column_name]) out.topValues = topValues[d.column_name];
    return out;
  });

  return { rowCount, columns };
}
