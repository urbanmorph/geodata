// Parquet ZSTD pages decode through a WebAssembly zstd decoder (zstd.ts),
// several times cheaper in CPU than the pure-JS fzstd that hyparquet-compressors
// uses. It must give the same bytes as fzstd, and every parquet read in
// functions/ must use it.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { zstdCompressSync, constants } from 'node:zlib';
import { parquetMetadata, parquetReadObjects, type Compressors } from 'hyparquet';
import { compressors as jsCompressors } from 'hyparquet-compressors';
import { decompress as fzstd } from 'fzstd';
import { compressors } from '../functions/lib/zstd';

const fixtures = new URL('./fixtures/', import.meta.url);

function zstdFixtures(): string[] {
  return readdirSync(fixtures).filter((n) => {
    if (!n.endsWith('.parquet')) return false;
    const md = parquetMetadata(load(n));
    return md.row_groups.some((rg) => rg.columns.some((c) => c.meta_data?.codec === 'ZSTD'));
  });
}

function load(name: string): ArrayBuffer {
  const b = readFileSync(new URL(name, fixtures));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** Every ZSTD page a full read of the file decompresses, with its declared size. */
async function zstdPages(name: string): Promise<Array<[Uint8Array, number]>> {
  const pages: Array<[Uint8Array, number]> = [];
  const capture: Compressors = { ...jsCompressors, ZSTD: (input, n) => { pages.push([input.slice(), n]); return fzstd(input); } };
  await parquetReadObjects({ file: load(name), compressors: capture, utf8: false });
  return pages;
}

/** Bytes that compress to about half: a ramp interleaved with noise. */
function sample(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = i & 1 ? x >>> 24 : i % 251;
  }
  return out;
}

describe('zstd compressors', () => {
  it('keep the other codecs of hyparquet-compressors', () => {
    for (const codec of ['SNAPPY', 'GZIP', 'BROTLI', 'LZ4', 'LZ4_RAW'] as const) {
      expect(compressors[codec]).toBe(jsCompressors[codec]);
    }
    expect(compressors.ZSTD).not.toBe(jsCompressors.ZSTD);
  });

  it('decode the parquet fixtures\' ZSTD pages to the same bytes as fzstd', async () => {
    const names = zstdFixtures();
    expect(names.length).toBeGreaterThanOrEqual(3);
    let pages = 0;
    for (const name of names) {
      for (const [page, n] of await zstdPages(name)) {
        expect(Buffer.from(compressors.ZSTD!(page, n)).equals(fzstd(page))).toBe(true);
        pages++;
      }
    }
    expect(pages).toBeGreaterThan(10);
  });

  it('read every ZSTD fixture to the same rows as hyparquet-compressors', async () => {
    for (const name of zstdFixtures()) {
      const file = load(name);
      const want = await parquetReadObjects({ file, compressors: jsCompressors, utf8: false });
      expect(await parquetReadObjects({ file, compressors, utf8: false })).toEqual(want);
    }
  });

  // Over 9.8 MB out or 2 MB in, the decoder streams within the call; a window
  // too long for its fixed 16 MB memory (here 2^24) it refuses, and fzstd decodes it.
  it('decode large frames and frames with a window too long for the wasm buffer', () => {
    for (const [size, level, windowLog] of [[20e6, 3, 0], [3e6, 19, 0], [3e6, 1, 0], [12e6, 3, 24]]) {
      const raw = sample(size);
      const params: Record<number, number> = { [constants.ZSTD_c_compressionLevel]: level };
      if (windowLog) params[constants.ZSTD_c_windowLog] = windowLog;
      const z = new Uint8Array(zstdCompressSync(raw, { params }));
      // Buffer.equals: toEqual walks a 20 MB array element by element.
      expect(Buffer.from(compressors.ZSTD!(z, size)).equals(raw)).toBe(true);
    }
  });

  it('are what every parquet read in functions/ uses', () => {
    const dir = new URL('../functions/', import.meta.url);
    const offenders = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((n) => n.endsWith('.ts') && n !== 'lib/zstd.ts')
      .filter((n) => /from 'hyparquet-compressors'/.test(readFileSync(new URL(n, dir), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
