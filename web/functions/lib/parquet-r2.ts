/**
 * R2-backed AsyncBuffer for hyparquet. Reads parquet files from R2
 * via range requests without loading the entire file into memory.
 */
import { parquetMetadataAsync } from 'hyparquet';
import type { FileMetaData } from 'hyparquet';
import type { CatalogLayer } from './catalog-api';
import { r2KeyFromUrl } from './r2-keys';
import { ResolvedCache, READ_TIMEOUT_MS, withTimeout } from './isolate-cache';

export interface AsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): Promise<ArrayBuffer>;
  /** Identifies the object version; set => its parsed footer is cached. */
  cacheKey?: string;
  /** The R2 object's etag, when read from R2. */
  etag?: string;
  /** Bytes [start, end) as a stream of pieces, in one request: for reading a
   *  large page without holding it (parquet-column-stream.ts). */
  stream?(start: number, end: number): AsyncIterable<Uint8Array>;
}

// Parsed parquet footers, per object version (key + size + etag), kept for
// the life of the Worker isolate. The Overture footer (217 row groups) took
// ~4 s to fetch and parse on every request. Only parsed footers are shared
// across requests (isolate-cache.ts): a read in flight dies with its request.
const metaCache = new ResolvedCache<FileMetaData>(16);

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

async function headOf(r2: R2Bucket, key: string): Promise<{ size: number; etag: string }> {
  const now = Date.now();
  const hit = headCache.get(key);
  if (hit && now - hit.at < HEAD_TTL_MS) return hit;
  const head = await withTimeout(r2.head(key), READ_TIMEOUT_MS, `R2 head ${key}`);
  if (!head) throw new Error(`R2 key not found: ${key}`);
  headCache.delete(key);
  headCache.set(key, { size: head.size, etag: head.etag, at: now });
  while (headCache.size > HEAD_CACHE_MAX) headCache.delete(headCache.keys().next().value!);
  return head;
}

export async function asyncBufferFromR2(r2: R2Bucket, key: string): Promise<AsyncBuffer> {
  const head = await headOf(r2, key);
  const byteLength = head.size;

  return {
    byteLength,
    etag: head.etag,
    cacheKey: `${key}@${byteLength}:${head.etag}`,
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
