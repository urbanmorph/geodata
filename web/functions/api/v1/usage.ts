// GET /api/v1/usage[?layer=<id>]: how much each layer is used. Downloads (every
// format and state, from /api/dl) and API calls that name the layer, split into
// api and mcp (the bharatlas MCP). Crawlers and the MCP smoke test are not counted.
import type { Env } from '../../_middleware';
import { json } from '../../lib/http';
import { shapeUsage } from '../../lib/usage';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const layer = new URL(ctx.request.url).searchParams.get('layer');
  if (layer !== null && !/^[a-zA-Z0-9_-]+$/.test(layer)) return json(400, { error: 'Invalid layer ID', status: 400 });
  try {
    const where = layer ? ' WHERE layer_id = ?' : '';
    const bind = layer ? [layer] : [];
    const [dl, api] = await Promise.all([
      ctx.env.DB.prepare(`SELECT layer_id, SUM(count) AS count FROM download_counts${where} GROUP BY layer_id`).bind(...bind).all<{ layer_id: string; count: number }>(),
      // Until migration 0017 is applied, api_usage is missing: still answer with downloads.
      ctx.env.DB.prepare(`SELECT layer_id, channel, count FROM api_usage${where}`).bind(...bind)
        .all<{ layer_id: string; channel: string; count: number }>()
        .catch(() => ({ results: [] as { layer_id: string; channel: string; count: number }[] })),
    ]);
    const usage = shapeUsage(dl.results ?? [], api.results ?? []);
    const body = layer ? { layer_id: layer, ...(usage.layers[layer] ?? { downloads: 0, api: 0, mcp: 0 }) } : usage;
    return new Response(JSON.stringify(body), {
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=60, stale-while-revalidate=300',
      },
    });
  } catch {
    return json(500, { error: 'Usage counts are unavailable right now', status: 500 });
  }
};
