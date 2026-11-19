/**
 * One BYTE_ARRAY column's values (a WKB geometry, say) for chosen rows of one
 * row group, without holding a page in memory.
 *
 * hyparquet decodes a whole page to return any row of it. DuckDB writes a
 * row group's geometry as one page of up to ~100 MB uncompressed (groundwater
 * prospects: 44 MB compressed, 105 MB uncompressed, 17,128 rows), so reading
 * 159 rows needed the 44 MB fetch, the 105 MB page and, as GeoJSON, every
 * row's shape: 1.5 GB in Node, against a Worker's 128 MB. Measured 18 Nov 2026.
 *
 * Here a page is streamed: page headers are read on their own, pages without
 * a wanted row are skipped unread, a page with one is fetched as a stream and
 * (ZSTD) decompressed as a stream, values are walked and only the wanted ones
 * kept, and the read stops after the last wanted row. Memory: the
 * decompressor's window plus one value.
 *
 * Supports top-level OPTIONAL/REQUIRED BYTE_ARRAY columns with PLAIN pages
 * (v1 or v2), any codec hyparquet knows (only ZSTD and UNCOMPRESSED stream;
 * the others decompress a page at a time, capped by MAX_WHOLE_PAGE_BYTES).
 */
import type { FileMetaData, Compressors } from 'hyparquet';
import { deserializeTCompactProtocol } from 'hyparquet/src/thrift.js';
import { readRleBitPackedHybrid } from 'hyparquet/src/encoding.js';
import { decompressPage } from 'hyparquet/src/datapage.js';
import { Decompress } from 'fzstd';
import type { AsyncBuffer } from './parquet-r2';

/** A non-streaming codec decompresses a page at once; refuse above this. */
export const MAX_WHOLE_PAGE_BYTES = 32 * 1024 * 1024;
const HEADER_PROBE = 1024;
const HEADER_MAX = 1024 * 1024;
const SLICE_STREAM_BYTES = 1024 * 1024;

const PAGE_TYPES = ['DATA_PAGE', 'INDEX_PAGE', 'DICTIONARY_PAGE', 'DATA_PAGE_V2'] as const;

interface PageHeader {
  type: (typeof PAGE_TYPES)[number];
  headerLength: number;
  compressedSize: number;
  uncompressedSize: number;
  rows: number;
  /** PLAIN = 0 */
  encoding: number;
  v2?: { defLength: number; repLength: number; compressed: boolean };
}

/** Bytes [start, end) as a stream of pieces: the buffer's own stream when it
 *  has one (R2: one request), else 1 MB slices. */
async function* byteRange(file: AsyncBuffer, start: number, end: number): AsyncGenerator<Uint8Array> {
  if (file.stream) {
    yield* file.stream(start, end);
    return;
  }
  for (let p = start; p < end; p += SLICE_STREAM_BYTES) {
    yield new Uint8Array(await file.slice(p, Math.min(end, p + SLICE_STREAM_BYTES)));
  }
}

async function readPageHeader(file: AsyncBuffer, pos: number, chunkEnd: number): Promise<PageHeader> {
  for (let probe = HEADER_PROBE; ; probe *= 8) {
    const end = Math.min(pos + probe, chunkEnd);
    const view = new DataView(await file.slice(pos, end));
    const reader = { view, offset: 0 };
    let h: Record<string, any>;
    try {
      h = deserializeTCompactProtocol(reader);
    } catch (e) {
      if (end === chunkEnd || probe >= HEADER_MAX) throw e;
      continue; // header longer than the probe (page statistics): read more
    }
    const v1 = h.field_5;
    const v2 = h.field_8;
    return {
      type: PAGE_TYPES[h.field_1 as number],
      headerLength: reader.offset,
      compressedSize: h.field_3,
      uncompressedSize: h.field_2,
      rows: (v2 ? v2.field_3 : v1?.field_1) ?? 0, // top-level, unrepeated: values = rows
      encoding: (v2 ? v2.field_4 : v1?.field_2) ?? 0,
      v2: v2 && { defLength: v2.field_5 ?? 0, repLength: v2.field_6 ?? 0, compressed: v2.field_7 !== false },
    };
  }
}

/** Pull-based reader over a stream of byte pieces. */
class Bytes {
  private buf = new Uint8Array(0);
  private off = 0;
  constructor(private readonly src: AsyncIterator<Uint8Array>) {}

  private async more(): Promise<boolean> {
    const { value, done } = await this.src.next();
    if (done) return false;
    const rest = this.buf.subarray(this.off);
    if (!rest.length) this.buf = value;
    else {
      const joined = new Uint8Array(rest.length + value.length);
      joined.set(rest);
      joined.set(value, rest.length);
      this.buf = joined;
    }
    this.off = 0;
    return true;
  }

  /** The next n bytes (a copy, safe to keep). */
  async take(n: number): Promise<Uint8Array> {
    while (this.buf.length - this.off < n) {
      if (!(await this.more())) throw new Error('parquet page ended early');
    }
    const out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }

