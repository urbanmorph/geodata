import type { Env } from '../../../_middleware';
import { SERVER_SHAPE_EXPORT } from '../../../../../../shared/large-load.mjs';
import { mimeFor } from '../../../../../../shared/mime.mjs';
import { countApiUse } from '../../../../lib/usage';
import { timedCall } from '../../../../lib/api-calls';
import { withColoReads } from '../../../../lib/colo-cache';
import { r2KeyFromLayer, asyncBufferFromR2 } from '../../../../lib/parquet-r2';
import { queryFailure } from '../../../../lib/parquet-query';
import {
  exportRows, planExport, parseFilterParam, EXPORT_FORMATS, EXPORT_MAX_BYTES, EXPORT_MAX_ROWS, EXPORT_MAX_SHAPE_BYTES,
  type ExportFormat,
} from '../../../../lib/parquet-export';
import { parseQueryParams } from '../../../../lib/query-params';
import { apiError, json } from '../../../../lib/http';
import { resolveLayer } from '../../../../lib/api-layer';
import { answerKey, cached, dataIdentity, EDGE_TTL } from '../../../../lib/edge-cache';

/** Where the whole layer lives, for the over-the-cap message: a layer split
 *  per state ships its GeoJSON/KML/shapefile as zips of state files. */
function downloadsHint(layer: { geojson?: { url?: string } | null }): string {
  return layer.geojson?.url?.endsWith('.zip')
    ? 'for whole states download the per-state zip (GeoJSON, KML or shapefile) from the layer’s files'
    : 'download the whole layer from its files';
}

/** When shape exports are switched off (SERVER_SHAPE_EXPORT, shared/large-load.mjs), why a GeoJSON/KML request is refused; null otherwise.
 *  SERVER_SHAPE_EXPORT is on; this branch is the kill switch kept for a hotfix
 *  (#315 used it): set the flag false and GeoJSON/KML answer 400 while CSV still works. */
export function shapeExportRefusal(format: string): string | null {
  if (SERVER_SHAPE_EXPORT || format === 'csv') return null;
  return `${format === 'kml' ? 'KML' : 'GeoJSON'} export of filtered rows is paused while we fix it. Use format=csv `
    + '(each row with its centre point), or download the whole layer or a per-state file from the layer page.';
}

/**
 * The export as a response body. A failure partway errors the stream, so the
 * connection ends without its final chunk and the download shows as failed,
 * never as a short file under a 200 (headers are sent before the rows are
 * read). A client that goes away stops the export.
 */
export function exportBody(chunks: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const iter = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iter.next();
        if (done) controller.close();
        else controller.enqueue(enc.encode(value));
      } catch (e) {
        console.error('export failed partway:', (e as Error).message);
        controller.error(e);
      }
    },
    async cancel() {
      await iter.return?.(undefined);
    },
  });
}

export const onRequestGet: PagesFunction<Env> = timedCall(async (ctx) => {
  const url = new URL(ctx.request.url);
  const format = (url.searchParams.get('format') || (SERVER_SHAPE_EXPORT ? 'geojson' : 'csv')).toLowerCase() as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) {
    return apiError(400, `format must be one of ${EXPORT_FORMATS.join(', ')}`);
  }
  const paused = shapeExportRefusal(format);
  if (paused) return apiError(400, paused);
  const r = await resolveLayer(ctx);
  if (r instanceof Response) return r;
  const { layer, dataVersion } = r;
  const r2Key = r2KeyFromLayer(layer);
  if (!r2Key) return apiError(404, 'No parquet file for this layer');
  countApiUse(ctx, layer.id);

  const fail = queryFailure('Export', layer.id);
  try {
    const filters = parseFilterParam(url.searchParams.get('filter'));
    const { where } = parseQueryParams(url.searchParams);
    if (url.searchParams.get('estimate') === '1') {
      // The Filter panel asks this on every filter change, then exports: the
      // answer depends only on the deploy, the file and the query, so the colo keeps it.
      return cached(ctx, answerKey('export', dataIdentity(layer), url), EDGE_TTL.r2, async () => {
        try {
          const plan = await withColoReads(ctx, dataVersion, async (r2) => planExport(await asyncBufferFromR2(r2, r2Key), { where, filters }));
          return json(200, { data: {
            total: plan.total, estimated_bytes: plan.estimatedBytes, max_rows: EXPORT_MAX_ROWS, max_bytes: EXPORT_MAX_BYTES,
            shape_bytes: plan.shapeBytes, max_shape_bytes: EXPORT_MAX_SHAPE_BYTES,
          } }, { 'cache-control': 'public, max-age=300' });
        } catch (e) {
          return fail(e);
        }
      });
    }
    // The rows stream after this returns, still read through the colo (only the footer is kept there).
    const out = await withColoReads(ctx, dataVersion, async (r2) =>
      exportRows(await asyncBufferFromR2(r2, r2Key), { where, filters, format, name: layer.id, tooManyHint: downloadsHint(layer) }));
    return new Response(exportBody(out.chunks), {
      headers: {
        'content-type': mimeFor(format),
        'content-disposition': `attachment; filename="${layer.id}.${format}"`,
        'cache-control': 'no-store',
        'x-match-count': String(out.total),
      },
    });
  } catch (e) {
    return fail(e);
  }
});
