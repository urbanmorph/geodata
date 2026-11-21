import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SOILGRIDS, soilBands, decodeSoil, soilAt } from '../functions/lib/soilgrids';
import { readTiffInfo } from '../functions/lib/tiff-pixel';

describe('SoilGrids bands and units', () => {
  it('lists the bands in file order, as scripts/bake_soilgrids.py writes them', () => {
    const b = soilBands();
    expect(b).toHaveLength(25);
    expect(b[0]).toEqual({ property: 'clay', depth: '0-5cm' });
    expect(b[7]).toEqual({ property: 'nitrogen', depth: '0-5cm' });
    expect(b[8]).toEqual({ property: 'clay', depth: '5-15cm' });
    expect(b[24]).toEqual({ property: 'wrb', depth: null });
  });

  it("applies ISRIC's conversion factors and names each field with its unit", () => {
    // clay 247 g/kg, sand 300, silt 453, pH 78 (x10), soc 52 dg/kg, bdod 145 cg/cm3, cec 189 mmol(c)/kg, N 87 cg/kg
    const depth = [247, 300, 453, 78, 52, 145, 189, 87];
    const vals = [...depth, ...depth, ...depth, 6];
    const soil = decodeSoil(vals);
    expect(soil).not.toBeNull();
    expect(soil!.depths!['0-5cm']).toEqual({
      clay_pct: 24.7, sand_pct: 30, silt_pct: 45.3, ph_water: 7.8, soc_g_per_kg: 5.2,
      bulk_density_g_per_cm3: 1.45, cec_cmolc_per_kg: 18.9, nitrogen_g_per_kg: 0.87,
    });
    expect(Object.keys(soil!.depths!)).toEqual(['0-5cm', '5-15cm', '15-30cm']);
    expect(soil!.wrb_class).toBe('Cambisols');
  });

  it('keeps a missing value null and an unknown WRB code null', () => {
    const vals: (number | null)[] = new Array(25).fill(100);
    vals[0] = null;
    vals[24] = 99;
    const soil = decodeSoil(vals)!;
    expect(soil.depths!['0-5cm'].clay_pct).toBeNull();
    expect(soil.wrb_class).toBeNull();
  });

  it('built-up land: no properties (SoilGrids masks it) but a WRB class is still mapped', () => {
    const vals: (number | null)[] = new Array(25).fill(null);
    vals[24] = 29;
    expect(decodeSoil(vals)).toEqual({ depths: null, wrb_class: 'Vertisols' });
  });

  it('is null when every band is nodata (water, built-up land, outside the land mask)', () => {
    expect(decodeSoil(new Array(25).fill(null))).toBeNull();
  });

  it('carries the ISRIC credit and CC BY 4.0', () => {
    expect(SOILGRIDS.source.name).toBe('ISRIC SoilGrids 2.0 (Poggio et al. 2021)');
    expect(SOILGRIDS.source.licence).toBe('CC-BY-4.0');
  });
});

describe('soilAt', () => {
  const fixture = readFileSync(new URL('./fixtures/tiff-pixel-cog.tif', import.meta.url));
  const bucket = {
    get: async (_key: string, opts: { range: { offset: number; length: number } }) => {
      const { offset, length } = opts.range;
      const b = fixture.buffer.slice(fixture.byteOffset + offset, fixture.byteOffset + offset + length);
      return { arrayBuffer: async () => b };
    },
  } as unknown as R2Bucket;

  it('reads the pixel and decodes it (bands beyond the file read as null)', async () => {
    const r = await soilAt(bucket, 'k', 30 - 17.5 * 0.25, 70 + 25.5 * 0.25);
    expect(r.status).toBe('ok');
    // the fixture has 3 bands: clay 1705 g/kg, sand 2705, silt 3705
    if (r.status === 'ok') expect(r.soil.depths!['0-5cm'].clay_pct).toBe(170.5);
  });

  it('says why when there is no value', async () => {
    const r = await soilAt(bucket, 'k', 30 - 0.5 * 0.25, 70 + 0.5 * 0.25);
    expect(r).toEqual({ status: 'none', reason: expect.stringMatching(/no SoilGrids prediction/) });
    const out = await soilAt(bucket, 'k', 10, 90);
    expect(out).toEqual({ status: 'none', reason: expect.stringMatching(/outside/) });
  });

  it('is unavailable (not a throw) when no file is registered', async () => {
    const r = await soilAt(bucket, null, 28, 77);
    expect(r).toEqual({ status: 'unavailable', reason: expect.any(String) });
  });

  it('keeps the parsed header per key', async () => {
    let reads = 0;
    const counting = { get: async (k: string, o: { range: { offset: number; length: number } }) => { reads++; return (bucket as unknown as { get: typeof counting.get }).get(k, o); } } as unknown as R2Bucket;
    await soilAt(counting, 'k2', 29, 75);
    const first = reads;
    reads = 0;
    await soilAt(counting, 'k2', 29, 75);
    expect(reads).toBe(3);
    expect(first).toBeGreaterThan(3);
    expect((await readTiffInfo({ read: async () => new Uint8Array(fixture) })).samples).toBe(3);
  });
});
