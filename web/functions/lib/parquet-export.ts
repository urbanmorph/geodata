/**
 * Filtered export for /api/v1/layers/{id}/export: the rows matching a filter,
 * streamed as GeoJSON, KML or CSV. The Filter panel uses it for layers too
 * large to filter in the browser (shared/large-load.mjs LARGE_FILTER_BYTES).
 *
 * Pass 1 reads only the filter columns and counts every match; above the
 * caps (rows, estimated bytes, shape decoding) nothing more is read and the
 * caller gets a 400 with guidance. Pass 2 reads the matching rows' attribute
 * columns in small windows, and their shapes as WKB from a streamed geometry
 * page (parquet-column-stream.ts), converting only those rows to GeoJSON: a
 * DuckDB geometry page is up to ~100 MB, and decoding it whole (with every
 * row's shape) is what stopped production exports on 18 Nov 2026.
 */
import { parquetReadObjects } from 'hyparquet';
import type { FileMetaData } from 'hyparquet';
import { compressors } from './zstd';
import { cachedMetadata, type AsyncBuffer } from './parquet-r2';
import {
  BBOX_COLS,
  QueryInputError,
  READ_WINDOW_ROWS,
  assertFilterColumns,
  isGeomColumn,
  readWindows,
  rowMatcher,
  scanMatches,
  topLevelColumns,
  type FilterSpec,
} from './parquet-query';
import { byteArrayColumnRows } from './parquet-column-stream';
import { wkbToText } from './wkb-geojson';
import { kmlHead, kmlPlacemarkHead, KML_TAIL } from '../../../shared/kml.mjs';
import { csvCell as sharedCsvCell } from '../../../shared/csv.mjs';
import { FILTER_EXPORT_MAX_BYTES, FILTER_EXPORT_MAX_ROWS, FILTER_EXPORT_MAX_SHAPE_BYTES } from '../../../shared/large-load.mjs';

export { READ_WINDOW_ROWS, readWindows } from './parquet-query';

