import type { Env } from '../../../_middleware';
import { loadCatalogVersioned } from '../../../../lib/catalog-loader';
import { countApiUse } from '../../../../lib/usage';
import { r2KeyFromLayer, asyncBufferFromR2 } from '../../../../lib/parquet-r2';
import { QueryInputError } from '../../../../lib/parquet-query';
import {
  exportRows, planExport, parseFilterParam, EXPORT_FORMATS, EXPORT_MAX_BYTES, EXPORT_MAX_ROWS, type ExportFormat,
} from '../../../../lib/parquet-export';
import { parseQueryParams } from '../../../../lib/query-params';
import { json } from '../../../../lib/http';

const CONTENT_TYPES: Record<ExportFormat, string> = {
  geojson: 'application/geo+json',
  kml: 'application/vnd.google-earth.kml+xml',
  csv: 'text/csv; charset=utf-8',
};

/** Where the whole layer lives, for the over-the-cap message: a layer split
 *  per state ships its GeoJSON/KML/shapefile as zips of state files. */
function downloadsHint(layer: { geojson?: { url?: string } | null }): string {
  return layer.geojson?.url?.endsWith('.zip')
    ? 'for whole states download the per-state zip (GeoJSON, KML or shapefile) from the layer’s files'
    : 'download the whole layer from its files';
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const id = (ctx.params as { id: string }).id;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return json(400, { error: 'Invalid layer ID', status: 400 });

  const url = new URL(ctx.request.url);
  const format = (url.searchParams.get('format') || 'geojson').toLowerCase() as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) {
    return json(400, { error: `format must be one of ${EXPORT_FORMATS.join(', ')}`, status: 400 });
  }
  const { catalog } = await loadCatalogVersioned(ctx);
  const layer = catalog.layers.find((l) => l.id === id);
  if (!layer) return json(404, { error: 'Layer not found', status: 404 });
  const r2Key = r2KeyFromLayer(layer);
  if (!r2Key) return json(404, { error: 'No parquet file for this layer', status: 404 });
  countApiUse(ctx, id);

  try {
    const filters = parseFilterParam(url.searchParams.get('filter'));
    const { where } = parseQueryParams(url.searchParams);
    const file = await asyncBufferFromR2(ctx.env.R2, r2Key);
    if (url.searchParams.get('estimate') === '1') {
      const plan = await planExport(file, { where, filters });
      return json(200, { data: {
        total: plan.total, estimated_bytes: plan.estimatedBytes, max_rows: EXPORT_MAX_ROWS, max_bytes: EXPORT_MAX_BYTES,
      } });
    }
    const out = await exportRows(file, { where, filters, format, name: id, tooManyHint: downloadsHint(layer) });
    const enc = new TextEncoder();
    const iter = out.chunks[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await iter.next();
        if (done) controller.close();
        else controller.enqueue(enc.encode(value));
      },
    });
    return new Response(body, {
      headers: {
        'content-type': CONTENT_TYPES[format],
        'content-disposition': `attachment; filename="${id}.${format}"`,
        'cache-control': 'no-store',
        'x-match-count': String(out.total),
      },
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof QueryInputError) return json(400, { error: msg, status: 400 });
    return json(500, { error: `Export failed: ${msg}`, status: 500 });
  }
};
