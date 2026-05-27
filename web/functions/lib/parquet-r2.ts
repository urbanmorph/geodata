/**
 * R2-backed AsyncBuffer for hyparquet. Reads parquet files from R2
 * via range requests without loading the entire file into memory.
 */
import type { CatalogLayer } from './catalog-api';

export interface AsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): Promise<ArrayBuffer>;
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
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const length = (end ?? byteLength) - start;
      const obj = await r2.get(key, { range: { offset: start, length } });
      if (!obj) throw new Error(`R2 range read failed: ${key} [${start}:${start + length}]`);
      return obj.arrayBuffer();
    },
  };
}
