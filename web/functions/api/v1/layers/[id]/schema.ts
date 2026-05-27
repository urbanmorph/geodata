import type { Env } from '../../../_middleware';
import { loadCatalog } from '../../../../lib/catalog-loader';
import { r2KeyFromLayer, asyncBufferFromR2 } from '../../../../lib/parquet-r2';
import { getSchema } from '../../../../lib/parquet-query';

const CACHE = 'public, max-age=86400, stale-while-revalidate=86400';

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

  try {
    const file = await asyncBufferFromR2(ctx.env.R2, r2Key);
    const schema = await getSchema(file);
    return new Response(safeStringify({ data: schema }), {
      headers: { 'content-type': 'application/json', 'cache-control': CACHE },
    });
  } catch (e) {
    return json(500, { error: `Schema read failed: ${(e as Error).message}`, status: 500 });
  }
};

function safeStringify(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? Number(v) : v);
}

function json(status: number, body: unknown) {
  return new Response(safeStringify(body), { status, headers: { 'content-type': 'application/json' } });
}
