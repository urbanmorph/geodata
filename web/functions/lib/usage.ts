// API and MCP use per layer, beside downloads: proof that a layer is used.
// Only calls that name a layer count (detail, query, schema, stats, nearby);
// crawlers and our own smoke test don't. The bharatlas MCP sends
// "bharatlas-mcp/<version>" (mcp/index.js), which is how its calls are told apart.
import { fmtCount } from '../../../shared/format.mjs';

export type Channel = 'api' | 'mcp';
type RunnableD1 = Pick<D1Database, 'prepare'>;

const NOT_COUNTED = /bharatlas-mcp-test|bot\b|bot\/|crawler|spider|slurp|facebookexternalhit/i;

/** Which channel a request counts under, or null when it shouldn't count. */
export function usageChannel(userAgent: string | null): Channel | null {
  const ua = userAgent ?? '';
  if (NOT_COUNTED.test(ua)) return null;
  return /^bharatlas-mcp\//.test(ua) ? 'mcp' : 'api';
}

export async function incrementApiUse(db: RunnableD1, layerId: string, channel: Channel): Promise<void> {
  await db
    .prepare(
      `INSERT INTO api_usage (layer_id, channel, count, last_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(layer_id, channel)
       DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
    )
    .bind(layerId, channel, new Date().toISOString())
    .run();
}

/** Count a call that names a layer, without delaying the answer (waitUntil; failures ignored). */
export function countApiUse(
  ctx: { request: Request; env: { DB?: RunnableD1 }; waitUntil(p: Promise<unknown>): void },
  layerId: string,
): void {
  const channel = usageChannel(ctx.request.headers.get('user-agent'));
  if (!channel || !ctx.env.DB) return;
  ctx.waitUntil(incrementApiUse(ctx.env.DB, layerId, channel).catch(() => {}));
}

export type Usage = { downloads: number; api: number; mcp: number };

/** Per-layer downloads (all formats and states) and API/MCP calls, plus totals. */
export function shapeUsage(
  downloads: { layer_id: string; count: number }[],
  api: { layer_id: string; channel: string; count: number }[],
): { layers: Record<string, Usage>; total: Usage } {
  const layers: Record<string, Usage> = {};
  const total: Usage = { downloads: 0, api: 0, mcp: 0 };
  const at = (id: string) => (layers[id] ??= { downloads: 0, api: 0, mcp: 0 });
  for (const r of downloads) { at(r.layer_id).downloads += r.count; total.downloads += r.count; }
  for (const r of api) {
    const k = r.channel === 'mcp' ? 'mcp' : 'api';
    at(r.layer_id)[k] += r.count;
    total[k] += r.count;
  }
  return { layers, total };
}

/** "1.2k downloads · 4.3k API queries (900 via MCP)". API queries include the MCP's. */
export function usageLine(u: Usage): string {
  const queries = u.api + u.mcp;
  return [
    u.downloads ? `${fmtCount(u.downloads)} download${u.downloads === 1 ? '' : 's'}` : '',
    queries ? `${fmtCount(queries)} API quer${queries === 1 ? 'y' : 'ies'}${u.mcp ? ` (${fmtCount(u.mcp)} via MCP)` : ''}` : '',
  ].filter(Boolean).join(' · ');
}
