// The colo's cache (caches.default) for what every point lookup reads again: parquet
// footers, tile archive headers, directories and tiles, GeoTIFF headers and pixels,
// and decoded bbox columns (lib/nearby.ts). The isolate's own caches (isolate-cache.ts)
// keep these only while one isolate lives, and production spreads lookups over many
// short-lived isolates: a fresh one re-read 95 of a surface answer's 127 R2 reads and
// spent most of its CPU decoding bbox columns again. The colo's cache is shared by
// every isolate in the data centre and answers in milliseconds.
//
// Puts wait until the answer is out (startPuts), so they never compete with the
// lookup's own reads for the Worker's six connections. A lookup that is slow or fails
// is a miss: the cache can make an answer faster, never later.
import { defaultCache, matchWithin, type EdgeCache } from './edge-cache';
import { noteCall } from './api-calls';

const KEY_ORIGIN = 'https://bharatlas.com/__colo/';
const META = 'x-colo-';
/** How long a cache lookup may take before it counts as a miss. */
export const COLO_LOOKUP_MS = 500;

export interface ColoHit { data: ArrayBuffer; meta: Record<string, string> }

export interface ColoCache {
  /** The bytes kept under `key` and their metadata, or null (a miss, a slow lookup, a failure). */
  get(key: string): Promise<ColoHit | null>;
  /** Keep `data` (and `meta`) under `key` for `ttl` seconds, once the answer is out. */
  put(key: string, data: ArrayBuffer, meta: Record<string, string>, ttl: number): void;
  /** The answer is out: send the waiting puts (and any later one) through `defer`. */
  startPuts(): void;
  hits(): number;
}

const url = (key: string) => KEY_ORIGIN + key.split('/').map(encodeURIComponent).join('/');

/** A colo cache over `cache` (null: a no-op, as in tests and local dev); `defer` is the request's waitUntil. */
export function coloCache(
  cache: EdgeCache | null, defer: (p: Promise<unknown>) => void, opts: { timeoutMs?: number } = {},
): ColoCache {
  const timeoutMs = opts.timeoutMs ?? COLO_LOOKUP_MS;
  let waiting: Array<() => Promise<unknown>> | null = [];
  let hits = 0;
  const send = (put: () => Promise<unknown>) => {
    try { defer(put().catch(() => {})); } catch { /* the request is over: the bytes are simply not kept */ }
  };
  return {
    async get(key) {
      if (!cache) return null;
      const res = await matchWithin(cache, url(key), timeoutMs);
      if (!res?.ok) return null;
      try {
        const data = await res.arrayBuffer();
        const meta: Record<string, string> = {};
        res.headers.forEach((v, k) => { if (k.startsWith(META)) meta[k.slice(META.length)] = v; });
        hits++;
        return { data, meta };
      } catch {
        return null;
      }
    },
    put(key, data, meta, ttl) {
      if (!cache) return;
      const headers: Record<string, string> = { 'cache-control': `public, max-age=${ttl}`, 'content-type': 'application/octet-stream' };
      for (const [k, v] of Object.entries(meta)) headers[META + k] = v;
      const put = () => cache.put(url(key), new Response(data, { headers }));
      if (waiting) waiting.push(put);
      else send(put);
    },
    startPuts() {
      const now = waiting ?? [];
      waiting = null;
      for (const put of now) send(put);
    },
    hits: () => hits,
  };
}

// ── R2 reads through the colo ───────────────────────────────────────────────

const COLO = Symbol('colo');

/** The colo cache a bucket from coloBucket carries (for readers that keep decoded data), if any. */
export function coloOf(r2: R2Bucket): ColoCache | undefined {
  return (r2 as unknown as { [COLO]?: ColoCache })[COLO];
}

/** Reads every point shares: a parquet file's tail (its footer), and range reads of
 *  tile archives and GeoTIFFs (headers, directories, tiles, pixel blocks). A parquet's
 *  other ranges are rows near one point (bbox columns are kept decoded instead). */
function shared(key: string, range: R2Range | undefined): boolean {
  if (!range) return false;
  return ('suffix' in range && range.suffix !== undefined) || /\.(pmtiles|tiff?)$/i.test(key);
}

const rangeKey = (r: R2Range) => ('suffix' in r && r.suffix !== undefined ? `-${r.suffix}`
  : `${(r as { offset?: number }).offset ?? 0}+${(r as { length?: number }).length ?? ''}`);

/** A range read's answer, as the readers use it (size, etag and the bytes; the body is already read). */
const bytesObject = (key: string, size: number, etag: string, data: ArrayBuffer) =>
  ({ key, size, etag, httpEtag: `"${etag}"`, httpMetadata: {}, arrayBuffer: async () => data }) as unknown as R2ObjectBody;

/** R2 answers kept in the colo for an hour (as /api answers are: an object may be replaced under its key). */
export const COLO_R2_TTL = 3_600;

/** `r2` with its shared range reads kept in the colo under the deploy `version`
 *  (a deploy that changes a layer's file changes the version). */
export function coloBucket(r2: R2Bucket, colo: ColoCache, version: string): R2Bucket {
  const get = async (key: string, opts?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> => {
    const range = opts?.range as R2Range | undefined;
    if (!shared(key, range) || opts?.onlyIf) return r2.get(key, opts);
    const ck = `r2/${version}/${key}#${rangeKey(range!)}`;
    const hit = await colo.get(ck);
    if (hit && hit.meta.size && hit.meta.etag) return bytesObject(key, Number(hit.meta.size), hit.meta.etag, hit.data);
    const obj = await r2.get(key, opts);
    if (!obj || !('arrayBuffer' in obj)) return obj;
    const data = await obj.arrayBuffer();
    colo.put(ck, data, { size: String(obj.size), etag: obj.etag }, COLO_R2_TTL);
    return bytesObject(key, obj.size, obj.etag, data);
  };
  return new Proxy(r2, {
    get(target, prop) {
      if (prop === COLO) return colo;
      if (prop === 'get') return get;
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** The bucket, counting its reads (get and head): every read waits for one of the
 *  Worker's six connections, so the count is what sets an answer's latency. */
export function countingBucket(r2: R2Bucket): { bucket: R2Bucket; reads: () => number } {
  let n = 0;
  const bucket = new Proxy(r2, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if ((prop === 'get' || prop === 'head') && typeof v === 'function') {
        return (...args: unknown[]) => { n++; return v.apply(target, args); };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { bucket, reads: () => n };
}

/** `fn` with `ctx.env.R2` read through the colo (coloBucket, keyed by the deploy
 *  `version`), noting on the call (api-calls.ts) how many reads went to R2 and how
 *  many the colo answered. The puts go out once `fn` is done. */
export async function withColoReads<T>(
  ctx: { request: Request; env: { R2: R2Bucket }; waitUntil(p: Promise<unknown>): void },
  version: string,
  fn: (r2: R2Bucket) => Promise<T>,
  cache: EdgeCache | null = defaultCache(),
): Promise<T> {
  const { bucket, reads } = countingBucket(ctx.env.R2);
  const colo = coloCache(cache, (p) => ctx.waitUntil(p));
  try {
    return await fn(coloBucket(bucket, colo, version));
  } finally {
    colo.startPuts();
    noteCall(ctx.request, { reads: reads(), coloHits: colo.hits() });
  }
}
