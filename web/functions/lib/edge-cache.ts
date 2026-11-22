// Function answers in the colo's cache (caches.default). Pages caches static
// files but never a Function's response, so each API call, /view page and OG
// image used to be rebuilt on every request.
//
// Keys start with the catalog version (a hash of catalog.json): a deploy that
// changes the catalog changes every key, so there is nothing to purge. Callers
// do their own checks first (validation, the layer lookup, countApiUse) and
// wrap only the work: a hit still counts the call.

import { apiError } from './http';
import { withTimeout } from './isolate-cache';

export type EdgeCache = Pick<Cache, 'match' | 'put'>;
type CacheCtx = { request: Request; waitUntil(p: Promise<unknown>): void };

/** How long the colo keeps an answer (seconds). Catalog answers can't go stale
 *  (the key moves with the catalog); R2 answers allow for an object replaced
 *  under the same key. */
export const EDGE_TTL = { catalog: 86_400, r2: 3_600, page: 86_400, live: 60 } as const;

/** The cache-control the answers carry for browsers and the CDN: catalog API
 *  answers, rendered pages (/view, /c, community files), and live counters. */
export const CACHE_CONTROL = {
  catalog: 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
  page: 'public, max-age=300, s-maxage=300, stale-while-revalidate=86400',
  live: 'public, max-age=30, stale-while-revalidate=120',
} as const;

const KEY_ORIGIN ='https://bharatlas.com/__cache/';
// Restores the handler's own cache-control on a hit: the stored copy carries
// the edge ttl instead (the Cache API honours the stored cache-control).
const CLIENT_CC = 'x-client-cache-control';
/** A handler sets this header on a 200 the colo must not keep (a partial answer); it never reaches the client. */
export const NO_STORE = 'x-edge-no-store';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The cache key: version, path, then the query sorted (or left out when the
 *  answer never depends on it). Same key on every host (previews, pages.dev). */
export function cacheKey(version: string, url: URL, opts: { query?: boolean } = {}): string {
  let key = `${KEY_ORIGIN}${version}${url.pathname}`;
  if (opts.query !== false) {
    const q = new URLSearchParams([...url.searchParams].sort(([a, av], [b, bv]) => cmp(a, b) || cmp(av, bv)));
    if ([...q].length) key += `?${q}`;
  }
  return key;
}

/** caches.default where the runtime has it (Workers), else null (vitest). */
export function defaultCache(): EdgeCache | null {
  return typeof caches !== 'undefined' && (caches as { default?: Cache }).default ? (caches as unknown as { default: Cache }).default : null;
}

/** A quoted ETag for `s` (a 53-bit cyrb53 hash, base 36). */
export const etagFor = (s: string): string => `"${hash(s)}"`;

function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const strip = (tag: string) => tag.trim().replace(/^W\//, '');

/** 304 when the request's If-None-Match names this response's ETag. */
export function notModified(request: Request, res: Response): Response {
  const etag = res.headers.get('etag');
  const inm = request.headers.get('if-none-match');
  if (!etag || !inm || res.status !== 200) return res;
  const tags = inm.split(',').map(strip);
  if (!tags.includes('*') && !tags.includes(strip(etag))) return res;
  return new Response(null, { status: 304, headers: res.headers });
}

function withHeaders(res: Response, set: Record<string, string | null>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(set)) {
    if (v == null) headers.delete(k);
    else headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** How long a cache lookup may take before the answer is computed instead: a lookup
 *  is milliseconds, and nothing outside a handler's own work may hold an answer up. */
export const MATCH_TIMEOUT_MS = 2_000;

/** `cache.match(key)`, or undefined when it fails or takes longer than `ms`. */
export function matchWithin(cache: EdgeCache, key: string, ms: number): Promise<Response | undefined> {
  return withTimeout(cache.match(key), ms, 'cache lookup').catch(() => undefined);
}

/** The stored answer for `key`, or `compute()`'s, stored for `ttl` seconds when
 *  it is a 200. Adds an ETag (from the key, unless the handler set one) and
 *  answers 304 to a matching If-None-Match. Cache failures fall back to compute. */
export async function cached(
  ctx: CacheCtx,
  key: string,
  ttl: number,
  compute: () => Promise<Response>,
  cache: EdgeCache | null = defaultCache(),
  matchTimeoutMs = MATCH_TIMEOUT_MS,
): Promise<Response> {
  const hit = cache ? await matchWithin(cache, key, matchTimeoutMs) : undefined;
  if (hit) {
    const cc = hit.headers.get(CLIENT_CC);
    return notModified(ctx.request, withHeaders(hit, { 'cache-control': cc, [CLIENT_CC]: null, 'x-edge-cache': 'HIT' }));
  }

  let res = await compute();
  if (res.status !== 200) return res;
  const keep = !res.headers.has(NO_STORE);
  res = withHeaders(res, { etag: res.headers.get('etag') ?? etagFor(key), 'x-edge-cache': 'MISS', [NO_STORE]: null });
  if (cache && keep) {
    const stored = withHeaders(res.clone(), {
      'cache-control': `public, max-age=${ttl}`,
      [CLIENT_CC]: res.headers.get('cache-control'),
      'x-edge-cache': null,
    });
    ctx.waitUntil(cache.put(key, stored).catch(() => {}));
  }
  return notModified(ctx.request, res);
}

/**
 * A D1-backed answer (counts, votes, the sitemap): kept `ttl` seconds in the
 * colo (default EDGE_TTL.live, so counts may lag a minute) instead of a D1 read
 * per request. The key is the URL alone (D1 does not change with a deploy). A
 * failure is a 503 the colo does not keep, never a cached "zero".
 */
export function cachedLive(
  ctx: CacheCtx,
  compute: () => Promise<Response>,
  ttl: number = EDGE_TTL.live,
  cache: EdgeCache | null = defaultCache(),
): Promise<Response> {
  return cached(ctx, cacheKey('live', new URL(ctx.request.url)), ttl, async () => {
    try {
      return await compute();
    } catch (e) {
      console.error(`${new URL(ctx.request.url).pathname} failed:`, (e as Error)?.message ?? e);
      return apiError(503, 'Temporarily unavailable, please try again', { 'retry-after': '30' });
    }
  }, cache);
}
