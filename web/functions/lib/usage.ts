// API and MCP use per layer, beside downloads: proof that a layer is used.
// Only calls that name a layer count (detail, query, schema, counts, export,
// nearby; not locate, which the viewer's button calls on every tap), plus the
// point lookups (/ground, /surface), which name none: they count under
// endpoint:<name> and are listed as `endpoints`. Crawlers and
// our own smoke test don't, and only the live site counts: preview deploys and
// local dev share the production database but are not use. The bharatlas MCP sends
// "bharatlas-mcp/<version>" (mcp/index.js), which is how its calls are told apart.
import { fmtCount } from '../../../shared/format.mjs';
import { noteCall } from './api-calls';

export type Channel = 'api' | 'mcp';
type RunnableD1 = Pick<D1Database, 'prepare' | 'batch'>;

// headless browsers (Lightpanda, HeadlessChrome) scrape under browser-like names: on 21 Nov one
// opened 12,000 of yellide's pages, every one counted as a person there
const NOT_COUNTED = /bharatlas-mcp-test|bot\b|bot\/|crawler|spider|slurp|facebookexternalhit|lightpanda|headless/i;

/** Crawlers, bots and our own smoke test: their calls and downloads are not counted. */
const isNotCounted = (userAgent: string | null): boolean => NOT_COUNTED.test(userAgent ?? '');

/** The live site: bharatlas.com and the production Pages address. Previews
 *  (<branch>.geodata-3ij.pages.dev) and local dev write nothing. */
const COUNTED_HOSTS = new Set(['bharatlas.com', 'geodata-3ij.pages.dev']);
export const countedHost = (url: URL): boolean => COUNTED_HOSTS.has(url.hostname);

/** A call or download that counts: on the live site, and not a crawler or our smoke test. */
export const isCountedRequest = (request: Request): boolean =>
  countedHost(new URL(request.url)) && !isNotCounted(request.headers.get('user-agent'));

/** Which channel a request counts under, or null when it shouldn't count. */
export function usageChannel(userAgent: string | null): Channel | null {
  const ua = userAgent ?? '';
  if (isNotCounted(ua)) return null;
  return /^bharatlas-mcp\//.test(ua) ? 'mcp' : 'api';
}

/** Bump the running total (layer-page line) and the UTC-day row (ops' last 30 days) in one round trip. */
export async function incrementApiUse(db: RunnableD1, layerId: string, channel: Channel, now = new Date()): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO api_usage (layer_id, channel, count, last_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(layer_id, channel)
         DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
      )
      .bind(layerId, channel, now.toISOString()),
    db
      .prepare(
        `INSERT INTO api_usage_daily (day, layer_id, channel, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(day, layer_id, channel)
         DO UPDATE SET count = count + 1`,
      )
      .bind(now.toISOString().slice(0, 10), layerId, channel),
  ]);
}

/** The channel a call on the live site counts under, or null (a preview, a crawler, our smoke test). */
const countedChannel = (request: Request): Channel | null =>
  countedHost(new URL(request.url)) ? usageChannel(request.headers.get('user-agent')) : null;

/** Count a call that names a layer, without delaying the answer (waitUntil; failures ignored). */
export function countApiUse(
  ctx: { request: Request; env: { DB?: RunnableD1 }; waitUntil(p: Promise<unknown>): void },
  layerId: string,
): void {
  const channel = countedChannel(ctx.request);
  if (!channel) return;
  noteCall(ctx.request, { subject: layerId, channel }); // its speed too (api-calls.ts), when the handler is timed
  if (!ctx.env.DB) return;
  ctx.waitUntil(incrementApiUse(ctx.env.DB, layerId, channel).catch(() => {}));
}

export type Usage = { downloads: number; api: number; mcp: number };
export type EndpointUsage = Omit<Usage, 'downloads'>;

const ENDPOINT = 'endpoint:';
/** The api_usage id a call to an endpoint that names no layer counts under. */
export const endpointUsageId = (name: string): string => `${ENDPOINT}${name}`;

/** Per-layer downloads (all formats and states) and API/MCP calls, the endpoints'
 *  calls, plus totals (API and MCP totals include the endpoints'). */
export function shapeUsage(
  downloads: { layer_id: string; count: number }[],
  api: { layer_id: string; channel: string; count: number }[],
): { layers: Record<string, Usage>; endpoints: Record<string, EndpointUsage>; total: Usage } {
  const layers: Record<string, Usage> = {};
  const endpoints: Record<string, EndpointUsage> = {};
  const total: Usage = { downloads: 0, api: 0, mcp: 0 };
  const at = (id: string) => (layers[id] ??= { downloads: 0, api: 0, mcp: 0 });
  for (const r of downloads) { at(r.layer_id).downloads += r.count; total.downloads += r.count; }
  for (const r of api) {
    const k = r.channel === 'mcp' ? 'mcp' : 'api';
    const row = r.layer_id.startsWith(ENDPOINT)
      ? (endpoints[r.layer_id.slice(ENDPOINT.length)] ??= { api: 0, mcp: 0 })
      : at(r.layer_id);
    row[k] += r.count;
    total[k] += r.count;
  }
  return { layers, endpoints, total };
}

/** "1.2k downloads · 4.3k API queries (900 via MCP)". API queries include the MCP's. */
export function usageLine(u: Usage): string {
  const queries = u.api + u.mcp;
  return [
    u.downloads ? `${fmtCount(u.downloads)} download${u.downloads === 1 ? '' : 's'}` : '',
    queries ? `${fmtCount(queries)} API quer${queries === 1 ? 'y' : 'ies'}${u.mcp ? ` (${fmtCount(u.mcp)} via MCP)` : ''}` : '',
  ].filter(Boolean).join(' · ');
}

/** Record a call's speed (api-calls.ts) under `subject`, by countApiUse's rules, without
 *  counting it as use: /locate, which the viewer's button calls on every tap. */
export function timeOnly(request: Request, subject: string): void {
  const channel = countedChannel(request);
  if (channel) noteCall(request, { subject, channel });
}
