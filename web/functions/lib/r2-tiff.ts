// A GeoTIFF on R2 read by range (lib/tiff-pixel.ts), with its parsed header kept
// per key for the life of the isolate (keys are content-versioned, so a header
// never changes under its key).
//
// Only parsed headers are kept, never a pending read: in Workers a promise belongs
// to the request that made it, and one left in a shared cache by a request that
// ended (a client gave up, a time budget passed) never settles for the next
// request, which then hangs until the platform's limit.
import { readTiffInfo, type RangeReader, type TiffInfo } from './tiff-pixel';

const infos = new Map<string, TiffInfo>();

export function r2Reader(r2: R2Bucket, key: string): RangeReader {
  return {
    async read(offset, length) {
      const obj = await r2.get(key, { range: { offset, length } });
      if (!obj) throw new Error(`R2 key not found: ${key}`);
      return new Uint8Array(await obj.arrayBuffer());
    },
  };
}

/** The reader and header of the TIFF at `key` (the header read once per isolate). */
export function r2Tiff(r2: R2Bucket, key: string): { reader: RangeReader; info: Promise<TiffInfo> } {
  const reader = r2Reader(r2, key);
  const hit = infos.get(key);
  const info = hit ? Promise.resolve(hit) : readTiffInfo(reader).then((i) => { infos.set(key, i); return i; });
  return { reader, info };
}
