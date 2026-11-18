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
import type { FileMetaData } from 'hyparquet';
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
import { FILTER_EXPORT_MAX_BYTES, FILTER_EXPORT_MAX_ROWS } from '../../../shared/large-load.mjs';

export const EXPORT_MAX_ROWS = FILTER_EXPORT_MAX_ROWS;
export const EXPORT_MAX_BYTES = FILTER_EXPORT_MAX_BYTES;
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

/** Output bytes per uncompressed parquet byte of the exported columns, by
 *  format (text coordinates and JSON/XML keys inflate binary columns; CSV has
 *  no shape, only the attributes and a centre point). Measured on groundwater
 *  prospect exports, 18 Nov 2026 (actual / footer bytes):
 *    GeoJSON  Manipur 1.5, Karnataka 2.8 (41,448 rows, 609 MB), Sikkim 5.7,
 *             Sikkim class 31 6.9, Goa 7.8
 *    KML      about 0.94 x GeoJSON (1.3 to 7.3)
 *    CSV      Karnataka 4.1, Mizoram 4.1, Sikkim class 31 4.9
 *  The high end is used: an export judged too big points to the per-state zip
 *  or a narrower filter; one that really is too big would stop a Worker
 *  partway through the file. */
export const EXPORT_SIZE_FACTOR: Record<ExportFormat, number> = { geojson: 8, kml: 7.5, csv: 5 };

/**
 * Estimated output size: for each row group holding matches, its uncompressed
 * bytes per row over the exported columns (from the parquet footer, nothing
 * read) times its matches, summed, times the format's factor. Per group, not
 * per file: one state's polygons can be several times denser than the average.
 */
export function estimateExportBytes(
  metadata: FileMetaData,
  perGroup: Array<{ count: number }>,
  columns: string[],
  format: ExportFormat,
): number {
  const want = new Set(columns);
  let bytes = 0;
  metadata.row_groups.forEach((rg, i) => {
    const matches = perGroup[i]?.count ?? 0;
    const rows = Number(rg.num_rows);
    if (!matches || !rows) return;
    let groupBytes = 0;
    for (const chunk of rg.columns) {
      const top = chunk.meta_data?.path_in_schema?.[0];
      if (top && want.has(top)) groupBytes += Number(chunk.meta_data!.total_uncompressed_size);
    }
    bytes += (groupBytes / rows) * matches;
  });
  return Math.round(bytes * EXPORT_SIZE_FACTOR[format]);
}

export interface ExportResult {
  total: number;
  chunks: AsyncIterable<string>;
}

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

/** The columns an export reads: CSV writes no shape, so it never reads one. */
export function readColumnsFor(format: ExportFormat, propCols: string[], geomCol: string | undefined, bboxCols: string[]): string[] {
  return [...propCols, ...(geomCol && format !== 'csv' ? [geomCol] : []), ...bboxCols];
}

export interface ExportPlan {
  total: number;
  /** Estimated output size per format (estimateExportBytes). */
  estimatedBytes: Record<ExportFormat, number>;
}

type Selection = { where?: Record<string, string>; filters?: FilterSpec[] };

/** Pass 1 and the export's column set; nothing but the match columns is read. */
async function scan(file: AsyncBuffer, sel: Selection, keep: number) {
  const filters = sel.filters ?? [];
  const where = Object.entries(sel.where ?? {}).map(([c, v]) => [c, v.toLowerCase()] as [string, string]);
  if (!filters.length && !where.length) {
    throw new QueryInputError('An export needs a filter (filter= or where=). The whole layer is a download: see the layer\'s files.');
  }
  const metadata = await cachedMetadata(file);
  const cols = topLevelColumns(metadata);
  const matchCols = [...new Set([...where.map(([c]) => c), ...filters.map((f) => f.col)])];
  assertFilterColumns(cols, matchCols);
  const { perGroup, total } = await scanMatches(file, metadata, matchCols, rowMatcher(where, filters), keep);

  const geomCol = cols.find((c) => isGeomColumn(c.name))?.name;
  const propCols = cols.map((c) => c.name).filter((n) => n !== geomCol && !BBOX_COLS.has(n));
  const hasBbox = ['xmin', 'ymin', 'xmax', 'ymax'].every((c) => cols.some((x) => x.name === c));
  const bboxCols = hasBbox ? ['xmin', 'ymin', 'xmax', 'ymax'] : [];
  const shapeCols = [...propCols, ...(geomCol ? [geomCol] : [])];
  const estimatedBytes = {
    geojson: estimateExportBytes(metadata, perGroup, shapeCols, 'geojson'),
    kml: estimateExportBytes(metadata, perGroup, shapeCols, 'kml'),
    csv: estimateExportBytes(metadata, perGroup, [...propCols, ...bboxCols], 'csv'),
  };
  return { metadata, perGroup, total, geomCol, propCols, hasBbox, bboxCols, estimatedBytes };
}

/** The match count and each format's estimated size (the panel asks this
 *  before exporting; /export?estimate=1). */
export async function planExport(file: AsyncBuffer, sel: Selection): Promise<ExportPlan> {
  const { total, estimatedBytes } = await scan(file, sel, 0);
  return { total, estimatedBytes };
}

const MB = (n: number) => `${Math.round(n / (1024 * 1024)).toLocaleString('en-US')} MB`;
const FORMAT_LABEL: Record<ExportFormat, string> = { geojson: 'GeoJSON', kml: 'KML', csv: 'CSV' };

/**
 * Count the rows matching `where` and `filters` and estimate the output;
 * refuse above `maxRows` or `maxBytes` (QueryInputError, no row read);
 * otherwise return the total and the export as an async stream of text
 * chunks, one row group's rows per chunk.
 */
export async function exportRows(
  file: AsyncBuffer,
  opts: Selection & {
    format: ExportFormat;
    name?: string;
    maxRows?: number;
    maxBytes?: number;
    /** Said in the over-the-cap message, e.g. where whole-layer downloads are. */
    tooManyHint?: string;
  },
): Promise<ExportResult> {
  const maxRows = opts.maxRows ?? EXPORT_MAX_ROWS;
  const maxBytes = opts.maxBytes ?? EXPORT_MAX_BYTES;
  const { metadata, perGroup, total, geomCol, propCols, hasBbox, bboxCols, estimatedBytes } = await scan(file, opts, maxRows);
  const instead = `Narrow the filter${opts.tooManyHint ? `, or ${opts.tooManyHint}` : ''}.`;
  if (total > maxRows) {
    throw new QueryInputError(
      `${total.toLocaleString('en-US')} rows match: more than this export's ${maxRows.toLocaleString('en-US')}. ${instead}`,
    );
  }
  const est = estimatedBytes[opts.format];
  if (est > maxBytes) {
    throw new QueryInputError(
      `${total.toLocaleString('en-US')} rows match, an estimated ${MB(est)} as ${FORMAT_LABEL[opts.format]}: `
      + `more than this export's ${MB(maxBytes)}. ${instead}`,
    );
  }

  const format = opts.format;
  const readCols = readColumnsFor(format, propCols, geomCol, bboxCols);
  const windows = perGroup.flatMap((g) => readWindows(g.idxs, READ_WINDOW_ROWS));

  async function* rowsOf(): AsyncGenerator<Record<string, unknown>> {
    for (const w of windows) { // one window in memory at a time
      const lo = w[0];
      const rows = await parquetReadObjects({
        file, metadata, compressors, columns: readCols, rowStart: lo, rowEnd: w[w.length - 1] + 1,
      }) as Record<string, unknown>[];
      for (const i of w) yield rows[i - lo];
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
