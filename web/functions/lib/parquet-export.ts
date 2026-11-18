/**
 * Filtered export for /api/v1/layers/{id}/export: the rows matching a filter,
 * streamed as GeoJSON, KML or CSV. The Filter panel uses it for layers too
 * large to filter in the browser (shared/large-load.mjs LARGE_FILTER_BYTES).
 *
 * Pass 1 reads only the filter columns and counts every match; above the cap
 * nothing more is read and the caller gets a 400 with guidance. Pass 2 reads
 * the matching rows' columns one row group at a time, so memory stays at one
 * group whatever the export size. hyparquet decodes GeoParquet geometry to
 * GeoJSON itself.
 */
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { cachedMetadata, type AsyncBuffer } from './parquet-r2';
import {
  QueryInputError,
  assertFilterColumns,
  isGeomColumn,
  rowMatcher,
  scanMatches,
  topLevelColumns,
  type FilterSpec,
} from './parquet-query';
import { kmlHead, kmlPlacemark, KML_TAIL } from '../../../shared/kml.mjs';
import { FILTER_EXPORT_MAX_ROWS } from '../../../shared/large-load.mjs';

export const EXPORT_MAX_ROWS = FILTER_EXPORT_MAX_ROWS;
export const EXPORT_FORMATS = ['geojson', 'kml', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const MAX_FILTERS = 20;
const MAX_IN_VALUES = 500;
const BBOX_COLS = new Set(['bbox', 'xmin', 'ymin', 'xmax', 'ymax']);

/** `filter=` JSON -> FilterSpec[]; undefined when absent. Malformed input is a
 *  QueryInputError (HTTP 400) that says what a filter looks like. */
export function parseFilterParam(raw: string | null): FilterSpec[] | undefined {
  if (raw == null || raw === '') return undefined;
  const shape = 'filter is a JSON list of {col, kind: "in", values: [...]}, {col, kind: "range", min, max}, '
    + '{col, kind: "search", q} or {col, kind: "bool", v}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new QueryInputError(`filter is not valid JSON. ${shape}`);
  }
  if (!Array.isArray(parsed)) throw new QueryInputError(shape);
  if (parsed.length > MAX_FILTERS) throw new QueryInputError(`At most ${MAX_FILTERS} filters. ${shape}`);
  return parsed.map((f): FilterSpec => {
    const o = (f ?? {}) as Record<string, unknown>;
    if (typeof o.col !== 'string' || !o.col) throw new QueryInputError(`Each filter needs a column (col). ${shape}`);
    const num = (v: unknown) => (v == null ? undefined : Number.isFinite(Number(v)) ? Number(v) : NaN);
    switch (o.kind) {
      case 'in':
        if (!Array.isArray(o.values) || !o.values.length || o.values.length > MAX_IN_VALUES
          || !o.values.every((v) => typeof v === 'string' || typeof v === 'number')) {
          throw new QueryInputError(`"in" needs 1 to ${MAX_IN_VALUES} string or number values. ${shape}`);
        }
        return { col: o.col, kind: 'in', values: o.values as Array<string | number> };
      case 'range': {
        const min = num(o.min);
        const max = num(o.max);
        if (Number.isNaN(min) || Number.isNaN(max) || (min == null && max == null)) {
          throw new QueryInputError(`"range" needs a numeric min and/or max. ${shape}`);
        }
        return { col: o.col, kind: 'range', min, max };
      }
      case 'search':
        if (typeof o.q !== 'string' || !o.q.trim()) throw new QueryInputError(`"search" needs text (q). ${shape}`);
        return { col: o.col, kind: 'search', q: o.q.trim() };
      case 'bool':
        if (typeof o.v !== 'boolean') throw new QueryInputError(`"bool" needs v: true or false. ${shape}`);
        return { col: o.col, kind: 'bool', v: o.v };
      default:
        throw new QueryInputError(`Unknown filter kind ${JSON.stringify(o.kind)}. ${shape}`);
    }
  });
}

function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  return v;
}

const jsonSafe = (v: unknown) => JSON.stringify(v, (_k, x) => plain(x));

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'object' ? jsonSafe(v) : String(plain(v));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ExportResult {
  total: number;
  chunks: AsyncIterable<string>;
}

