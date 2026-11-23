// How fast the API and MCP answer real callers: one Workers Analytics Engine data
// point (dataset bharatlas_api_calls, binding API_CALLS) per counted /api/v1 call,
// that is every call countApiUse counts (usage.ts: the live site, no crawlers or smoke
// test). The ops dashboard reads them back with the AE SQL API (p50/p95, partial and
// cache-hit rates, colos, MCP versions).
//
// timedCall wraps a handler, so the hosted MCP, which runs handlers in-process and
// skips the /api/v1 middleware (lib/mcp.ts runRoute), is timed the same way. The
// handler and usage.ts add what they know with noteCall, keyed by the request.
//
// What the time is: from the handler's start to its Response (headers ready), on the
// Workers clock, which moves only while the Worker waits on I/O (R2, the cache, D1).
// It leaves out CPU spent decoding (server-timing.ts), the rate limit before the
// handler, a body still streaming after the headers (export), and the network to the
// caller. So it tracks where waits grow (R2, cache misses), not the caller's whole wait.
//
// Privacy: no IP, coordinate, query text or anything else that tells callers apart.
// The MCP version is kept only when it looks like a version; free text is "other".
import type { Channel } from './usage';

export const API_CALLS_DATASET = 'bharatlas_api_calls';

/** What a call adds about itself while it runs. Only a call with a subject is recorded. */
export type CallNote = {
  subject?: string;   // the layer id, or endpoint:<name> (usage.ts)
  channel?: Channel;
  reads?: number;     // point lookups, computed answers only: R2 reads
  coloHits?: number;  // ... reads the colo's cache answered instead
  partial?: number;   // ... layers missed by chance (a timeout or a failed read)
};

const notes = new WeakMap<Request, CallNote>();

/** Adds to the note of the call `request` belongs to; a no-op outside timedCall. */
export function noteCall(request: Request, fields: CallNote): void {
  const n = notes.get(request);
  if (n) Object.assign(n, fields);
}

const VERSION = /^bharatlas-mcp\/(hosted|\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.]{1,20})?)(?=$|[\s;(])/;

/** The bharatlas MCP's version from its user agent ("hosted" for the hosted server), "other"
 *  for anything else after the prefix, '' for every other caller. */
export function mcpVersion(userAgent: string | null): string {
  const ua = userAgent ?? '';
  if (!ua.startsWith('bharatlas-mcp/')) return '';
  return VERSION.exec(ua)?.[1] ?? 'other';
}

/** The kind of call: ground, surface, nearby, detail (a layer), or a layer's query, schema, counts, export. */
export function callRoute(pathname: string): string {
  const [first = '', , sub] = pathname.replace(/^\/api\/v1\//, '').split('/');
  return first === 'layers' ? sub || 'detail' : first;
}

/** Which of sections= and layers= narrowed a point lookup: '', sections, layers or sections+layers. */
export function filterUsed(q: URLSearchParams): string {
  return ['sections', 'layers'].filter((k) => q.get(k)).join('+');
}

const coloOf = (request: Request): string => {
  const c = (request as { cf?: { colo?: unknown } }).cf?.colo;
  return typeof c === 'string' && /^[A-Z]{3}$/.test(c) ? c : '';
};

/** The data point, in fixed positions (the dashboard's SQL reads them by position):
 *  blobs: subject, channel, mcp version, colo, cache (hit, miss, none), filter, route;
 *  doubles: ms, status, reads, colo hits, partial layers. Indexed (sampled) by subject. */
export function callDataPoint(request: Request, note: CallNote, status: number, ms: number, edgeCache: string | null): AnalyticsEngineDataPoint {
  const url = new URL(request.url);
  const subject = note.subject ?? '';
  const cache = edgeCache === 'HIT' ? 'hit' : edgeCache === 'MISS' ? 'miss' : 'none';
  return {
    indexes: [subject],
    blobs: [subject, note.channel ?? '', mcpVersion(request.headers.get('user-agent')), coloOf(request), cache, filterUsed(url.searchParams), callRoute(url.pathname)],
    doubles: [Math.round(ms), status, note.reads ?? 0, note.coloHits ?? 0, note.partial ?? 0],
  };
}

function record(env: { API_CALLS?: AnalyticsEngineDataset }, request: Request, note: CallNote, status: number, ms: number, edgeCache: string | null): void {
  if (!note.subject || !env.API_CALLS) return;
  try {
    env.API_CALLS.writeDataPoint(callDataPoint(request, note, status, ms, edgeCache)); // returns at once; the runtime sends it
  } catch { /* never fail or slow a call over its own record */ }
}

type Ctx = { request: Request; env: { API_CALLS?: AnalyticsEngineDataset } };

/** `handler`, recording each call it counts (see the top of this file). */
export function timedCall<C extends Ctx>(handler: (ctx: C) => Response | Promise<Response>): (ctx: C) => Promise<Response> {
  return async (ctx) => {
    const note: CallNote = {};
    notes.set(ctx.request, note);
    const t0 = Date.now();
    try {
      const res = await handler(ctx);
      record(ctx.env, ctx.request, note, res.status, Date.now() - t0, res.headers.get('x-edge-cache'));
      return res;
    } catch (e) {
      record(ctx.env, ctx.request, note, 500, Date.now() - t0, null);
      throw e;
    }
  };
}