export const EXPORT_MAX_ROWS = FILTER_EXPORT_MAX_ROWS;
export const EXPORT_MAX_BYTES = FILTER_EXPORT_MAX_BYTES;
/** Shape decoding budget: see shared/large-load.mjs and shapeDecodeBytes. */
export const EXPORT_MAX_SHAPE_BYTES = FILTER_EXPORT_MAX_SHAPE_BYTES;
export const EXPORT_FORMATS = ['geojson', 'kml', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const MAX_FILTERS = 20;
const MAX_IN_VALUES = 500;
/** Bounding-box columns: never written as properties (the shape carries them). */
const NOT_PROPS = new Set(['bbox', ...BBOX_COLS]);

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

// Nested values as JSON; every cell through the shared writer (formula-safe).
const csvCell = (v: unknown): string => sharedCsvCell(v != null && typeof v === 'object' ? jsonSafe(v) : plain(v));

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

/** The attribute columns an export reads per window: CSV adds the bbox for
 *  its centre point; shapes (GeoJSON, KML) are read on their own. */
export function readColumnsFor(format: ExportFormat, propCols: string[], bboxCols: string[]): string[] {
  return format === 'csv' ? [...propCols, ...bboxCols] : propCols;
}

/**
 * Uncompressed geometry bytes a shape export streams: per row group with
 * matches, its geometry chunk up to its last match (a page is read from its
 * start; DuckDB writes one or two pages per group). From the footer only.
 */
export function shapeDecodeBytes(metadata: FileMetaData, perGroup: Array<{ last: number }>, geomCol: string): number {
  let start = 0;
  let bytes = 0;
  metadata.row_groups.forEach((rg, i) => {
    const rows = Number(rg.num_rows);
    const last = perGroup[i]?.last ?? -1;
    if (last >= 0 && rows) {
      const chunk = rg.columns.find((c) => c.meta_data?.path_in_schema?.[0] === geomCol);
      bytes += Number(chunk?.meta_data?.total_uncompressed_size ?? 0) * ((last - start + 1) / rows);
    }
    start += rows;
  });
  return Math.round(bytes);
}

export interface ExportPlan {
  total: number;
  /** Estimated output size per format (estimateExportBytes). */
  estimatedBytes: Record<ExportFormat, number>;
  /** Uncompressed geometry a GeoJSON/KML export would stream (shapeDecodeBytes). */
  shapeBytes: number;
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
  const propCols = cols.map((c) => c.name).filter((n) => n !== geomCol && !NOT_PROPS.has(n));
  const hasBbox = ['xmin', 'ymin', 'xmax', 'ymax'].every((c) => cols.some((x) => x.name === c));
  const bboxCols = hasBbox ? ['xmin', 'ymin', 'xmax', 'ymax'] : [];
  const shapeCols = [...propCols, ...(geomCol ? [geomCol] : [])];
  const estimatedBytes = {
    geojson: estimateExportBytes(metadata, perGroup, shapeCols, 'geojson'),
    kml: estimateExportBytes(metadata, perGroup, shapeCols, 'kml'),
    csv: estimateExportBytes(metadata, perGroup, [...propCols, ...bboxCols], 'csv'),
  };
  const shapeBytes = geomCol ? shapeDecodeBytes(metadata, perGroup, geomCol) : 0;
  return { metadata, perGroup, total, geomCol, propCols, hasBbox, bboxCols, estimatedBytes, shapeBytes };
}

/** The match count and each format's estimated size (the panel asks this
 *  before exporting; /export?estimate=1). */
export async function planExport(file: AsyncBuffer, sel: Selection): Promise<ExportPlan> {
  const { total, estimatedBytes, shapeBytes } = await scan(file, sel, 0);
  return { total, estimatedBytes, shapeBytes };
}

const MB = (n: number) => `${Math.round(n / (1024 * 1024)).toLocaleString('en-IN')} MB`;
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
    /** Shape decoding budget (default EXPORT_MAX_SHAPE_BYTES); tests lower it. */
    maxShapeBytes?: number;
  },
): Promise<ExportResult> {
  const maxRows = opts.maxRows ?? EXPORT_MAX_ROWS;
  const maxBytes = opts.maxBytes ?? EXPORT_MAX_BYTES;
  const { metadata, perGroup, total, geomCol, propCols, hasBbox, bboxCols, estimatedBytes, shapeBytes } = await scan(file, opts, maxRows);
  const instead = `Narrow the filter${opts.tooManyHint ? `, or ${opts.tooManyHint}` : ''}.`;
  if (total > maxRows) {
    throw new QueryInputError(
      `${total.toLocaleString('en-IN')} rows match: more than this export's ${maxRows.toLocaleString('en-IN')}. ${instead}`,
    );
  }
  const est = estimatedBytes[opts.format];
  if (est > maxBytes) {
    throw new QueryInputError(
      `${total.toLocaleString('en-IN')} rows match, an estimated ${MB(est)} as ${FORMAT_LABEL[opts.format]}: `
      + `more than this export's ${MB(maxBytes)}. ${instead}`,
    );
  }

  const format = opts.format;
  const shapeCol = format === 'csv' ? undefined : geomCol;
  if (shapeCol && shapeBytes > (opts.maxShapeBytes ?? EXPORT_MAX_SHAPE_BYTES)) {
    throw new QueryInputError(
      `${total.toLocaleString('en-IN')} rows match, spread over too much of this layer to export their shapes in one go. `
      + `${instead} Or export CSV (each row with its centre point).`,
    );
  }
  const readCols = readColumnsFor(format, propCols, bboxCols);

  async function* rowsOf(): AsyncGenerator<Record<string, unknown>> {
    for (const [group, g] of perGroup.entries()) {
      if (!g.idxs.length) continue;
      const shapes = shapeCol ? byteArrayColumnRows(file, metadata, group, shapeCol, g.idxs, compressors) : undefined;
      try {
        for (const w of readWindows(g.idxs, READ_WINDOW_ROWS)) { // one window of attributes in memory at a time
          const lo = w[0];
          const rows = await parquetReadObjects({
            file, metadata, compressors, columns: readCols, rowStart: lo, rowEnd: w[w.length - 1] + 1,
          }) as Record<string, unknown>[];
          for (const i of w) {
            const row = rows[i - lo];
            if (shapes) row[shapeCol!] = (await shapes.next()).value ?? null; // WKB, written out in pieces below
            yield row;
          }
        }
      } finally {
        await shapes?.return(undefined);
      }
    }
  }
  const props = (row: Record<string, unknown>) => Object.fromEntries(propCols.map((c) => [c, plain(row[c])]));
  const shapeOf = (row: Record<string, unknown>) => (shapeCol ? row[shapeCol] as Uint8Array | null : null);

  async function* chunks(): AsyncGenerator<string> {
    if (format === 'geojson') {
      yield '{"type":"FeatureCollection","features":[';
      let first = true;
      for await (const row of rowsOf()) {
        const wkb = shapeOf(row);
        yield `${first ? '\n' : ',\n'}{"type":"Feature","geometry":`;
        if (wkb) yield* wkbToText(wkb, 'geojson'); else yield 'null';
        yield `,"properties":${jsonSafe(props(row))}}`;
        first = false;
      }
      yield '\n]}\n';
    } else if (format === 'kml') {
      yield kmlHead(opts.name ?? 'export');
      for await (const row of rowsOf()) {
        const wkb = shapeOf(row);
        yield kmlPlacemarkHead(props(row));
        if (wkb) yield* wkbToText(wkb, 'kml');
        yield '</Placemark>';
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
