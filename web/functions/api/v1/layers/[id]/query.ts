import type { Env } from '../../../_middleware';
import { loadCatalog } from '../../../../lib/catalog-loader';
import { r2KeyFromLayer, asyncBufferFromR2 } from '../../../../lib/parquet-r2';
import { query } from '../../../../lib/parquet-query';

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

  // Parse query params
  const select = url.searchParams.get('select')?.split(',').map((s) => s.trim()).filter(Boolean);
  const groupBy = url.searchParams.get('group_by') || undefined;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10), 1), 1000);

  // Parse where: supports ?where=col1=val1,col2=val2 or ?col1=val1&col2=val2 style
  const where: Record<string, string> = {};
  const whereParam = url.searchParams.get('where');
  if (whereParam) {
    for (const pair of whereParam.split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) where[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  // Also check for direct column=value params (skip reserved params)
  const reserved = new Set(['select', 'group_by', 'limit', 'where', 'order_by', 'include_centroid']);
  for (const [k, v] of url.searchParams.entries()) {
    if (!reserved.has(k) && v) where[k] = v;
  }
  const includeCentroid = url.searchParams.get('include_centroid') === 'true';

  try {
    const start = Date.now();
    const file = await asyncBufferFromR2(ctx.env.R2, r2Key);
    const result = await query(file, { select, where: Object.keys(where).length ? where : undefined, groupBy, limit, includeCentroid });
    const timing = Date.now() - start;

    return new Response(safeStringify({ data: result, layer_id: id, timing_ms: timing }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': groupBy ? 'public, max-age=3600, stale-while-revalidate=86400' : 'public, max-age=300, stale-while-revalidate=3600',
      },
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('not found')) return json(400, { error: msg, status: 400 });
    return json(500, { error: `Query failed: ${msg}`, status: 500 });
  }
};

function safeStringify(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? Number(v) : v);
}

function json(status: number, body: unknown) {
  return new Response(safeStringify(body), { status, headers: { 'content-type': 'application/json' } });
}
