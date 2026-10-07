/**
 * R2-backed AsyncBuffer for hyparquet. Reads parquet files from R2
 * via range requests without loading the entire file into memory.
 */
import { parquetMetadataAsync } from 'hyparquet';
import type { FileMetaData } from 'hyparquet';
import type { CatalogLayer } from './catalog-api';

export interface AsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): Promise<ArrayBuffer>;
  /** Identifies the object version; set => its parsed footer is cached. */
  cacheKey?: string;
}

// Parsed parquet footers, per object version (key + size + etag), kept for
// the life of the Worker isolate. The Overture footer (217 row groups) took
// ~4 s to fetch and parse on every request.
const META_CACHE_MAX = 16;
const metaCache = new Map<string, Promise<FileMetaData>>();

export function clearMetadataCache(): void {
  metaCache.clear();
}

export function cachedMetadata(file: AsyncBuffer): Promise<FileMetaData> {
  const key = file.cacheKey;
  if (!key) return parquetMetadataAsync(file);
  const hit = metaCache.get(key);
  if (hit) {
    metaCache.delete(key);
    metaCache.set(key, hit); // most recently used last
    return hit;
  }
  const p = parquetMetadataAsync(file);
  metaCache.set(key, p);
  p.catch(() => metaCache.delete(key));
  while (metaCache.size > META_CACHE_MAX) metaCache.delete(metaCache.keys().next().value!);
  return p;
}

export function r2KeyFromLayer(layer: CatalogLayer): string | null {
  const url = layer.parquet?.url;
  if (!url) return null;
  return url.replace(/^https:\/\/[^/]+\//, '');
}

export async function asyncBufferFromR2(r2: R2Bucket, key: string): Promise<AsyncBuffer> {
  const head = await r2.head(key);
  if (!head) throw new Error(`R2 key not found: ${key}`);
  const byteLength = head.size;

  return {
    byteLength,
    cacheKey: `${key}@${byteLength}:${head.etag}`,
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const length = (end ?? byteLength) - start;
      const obj = await r2.get(key, { range: { offset: start, length } });
      if (!obj) throw new Error(`R2 range read failed: ${key} [${start}:${start + length}]`);
      return obj.arrayBuffer();
    },
  };
}
