import type { Env } from '../../../_middleware';
import { loadCatalog } from '../../../../lib/catalog-loader';

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

  const groupBy = url.searchParams.get('group_by');

  // Per-state counts from pre-built api-data/counts.json (deployed as static asset)
  if (groupBy === 'state' || groupBy === 'district') {
    try {
      const r = await fetch(`${url.origin}/api-data/counts.json`);
      if (r.ok) {
        const allCounts = await r.json() as Record<string, { _total: number; by_state?: Record<string, number>; by_district?: Record<string, number> }>;
        const layerCounts = allCounts[id];
        if (layerCounts) {
          const bucket = groupBy === 'state' ? layerCounts.by_state : layerCounts.by_district;
          return new Response(JSON.stringify({
            data: { layer_id: id, total: layerCounts._total, group_by: groupBy, counts: bucket || {} },
          }), { headers: { 'content-type': 'application/json', 'cache-control': CACHE } });
        }
      }
    } catch { /* fall through to basic count */ }
  }

  return new Response(JSON.stringify({
    data: { layer_id: id, total: layer.rows ?? null },
  }), { headers: { 'content-type': 'application/json', 'cache-control': CACHE } });
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
