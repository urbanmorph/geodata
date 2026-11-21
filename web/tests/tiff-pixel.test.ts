import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readTiffInfo, pixelOf, readPixel, readWindow, undoPredictor16, type RangeReader } from '../functions/lib/tiff-pixel';

// Fixtures (GDAL COG, 40 x 40 px, 3 Int16 bands pixel-interleaved, 16 x 16
// tiles, DEFLATE + horizontal predictor, origin 70E 30N, 0.25 degree pixels):
// band b at row r, column c holds b*1000 + r*40 + c, and pixel (0, 0) is
// nodata (-32768). One classic TIFF, one BigTIFF.
const FIXTURES = {
  classic: readFileSync(new URL('./fixtures/tiff-pixel-cog.tif', import.meta.url)),
  bigtiff: readFileSync(new URL('./fixtures/tiff-pixel-bigtiff.tif', import.meta.url)),
};

function reader(buf: Buffer): RangeReader & { reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  return {
    reads,
    read: async (offset: number, length: number) => {
      reads.push([offset, length]);
      return new Uint8Array(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + length));
    },
  };
}

const lngOf = (c: number) => 70 + (c + 0.5) * 0.25;
const latOf = (r: number) => 30 - (r + 0.5) * 0.25;

describe.each(Object.entries(FIXTURES))('tiff-pixel (%s)', (_name, buf) => {
  it('reads the size, tiling, bands, compression, geotransform and nodata', async () => {
    const info = await readTiffInfo(reader(buf));
    expect(info).toMatchObject({
      width: 40, height: 40, tileWidth: 16, tileHeight: 16, samples: 3, bits: 16,
      compression: 8, predictor: 2, planar: 1, signed: true, nodata: -32768,
      origin: [70, 30], scale: [0.25, 0.25], tilesAcross: 3,
    });
  });

  it('addresses a lng/lat to its tile and the pixel inside it', async () => {
    const info = await readTiffInfo(reader(buf));
    expect(pixelOf(info, lngOf(25), latOf(17))).toEqual({ tile: 1 * 3 + 1, x: 25 - 16, y: 17 - 16, col: 25, row: 17 });
    expect(pixelOf(info, lngOf(0), latOf(0))).toMatchObject({ tile: 0, x: 0, y: 0 });
    expect(pixelOf(info, lngOf(39), latOf(39))).toMatchObject({ tile: 8, x: 39 - 32, y: 39 - 32 });
    expect(pixelOf(info, 69.9, 29)).toBeNull();
    expect(pixelOf(info, 80.01, 29)).toBeNull();
    expect(pixelOf(info, 75, 30.01)).toBeNull();
  });

  it('reads every band of one pixel, as GDAL does', async () => {
    const r = reader(buf);
    const info = await readTiffInfo(r);
    expect(await readPixel(r, info, lngOf(25), latOf(17))).toEqual([1705, 2705, 3705]);
    expect(await readPixel(r, info, lngOf(39), latOf(39))).toEqual([1000 + 39 * 40 + 39, 2000 + 1599, 3000 + 1599]);
    expect(await readPixel(r, info, lngOf(17), latOf(0))).toEqual([1017, 2017, 3017]);
  });

  it('says null for nodata and outside the image', async () => {
    const r = reader(buf);
    const info = await readTiffInfo(r);
    expect(await readPixel(r, info, lngOf(0), latOf(0))).toEqual([null, null, null]);
    expect(await readPixel(r, info, 60, 20)).toBeNull();
  });

  it('reads a pixel with two small offset reads and one tile read (header cached by the caller)', async () => {
    const r = reader(buf);
    const info = await readTiffInfo(r);
    r.reads.length = 0;
    await readPixel(r, info, lngOf(25), latOf(17));
    expect(r.reads).toHaveLength(3);
    expect(r.reads[0][1]).toBe(info.offsetSize);
    expect(r.reads[1][1]).toBe(info.countSize);
    expect(info.offsetSize).toBe(info.bigtiff ? 8 : 4);
  });
});

// Single-band fixtures (40 x 40, 16 px tiles, same grid): Byte (r + c) % 250,
// Float32 r * 40 + c + 0.5 (nodata -99999), Int16 plane 100 + 10c + 20r with
// predictor (nodata at (0, 0)).
const one = (name: string) => readFileSync(new URL(`./fixtures/tiff-pixel-${name}.tif`, import.meta.url));

describe('tiff-pixel: other sample types', () => {
  it('reads Byte', async () => {
    const r = reader(one('byte'));
    const info = await readTiffInfo(r);
    expect(info).toMatchObject({ bits: 8, samples: 1, float: false });
    expect(await readPixel(r, info, lngOf(25), latOf(17))).toEqual([42]);
  });

  it('reads Float32', async () => {
    const r = reader(one('float'));
    const info = await readTiffInfo(r);
    expect(info).toMatchObject({ bits: 32, float: true, nodata: -99999 });
    expect(await readPixel(r, info, lngOf(5), latOf(7))).toEqual([285.5]);
  });
});

describe('readWindow', () => {
  it('reads the 3 x 3 pixels around a point, across tile edges', async () => {
    const r = reader(one('dem'));
    const info = await readTiffInfo(r);
    // (16, 16) is a tile corner: its neighbours sit in four tiles
    const w = await readWindow(r, info, lngOf(16), latOf(16), 1);
    expect(w).toEqual([
      [100 + 150 + 300, 100 + 160 + 300, 100 + 170 + 300],
      [100 + 150 + 320, 100 + 160 + 320, 100 + 170 + 320],
      [100 + 150 + 340, 100 + 160 + 340, 100 + 170 + 340],
    ]);
  });

  it('gives null for pixels off the image or at nodata', async () => {
    const r = reader(one('dem'));
    const info = await readTiffInfo(r);
    const w = await readWindow(r, info, lngOf(0), latOf(0), 1);
    expect(w![0]).toEqual([null, null, null]);
    expect(w![1][0]).toBeNull();
    expect(w![1][1]).toBeNull(); // nodata
    expect(w![1][2]).toBe(110);
  });
});

describe('undoPredictor16', () => {
  it('adds each sample to the same sample of the pixel before it, per row, wrapping at 16 bits', () => {
    // 2 samples per pixel, rows of 3 pixels, 2 rows
    const row = (a: number[]) => a;
    const diffs = new Uint16Array([...row([10, 20, 1, 2, 0xffff, 1]), ...row([5, 6, 1, 1, 1, 1])]);
    undoPredictor16(diffs, 3, 2);
    expect([...diffs]).toEqual([10, 20, 11, 22, 10, 23, 5, 6, 6, 7, 7, 8]);
  });
});
