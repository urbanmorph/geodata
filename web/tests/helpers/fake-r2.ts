// An R2 bucket over local files (head + ranged get), recording each get's byte
// range, for routes and libs that read parquet or pmtiles from env.R2.
export function fakeR2(objects: Record<string, Buffer>, gets: Array<[string, number, number]> = []): R2Bucket {
  return {
    head: async (k: string) => (objects[k] ? { size: objects[k].byteLength, etag: `e-${k}` } : null),
    get: async (k: string, opts?: { range?: { offset: number; length: number } }) => {
      const buf = objects[k];
      if (!buf) return null;
      const { offset = 0, length = buf.byteLength } = opts?.range ?? {};
      gets.push([k, offset, offset + length]);
      const ab = buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + length) as ArrayBuffer;
      return { arrayBuffer: async () => ab, body: new Response(ab).body, etag: `e-${k}` };
    },
  } as unknown as R2Bucket;
}
