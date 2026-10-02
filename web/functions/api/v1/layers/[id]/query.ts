import type { Env } from '../../../_middleware';
import { loadCatalog } from '../../../../lib/catalog-loader';
import { r2KeyFromLayer, asyncBufferFromR2 } from '../../../../lib/parquet-r2';
import { query, QueryInputError } from '../../../../lib/parquet-query';
import { parseQueryParams } from '../../../../lib/query-params';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const id = (ctx.params as { id: string }).id;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return json(400, { error: 'Invalid layer ID', status: 400 });
  }

  const url = new URL(ctx.request.url);
  const catalog = await loadCatalog(url.origin);
  const layer = catalog.layers.find((l) => l.id === id);
  if (!layer) return json(404, { error: 'Layer not found', status: 404 });

  const r2Key = r2KeyFromLayer(layer);
  if (!r2Key) return json(404, { error: 'No parquet file for this layer', status: 404 });

  const { select, groupBy, sum, limit, where, includeCentroid } = parseQueryParams(url.searchParams);

  try {
    const start = Date.now();
    const file = await asyncBufferFromR2(ctx.env.R2, r2Key);
    const result = await query(file, { select, where, groupBy, sum, limit, includeCentroid });
    const timing = Date.now() - start;

    return new Response(safeStringify({ data: result, layer_id: id, timing_ms: timing }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': groupBy ? 'public, max-age=3600, stale-while-revalidate=86400' : 'public, max-age=300, stale-while-revalidate=3600',
      },
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof QueryInputError || msg.includes('not found')) return json(400, { error: msg, status: 400 });
    return json(500, { error: `Query failed: ${msg}`, status: 500 });
  }
};

function safeStringify(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? Number(v) : v);
}

function json(status: number, body: unknown) {
  return new Response(safeStringify(body), { status, headers: { 'content-type': 'application/json' } });
}
