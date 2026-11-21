// A GeoTIFF on R2 read by range (lib/tiff-pixel.ts), with its parsed header kept
// per key for the life of the isolate (keys are content-versioned, so a header
// never changes under its key). The header cache shares only parsed headers
// across requests (isolate-cache.ts); each R2 read has a time limit.
import { readTiffInfo, type RangeReader, type TiffInfo } from './tiff-pixel';
import { ResolvedCache, READ_TIMEOUT_MS, withTimeout } from './isolate-cache';

const infos = new ResolvedCache<TiffInfo>(64);

export function r2Reader(r2: R2Bucket, key: string): RangeReader {
  return {
    async read(offset, length) {
      const obj = await withTimeout(r2.get(key, { range: { offset, length } }), READ_TIMEOUT_MS, `R2 read of ${key}`);
      if (!obj) throw new Error(`R2 key not found: ${key}`);
      return new Uint8Array(await withTimeout(obj.arrayBuffer(), READ_TIMEOUT_MS, `R2 read of ${key}`));
    },
  };
}

/** The reader and header of the TIFF at `key` (the header read once per isolate). */
export function r2Tiff(r2: R2Bucket, key: string): { reader: RangeReader; info: Promise<TiffInfo> } {
  const reader = r2Reader(r2, key);
  return { reader, info: infos.get(key, () => readTiffInfo(reader)) };
}
