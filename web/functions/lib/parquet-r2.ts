/**
 * R2-backed AsyncBuffer for hyparquet. Reads parquet files from R2
 * via range requests without loading the entire file into memory.
 */
import { parquetMetadataAsync } from 'hyparquet';
import type { FileMetaData } from 'hyparquet';
import type { CatalogLayer } from './catalog-api';
import { r2KeyFromUrl } from './r2-keys';
import { ResolvedCache, READ_TIMEOUT_MS, withTimeout } from './isolate-cache';
import { coloOf, type ColoCache } from './colo-cache';

export interface AsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): Promise<ArrayBuffer>;
  /** Identifies the object version; set => its parsed footer is cached. */
  cacheKey?: string;
  /** The R2 object's etag, when read from R2. */
  etag?: string;
  /** The colo cache of the bucket it was opened through (colo-cache.ts), for data decoded from it. */
  colo?: ColoCache;
  /** Bytes [start, end) as a stream of pieces, in one request: for reading a
   *  large page without holding it (parquet-column-stream.ts). */
  stream?(start: number, end: number): AsyncIterable<Uint8Array>;
}

// Parsed parquet footers, per object version (key + size + etag), kept for
// the life of the Worker isolate. The Overture footer (217 row groups) took
// ~4 s to fetch and parse on every request. Only parsed footers are shared
// across requests (isolate-cache.ts): a read in flight dies with its request.
// Room for the ~30 layers the point profiles read plus the rest of the API: 16
// was thrashed by every /api/v1/surface call.
export const METADATA_CACHE_MAX = 64;
const metaCache = new ResolvedCache<FileMetaData>(METADATA_CACHE_MAX);

export function clearMetadataCache(): void {
  metaCache.clear();
}

export function cachedMetadata(file: AsyncBuffer): Promise<FileMetaData> {
  const key = file.cacheKey;
  if (!key) return parquetMetadataAsync(file);
  return metaCache.get(key, () => parquetMetadataAsync(file), file);
}

export function r2KeyFromLayer(layer: Pick<CatalogLayer, 'parquet'>): string | null {
  return r2KeyFromUrl(layer.parquet?.url);
}

// R2 heads (size + etag) per key, for a few minutes: every schema, query and
// nearby call headed its object first. Layer keys are versioned, so a short
// memory is safe; a missing key is never remembered.
const HEAD_TTL_MS = 5 * 60_000;
const HEAD_CACHE_MAX = 256;
const headCache = new Map<string, { size: number; etag: string; at: number }>();

export function clearHeadCache(): void {
  headCache.clear();
}

type Head = { size: number; etag: string };

function freshHead(key: string): Head | undefined {
  const hit = headCache.get(key);
  return hit && Date.now() - hit.at < HEAD_TTL_MS ? hit : undefined;
}

function rememberHead(key: string, head: Head): void {
  headCache.delete(key);
  headCache.set(key, { size: head.size, etag: head.etag, at: Date.now() });
  while (headCache.size > HEAD_CACHE_MAX) headCache.delete(headCache.keys().next().value!);
}

async function headOf(r2: R2Bucket, key: string): Promise<Head> {
  const hit = freshHead(key);
  if (hit) return hit;
  const head = await withTimeout(r2.head(key), READ_TIMEOUT_MS, `R2 head ${key}`);
  if (!head) throw new Error(`R2 key not found: ${key}`);
  rememberHead(key, head);
  return head;
}

export async function asyncBufferFromR2(r2: R2Bucket, key: string): Promise<AsyncBuffer> {
  return bufferFor(r2, key, await headOf(r2, key));
}

/** How much of a file's end openParquet reads: hyparquet's first footer read. */
export const FOOTER_READ_BYTES = 1 << 19;

/** A parquet on R2 and its parsed footer. Without a remembered head, one read of
 *  the file's tail gives its size, etag and footer (a head, then a footer read,
 *  cost two round trips one after the other: a point profile opens ~30 files). */
export async function openParquet(r2: R2Bucket, key: string): Promise<{ file: AsyncBuffer; metadata: FileMetaData }> {
  const file = await openWithTail(r2, key);
  return { file, metadata: await cachedMetadata(file) };
}

/** The file, its last FOOTER_READ_BYTES already read when its head was not remembered. */
async function openWithTail(r2: R2Bucket, key: string): Promise<AsyncBuffer> {
  const head = freshHead(key);
  if (head) return bufferFor(r2, key, head);
  const read = async () => {
    const obj = await r2.get(key, { range: { suffix: FOOTER_READ_BYTES } });
    return obj && { obj, data: await obj.arrayBuffer() };
  };
  const got = await withTimeout(read(), READ_TIMEOUT_MS, `R2 read ${key} [tail]`);
  if (!got) throw new Error(`R2 key not found: ${key}`);
  rememberHead(key, got.obj);
  const base = bufferFor(r2, key, got.obj);
  const tailStart = got.obj.size - got.data.byteLength;
  return {
    ...base,
    slice: (start, end = base.byteLength) =>
      (start >= tailStart ? Promise.resolve(got.data.slice(start - tailStart, end - tailStart)) : base.slice(start, end)),
  };
}

/** A whole file, versioned (cacheKey), kept in the colo for a day. */
const WHOLE_COLO_TTL = 86_400;

/** The whole of a small file in memory, in one read, or from the colo's cache when
 *  the file was opened through one (file.colo): read whole and parsed, it is the same
 *  for every point (India's outline, 3 MB, was read again on every fresh isolate). */
export async function readWhole(file: AsyncBuffer): Promise<AsyncBuffer> {
  const ck = file.colo && file.cacheKey ? `whole/${file.cacheKey}` : null;
  const hit = ck ? await file.colo!.get(ck) : null;
  const kept = hit?.data.byteLength === file.byteLength ? hit.data : null;
  const data = kept ?? await file.slice(0, file.byteLength);
  if (ck && !kept) file.colo!.put(ck, data, {}, WHOLE_COLO_TTL);
  return { byteLength: data.byteLength, cacheKey: file.cacheKey, slice: async (s, e) => data.slice(s, e) };
}

function bufferFor(r2: R2Bucket, key: string, head: Head): AsyncBuffer {
  const byteLength = head.size;

  return {
    byteLength,
    etag: head.etag,
    cacheKey: `${key}@${byteLength}:${head.etag}`,
    colo: coloOf(r2),
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const length = (end ?? byteLength) - start;
      const read = async () => {
        const obj = await r2.get(key, { range: { offset: start, length } });
        if (!obj) throw new Error(`R2 range read failed: ${key} [${start}:${start + length}]`);
        return obj.arrayBuffer();
      };
      return withTimeout(read(), READ_TIMEOUT_MS, `R2 read ${key} [${start}:${start + length}]`);
    },
    async* stream(start: number, end: number): AsyncGenerator<Uint8Array> {
      const obj = await r2.get(key, { range: { offset: start, length: end - start } });
      if (!obj) throw new Error(`R2 range read failed: ${key} [${start}:${end}]`);
      const reader = obj.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        await reader.cancel().catch(() => {}); // stopped early: let go of the rest of the body
      }
    },
  };
}
