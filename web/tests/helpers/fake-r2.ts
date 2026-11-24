// An R2 bucket over local files (head + ranged get, offset/length or suffix, with
// the object's size and etag as R2 gives them), recording each get's byte range,
// for routes and libs that read parquet or pmtiles from env.R2. The etag follows the
// bytes, so replacing an object in `objects` is an overwrite; `onlyIf.etagMatches`
// that fails answers as R2 does: the object's metadata, no body.
import { createHash } from 'node:crypto';

const etagOf = (k: string, b: Buffer) => `e-${k}-${createHash('md5').update(b).digest('hex').slice(0, 8)}`;

export function fakeR2(objects: Record<string, Buffer>, gets: Array<[string, number, number]> = []): R2Bucket {
  return {
    head: async (k: string) => (objects[k] ? { size: objects[k].byteLength, etag: etagOf(k, objects[k]) } : null),
    get: async (k: string, opts?: { range?: { offset?: number; length?: number; suffix?: number }; onlyIf?: { etagMatches?: string } }) => {
      const buf = objects[k];
      if (!buf) return null;
      const etag = etagOf(k, buf);
      if (opts?.onlyIf?.etagMatches !== undefined && opts.onlyIf.etagMatches !== etag) return { etag, size: buf.byteLength }; // no body: R2's answer to a failed precondition
      const r = opts?.range ?? {};
      const offset = r.suffix !== undefined ? Math.max(0, buf.byteLength - r.suffix) : (r.offset ?? 0);
      const end = r.suffix !== undefined ? buf.byteLength : offset + (r.length ?? buf.byteLength - offset);
      gets.push([k, offset, end]);
      const ab = buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + end) as ArrayBuffer;
      return { arrayBuffer: async () => ab, body: new Response(ab).body, etag, size: buf.byteLength };
    },
  } as unknown as R2Bucket;
}