/**
 * Count the rows matching `where` and `filters`; refuse above `maxRows`
 * (QueryInputError, nothing else read); otherwise return the total and the
 * export as an async stream of text chunks, one row group's rows per chunk.
 */
export async function exportRows(
  file: AsyncBuffer,
  opts: {
    where?: Record<string, string>;
    filters?: FilterSpec[];
    format: ExportFormat;
    name?: string;
    maxRows?: number;
    /** Said in the over-the-cap message, e.g. where whole-layer downloads are. */
    tooManyHint?: string;
  },
): Promise<ExportResult> {
  const filters = opts.filters ?? [];
  const where = Object.entries(opts.where ?? {}).map(([c, v]) => [c, v.toLowerCase()] as [string, string]);
  if (!filters.length && !where.length) {
    throw new QueryInputError('An export needs a filter (filter= or where=). The whole layer is a download: see the layer\'s files.');
  }
  const metadata = await cachedMetadata(file);
  const cols = topLevelColumns(metadata);
  const matchCols = [...new Set([...where.map(([c]) => c), ...filters.map((f) => f.col)])];
  assertFilterColumns(cols, matchCols);

  const maxRows = opts.maxRows ?? EXPORT_MAX_ROWS;
  const { perGroup, total } = await scanMatches(file, metadata, matchCols, rowMatcher(where, filters), maxRows);
  if (total > maxRows) {
    throw new QueryInputError(
      `${total.toLocaleString('en-US')} rows match: more than this export's ${maxRows.toLocaleString('en-US')}. `
      + `Narrow the filter${opts.tooManyHint ? `, or ${opts.tooManyHint}` : ''}.`,
    );
  }

  const geomCol = cols.find((c) => isGeomColumn(c.name))?.name;
  const propCols = cols.map((c) => c.name).filter((n) => n !== geomCol && !BBOX_COLS.has(n));
  const hasBbox = ['xmin', 'ymin', 'xmax', 'ymax'].every((c) => cols.some((x) => x.name === c));
  const readCols = [...propCols, ...(geomCol ? [geomCol] : []), ...(hasBbox ? ['xmin', 'ymin', 'xmax', 'ymax'] : [])];
  const groups = perGroup.filter((g) => g.idxs.length);
  const format = opts.format;

  async function* rowsOf(): AsyncGenerator<Record<string, unknown>> {
    for (const g of groups) {
      const lo = g.idxs[0];
      const rows = await parquetReadObjects({
        file, metadata, compressors, columns: readCols, rowStart: lo, rowEnd: g.idxs[g.idxs.length - 1] + 1,
      }) as Record<string, unknown>[];
      for (const i of g.idxs) yield rows[i - lo];
    }
  }
  const props = (row: Record<string, unknown>) => Object.fromEntries(propCols.map((c) => [c, plain(row[c])]));

  async function* chunks(): AsyncGenerator<string> {
    if (format === 'geojson') {
      yield '{"type":"FeatureCollection","features":[';
      let first = true;
      for await (const row of rowsOf()) {
        yield (first ? '\n' : ',\n') + jsonSafe({ type: 'Feature', geometry: geomCol ? row[geomCol] ?? null : null, properties: props(row) });
        first = false;
      }
      yield '\n]}\n';
    } else if (format === 'kml') {
      yield kmlHead(opts.name ?? 'export');
      for await (const row of rowsOf()) {
        yield kmlPlacemark({ geometry: geomCol ? row[geomCol] : null, properties: props(row) });
      }
      yield KML_TAIL + '\n';
    } else {
      yield [...propCols, ...(hasBbox ? ['_lat', '_lng'] : [])].map(csvCell).join(',') + '\n';
      for await (const row of rowsOf()) {
        const cells = propCols.map((c) => csvCell(row[c]));
        if (hasBbox) {
          cells.push(String((Number(row.ymin) + Number(row.ymax)) / 2), String((Number(row.xmin) + Number(row.xmax)) / 2));
        }
        yield cells.join(',') + '\n';
      }
    }
  }

  return { total, chunks: chunks() };
}