  async u32(): Promise<number> {
    while (this.buf.length - this.off < 4) {
      if (!(await this.more())) throw new Error('parquet page ended early');
    }
    const b = this.buf;
    const o = this.off;
    this.off += 4;
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  async skip(n: number): Promise<void> {
    for (;;) {
      const have = this.buf.length - this.off;
      if (have >= n) { this.off += n; return; }
      n -= have;
      this.buf = new Uint8Array(0);
      this.off = 0;
      if (!(await this.more())) throw new Error('parquet page ended early');
    }
  }

  /** What is left: the buffered bytes, then the rest of the source. */
  async* rest(): AsyncGenerator<Uint8Array> {
    try {
      if (this.off < this.buf.length) yield this.buf.subarray(this.off);
      this.buf = new Uint8Array(0);
      this.off = 0;
      for (;;) {
        const { value, done } = await this.src.next();
        if (done) return;
        yield value;
      }
    } finally {
      await this.close();
    }
  }

  /** Stop the source (and the fetch behind it). */
  async close(): Promise<void> {
    await this.src.return?.(undefined);
  }
}

/** Decompressed pieces of a compressed page stream. */
async function* inflate(
  codec: string, src: AsyncIterable<Uint8Array>, uncompressedSize: number, compressors: Compressors | undefined,
): AsyncGenerator<Uint8Array> {
  if (codec === 'UNCOMPRESSED') {
    yield* src;
  } else if (codec === 'ZSTD') {
    const out: Uint8Array[] = [];
    const z = new Decompress((piece) => { if (piece.length) out.push(piece); });
    for await (const piece of src) {
      z.push(piece);
      while (out.length) yield out.shift()!;
    }
  } else {
    if (uncompressedSize > MAX_WHOLE_PAGE_BYTES) {
      throw new Error(`a ${codec} page of ${uncompressedSize} bytes is too large to read here`);
    }
    const parts: Uint8Array[] = [];
    let n = 0;
    for await (const piece of src) { parts.push(piece); n += piece.length; }
    const all = new Uint8Array(n);
    n = 0;
    for (const p of parts) { all.set(p, n); n += p.length; }
    yield decompressPage(all, uncompressedSize, codec as never, compressors);
  }
}

function decodeLevels(bytes: Uint8Array, rows: number, maxDef: number): Uint8Array {
  const levels = new Uint8Array(rows);
  const width = 32 - Math.clz32(maxDef);
  readRleBitPackedHybrid({ view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 },
    width, levels as never, bytes.length);
  return levels;
}

/**
 * The values of top-level BYTE_ARRAY `column` at `rows` (sorted, absolute row
 * numbers inside row group `group`), in order: raw bytes, or null for a null.
 */
export async function* byteArrayColumnRows(
  file: AsyncBuffer,
  metadata: FileMetaData,
  group: number,
  column: string,
  rows: number[],
  compressors?: Compressors,
): AsyncGenerator<Uint8Array | null> {
  if (!rows.length) return;
  const rg = metadata.row_groups[group];
  const groupStart = metadata.row_groups.slice(0, group).reduce((n, g) => n + Number(g.num_rows), 0);
  const chunk = rg.columns.find((c) => c.meta_data?.path_in_schema.length === 1 && c.meta_data.path_in_schema[0] === column);
  const element = metadata.schema.find((s, i) => i > 0 && s.name === column && !s.num_children);
  if (!chunk?.meta_data || !element) throw new Error(`no column ${column} in row group ${group}`);
  if (element.type !== 'BYTE_ARRAY' || element.repetition_type === 'REPEATED') {
    throw new Error(`column ${column} is not a plain BYTE_ARRAY column`);
  }
  const meta = chunk.meta_data;
  const maxDef = element.repetition_type === 'OPTIONAL' ? 1 : 0;
  let pos = Number(meta.dictionary_page_offset ?? meta.data_page_offset);
  const chunkEnd = pos + Number(meta.total_compressed_size);

  let next = 0; // index into rows of the next wanted row
  let pageStart = groupStart;
  while (next < rows.length && pos < chunkEnd) {
    const h = await readPageHeader(file, pos, chunkEnd);
    const bodyStart = pos + h.headerLength;
    pos = bodyStart + h.compressedSize;
    if (h.type === 'DICTIONARY_PAGE') throw new Error(`column ${column} is dictionary-encoded, not PLAIN`);
    if (h.type !== 'DATA_PAGE' && h.type !== 'DATA_PAGE_V2') continue;
    const pageEnd = pageStart + h.rows;
    if (rows[next] >= pageEnd) { pageStart = pageEnd; continue; } // nothing wanted here: never fetched
    if (h.encoding !== 0) throw new Error(`column ${column} page encoding ${h.encoding} is not PLAIN`);

    const raw = new Bytes(byteRange(file, bodyStart, bodyStart + h.compressedSize)[Symbol.asyncIterator]());
    let levels: Uint8Array | null = null;
    let values: Bytes;
    if (h.v2) {
      await raw.skip(h.v2.repLength);
      const defBytes = await raw.take(h.v2.defLength);
      if (maxDef) levels = decodeLevels(defBytes, h.rows, maxDef);
      const valuesSize = h.uncompressedSize - h.v2.defLength - h.v2.repLength;
      values = new Bytes((h.v2.compressed ? inflate(meta.codec, raw.rest(), valuesSize, compressors) : raw.rest())[Symbol.asyncIterator]());
    } else {
      values = new Bytes(inflate(meta.codec, raw.rest(), h.uncompressedSize, compressors)[Symbol.asyncIterator]());
      if (maxDef) levels = decodeLevels(await values.take(await values.u32()), h.rows, maxDef);
    }
    try {
      for (let r = pageStart; next < rows.length && rows[next] < pageEnd; r++) {
        const isNull = levels !== null && levels[r - pageStart] < maxDef;
        const wanted = rows[next] === r;
        if (isNull) {
          if (wanted) { next++; yield null; }
          continue;
        }
        const len = await values.u32();
        if (wanted) { next++; yield await values.take(len); } else await values.skip(len);
      }
    } finally {
      await values.close(); // stop reading the page, and its fetch, after the last wanted row
      await raw.close();
    }
    pageStart = pageEnd;
  }
  if (next < rows.length) throw new Error(`row ${rows[next]} is past the end of column ${column} in row group ${group}`);
}
