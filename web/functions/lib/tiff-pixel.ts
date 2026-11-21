// One pixel, every band, out of a tiled GeoTIFF over HTTP range reads: just
// enough TIFF for the SoilGrids file /api/v1/ground reads (scripts/bake_soilgrids.py):
// classic or BigTIFF, tiled, chunky (pixel-interleaved) 16-bit integer
// samples, no compression or DEFLATE, with or without the horizontal
// predictor, north-up with a ModelPixelScale + ModelTiepoint georeference.
// Anything else is refused, not misread. geotiff.js does all of this and much
// more for ~100 KB of bundle; a point read needs three range reads and a
// DEFLATE stream the runtime already has.
//
// A read: the header once (the caller keeps the TiffInfo), then this tile's
// entries of TileOffsets and TileByteCounts (two small reads in parallel),
// then the tile itself.

export interface RangeReader {
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface TiffInfo {
  le: boolean;
  bigtiff: boolean;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  tilesAcross: number;
  samples: number;
  bits: number;
  signed: boolean;
  compression: number;
  predictor: number;
  planar: number;
  /** Upper-left corner of the image (pixel-is-area), x then y. */
  origin: [number, number];
  /** Pixel size, x then y (both positive). */
  scale: [number, number];
  nodata: number | null;
  /** Where the TileOffsets and TileByteCounts arrays start, and each entry's size. */
  offsetsAt: number;
  countsAt: number;
  offsetSize: number;
  countSize: number;
}

const HEAD_BYTES = 16 * 1024;
/** A point read never fetches more than this per tile (a 64 x 64 x 25-band Int16 tile is 205 KB raw). */
const MAX_TILE_BYTES = 8 * 1024 * 1024;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

const TAG = {
  width: 256, height: 257, bits: 258, compression: 259, samples: 277, planar: 284, predictor: 317,
  tileWidth: 322, tileHeight: 323, tileOffsets: 324, tileByteCounts: 325, sampleFormat: 339,
  pixelScale: 33550, tiepoint: 33922, nodata: 42113,
} as const;

interface Entry { type: number; count: number; at: number; inline: boolean }

/** Bytes [offset, offset+length) from the header buffer when it holds them, else a range read. */
async function bytesAt(r: RangeReader, head: Uint8Array, offset: number, length: number): Promise<DataView> {
  const b = offset + length <= head.byteLength ? head.subarray(offset, offset + length) : await r.read(offset, length);
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function readUint(dv: DataView, at: number, size: number, le: boolean): number {
  if (size === 1) return dv.getUint8(at);
  if (size === 2) return dv.getUint16(at, le);
  if (size === 4) return dv.getUint32(at, le);
  return Number(dv.getBigUint64(at, le));
}

export async function readTiffInfo(r: RangeReader): Promise<TiffInfo> {
  const head = await r.read(0, HEAD_BYTES);
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const order = String.fromCharCode(head[0], head[1]);
  if (order !== 'II' && order !== 'MM') throw new Error('not a TIFF');
  const le = order === 'II';
  const version = hv.getUint16(2, le);
  if (version !== 42 && version !== 43) throw new Error(`not a TIFF (version ${version})`);
  const bigtiff = version === 43;
  const ifdAt = bigtiff ? Number(hv.getBigUint64(8, le)) : hv.getUint32(4, le);
  const countSize = bigtiff ? 8 : 2, entrySize = bigtiff ? 20 : 12, wordSize = bigtiff ? 8 : 4;

  const nv = await bytesAt(r, head, ifdAt, countSize);
  const n = readUint(nv, 0, countSize, le);
  const iv = await bytesAt(r, head, ifdAt + countSize, n * entrySize);
  const entries = new Map<number, Entry>();
  for (let i = 0; i < n; i++) {
    const p = i * entrySize;
    const tag = iv.getUint16(p, le), type = iv.getUint16(p + 2, le);
    const count = readUint(iv, p + 4, wordSize, le);
    const inline = count * (TYPE_SIZE[type] ?? 1) <= wordSize;
    const valueAt = p + 4 + wordSize;
    entries.set(tag, { type, count, inline, at: inline ? ifdAt + countSize + valueAt : readUint(iv, valueAt, wordSize, le) });
  }

  async function values(tag: number): Promise<number[] | null> {
    const e = entries.get(tag);
    if (!e) return null;
    const size = TYPE_SIZE[e.type] ?? 1;
    const dv = await bytesAt(r, head, e.at, e.count * size);
    const out: number[] = [];
    for (let i = 0; i < e.count; i++) {
      out.push(e.type === 12 ? dv.getFloat64(i * size, le) : e.type === 11 ? dv.getFloat32(i * size, le)
        : readUint(dv, i * size, size, le));
    }
    return out;
  }
  const one = async (tag: number, dflt?: number) => {
    const v = await values(tag);
    if (v?.length) return v[0];
    if (dflt === undefined) throw new Error(`TIFF lacks tag ${tag}`);
    return dflt;
  };

  const [width, height, bits, compression, samples, planar, predictor, tileWidth, tileHeight, sampleFormat] =
    await Promise.all([one(TAG.width), one(TAG.height), one(TAG.bits), one(TAG.compression, 1), one(TAG.samples, 1),
      one(TAG.planar, 1), one(TAG.predictor, 1), one(TAG.tileWidth), one(TAG.tileHeight), one(TAG.sampleFormat, 1)]);
  const [scale, tie, nodataChars] = await Promise.all([values(TAG.pixelScale), values(TAG.tiepoint), values(TAG.nodata)]);
  const offsets = entries.get(TAG.tileOffsets), counts = entries.get(TAG.tileByteCounts);

  if (bits !== 16) throw new Error(`only 16-bit samples are supported (got ${bits})`);
  if (planar !== 1 && samples > 1) throw new Error('only pixel-interleaved (chunky) TIFFs are supported');
  if (![1, 8, 32946].includes(compression)) throw new Error(`unsupported TIFF compression ${compression}`);
  if (predictor !== 1 && predictor !== 2) throw new Error(`unsupported TIFF predictor ${predictor}`);
  if (!scale || !tie || !offsets || !counts) throw new Error('TIFF lacks georeferencing or tile tables');
  if (tie[0] !== 0 || tie[1] !== 0) throw new Error('only a tiepoint at pixel (0, 0) is supported');

  const nodataText = nodataChars ? String.fromCharCode(...nodataChars.filter((c) => c !== 0)).trim() : '';
  return {
    le, bigtiff, width, height, tileWidth, tileHeight, tilesAcross: Math.ceil(width / tileWidth), samples, bits,
    signed: sampleFormat === 2, compression, predictor, planar,
    origin: [tie[3], tie[4]], scale: [scale[0], scale[1]],
    nodata: nodataText ? Number(nodataText) : null,
    offsetsAt: offsets.at, countsAt: counts.at,
    offsetSize: TYPE_SIZE[offsets.type], countSize: TYPE_SIZE[counts.type],
  };
}

/** The tile and in-tile pixel holding lng/lat, or null outside the image. */
export function pixelOf(info: TiffInfo, lng: number, lat: number):
  { tile: number; x: number; y: number; col: number; row: number } | null {
  const col = Math.floor((lng - info.origin[0]) / info.scale[0]);
  const row = Math.floor((info.origin[1] - lat) / info.scale[1]);
  if (!(col >= 0 && col < info.width && row >= 0 && row < info.height)) return null;
  const tile = Math.floor(row / info.tileHeight) * info.tilesAcross + Math.floor(col / info.tileWidth);
  return { tile, x: col % info.tileWidth, y: row % info.tileHeight, col, row };
}

/** Horizontal predictor, undone in place: each sample plus the same sample of
 *  the pixel before it, row by row, modulo 2^16. */
export function undoPredictor16(a: Uint16Array, width: number, samples: number): void {
  const rowLen = width * samples;
  for (let start = 0; start < a.length; start += rowLen) {
    for (let i = start + samples; i < start + rowLen; i++) a[i] = (a[i] + a[i - samples]) & 0xffff;
  }
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Every band's value at lng/lat (null for nodata), or null outside the image. */
export async function readPixel(r: RangeReader, info: TiffInfo, lng: number, lat: number): Promise<(number | null)[] | null> {
  const px = pixelOf(info, lng, lat);
  if (!px) return null;
  const [ov, cv] = await Promise.all([
    r.read(info.offsetsAt + px.tile * info.offsetSize, info.offsetSize),
    r.read(info.countsAt + px.tile * info.countSize, info.countSize),
  ]);
  const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const offset = readUint(view(ov), 0, info.offsetSize, info.le);
  const count = readUint(view(cv), 0, info.countSize, info.le);
  const blank = new Array<number | null>(info.samples).fill(null);
  if (!count) return blank; // a sparse tile: nothing written there
  if (count > MAX_TILE_BYTES) throw new Error(`tile of ${count} bytes is larger than a point read should fetch`);

  const raw = await r.read(offset, count);
  const bytes = info.compression === 1 ? raw : await inflate(raw);
  // Only the pixel's own row is needed, and only up to the pixel (the predictor runs left to right).
  const s = info.samples;
  const rowStart = px.y * info.tileWidth * s * 2;
  const need = (px.x + 1) * s;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + rowStart, need * 2);
  const row = new Uint16Array(need);
  for (let i = 0; i < need; i++) row[i] = dv.getUint16(i * 2, info.le);
  if (info.predictor === 2) undoPredictor16(row, px.x + 1, s);
  return Array.from(row.subarray(px.x * s), (u) => {
    const v = info.signed && u > 0x7fff ? u - 0x10000 : u;
    return v === info.nodata ? null : v;
  });
}
