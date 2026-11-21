import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { hornSlope, demAt, populationAt, landCoverAt, pixelAreaKm2, SURFACE_RASTERS } from '../functions/lib/surface-rasters';

// Fixtures share one grid: 40 x 40, origin 70E 30N, 0.25 degree pixels.
const bucketOf = (name: string) => {
  const buf = readFileSync(new URL(`./fixtures/tiff-pixel-${name}.tif`, import.meta.url));
  return {
    get: async (_k: string, o: { range: { offset: number; length: number } }) => {
      const b = buf.buffer.slice(buf.byteOffset + o.range.offset, buf.byteOffset + o.range.offset + o.range.length);
      return { arrayBuffer: async () => b };
    },
  } as unknown as R2Bucket;
};
const lngOf = (c: number) => 70 + (c + 0.5) * 0.25;
const latOf = (r: number) => 30 - (r + 0.5) * 0.25;
const KM = 6371 * Math.PI / 180;

describe('hornSlope', () => {
  it('is 0 on flat ground and atan of the gradient on a plane', () => {
    expect(hornSlope([[5, 5, 5], [5, 5, 5], [5, 5, 5]], 30, 30)).toBe(0);
    // rises 30 m per 30 m east: 45 degrees
    expect(hornSlope([[0, 30, 60], [0, 30, 60], [0, 30, 60]], 30, 30)).toBeCloseTo(45, 6);
  });

  it('fills a missing neighbour with the centre (edge of data) and needs the centre', () => {
    expect(hornSlope([[null, 5, 5], [5, 5, 5], [5, 5, 5]], 30, 30)).toBe(0);
    expect(hornSlope([[5, 5, 5], [5, null, 5], [5, 5, 5]], 30, 30)).toBeNull();
  });
});

describe('pixelAreaKm2', () => {
  it('shrinks with the cosine of latitude', () => {
    const a0 = pixelAreaKm2(1 / 1200, 1 / 1200, 0);
    expect(a0).toBeCloseTo((KM / 1200) ** 2, 8);
    expect(pixelAreaKm2(1 / 1200, 1 / 1200, 60)).toBeCloseTo(a0 / 2, 8);
  });
});

describe('demAt', () => {
  it('reads the elevation and the slope from the 3 x 3 window, across tile edges', async () => {
    const r = await demAt(bucketOf('dem'), 'k-dem', latOf(16), lngOf(16));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data.elevation_m).toBe(100 + 160 + 320);
    const dx = 0.25 * KM * 1000 * Math.cos(latOf(16) * Math.PI / 180), dy = 0.25 * KM * 1000;
    const expected = Math.atan(Math.hypot(10 / dx, 20 / dy)) * 180 / Math.PI;
    expect(r.data.slope_deg).toBeCloseTo(Math.round(expected * 10) / 10, 6);
  });

  it('says why when there is no elevation', async () => {
    expect(await demAt(bucketOf('dem'), 'k-dem', latOf(0), lngOf(0))).toEqual({ status: 'none', reason: expect.stringMatching(/no elevation/) });
    expect(await demAt(bucketOf('dem'), null, 28, 77)).toEqual({ status: 'unavailable', reason: expect.any(String) });
  });
});

describe('populationAt', () => {
  it('turns people per pixel into people per km2', async () => {
    const r = await populationAt(bucketOf('float'), 'k-pop', latOf(7), lngOf(5));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data.people_in_pixel).toBe(285.5);
    expect(r.data.population_per_km2).toBe(Math.round(285.5 / pixelAreaKm2(0.25, 0.25, latOf(7))));
  });
});

describe('landCoverAt', () => {
  it('names the class', async () => {
    // the byte fixture holds (r + c) % 250: row 5, column 5 is 10, tree cover
    const r = await landCoverAt(bucketOf('byte'), 'k-lc', latOf(5), lngOf(5));
    expect(r).toEqual({ status: 'ok', data: { land_cover: 'Tree cover', land_cover_code: 10 } });
  });

  it('is unavailable until a file is published', async () => {
    expect(SURFACE_RASTERS.rasters.worldcover.credit.licence).toBe('CC-BY-4.0');
    expect((await landCoverAt(bucketOf('byte'), null, 1, 1)).status).toBe('unavailable');
  });
});
