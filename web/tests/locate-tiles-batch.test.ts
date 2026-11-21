import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { PMTiles, ResolvedValueCache, type Source } from 'pmtiles';
import { clearTileCache, tileAt, tilesAt } from '../functions/lib/locate';
import { tilesCovering } from '../functions/lib/nearby-tiles';
import { queryBbox } from '../functions/lib/nearby';

// A nearest-shape search reads up to 36 tiles of one layer; on Workers each R2
// read waits for one of six connections. Neighbouring tiles of a clustered
// archive sit next to each other in the file, so they are read together.
// Fixture (tippecanoe, z8-12): 12 east-west lines around 28.4-28.6N, 76.9-77.3E.
const buf = readFileSync(new URL('./fixtures/nearby-lines.pmtiles', import.meta.url));

function archive() {
  const reads: Array<[number, number]> = [];
  const source: Source = {
    getKey: () => 'k',
    getBytes: async (offset: number, length: number) => {
      reads.push([offset, length]);
      return { data: buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + length) as ArrayBuffer };
    },
  };
  return { pm: new PMTiles(source, new ResolvedValueCache()), reads };
}

beforeEach(() => clearTileCache());

describe('tilesAt', () => {
  const cover = tilesCovering(queryBbox(28.5, 77.1, 15), 12);

  it('answers exactly what tileAt answers, tile by tile', async () => {
    const one = archive();
    const each = [];
    for (const { x, y } of cover) each.push(await tileAt(one.pm, 'a.pmtiles', 12, x, y));
    clearTileCache();
    const all = await tilesAt(archive().pm, 'a.pmtiles', 12, cover);
    expect(all.map((t) => t && new Uint8Array(t))).toEqual(each.map((t) => t && new Uint8Array(t)));
    expect(all.filter(Boolean).length).toBeGreaterThan(4);
    expect(all.some((t) => t === null)).toBe(true); // a tile the archive doesn't have
  });

  it('reads the tiles in one go, not one read each', async () => {
    const { pm, reads } = archive();
    await pm.getHeader();
    reads.length = 0;
    const all = await tilesAt(pm, 'b.pmtiles', 12, cover);
    expect(all.filter(Boolean).length).toBeGreaterThan(4);
    expect(reads.length).toBe(1);
  });

  it('from a cold reader: the header and directory, then the tiles', async () => {
    const { pm, reads } = archive();
    await tilesAt(pm, 'd.pmtiles', 12, cover);
    expect(reads.length).toBe(2);
  });

  it('serves cached tiles from the cache', async () => {
    const { pm, reads } = archive();
    await tilesAt(pm, 'c.pmtiles', 12, cover);
    reads.length = 0;
    await tilesAt(pm, 'c.pmtiles', 12, cover);
    await tileAt(pm, 'c.pmtiles', 12, cover[0].x, cover[0].y);
    expect(reads).toEqual([]);
  });
});
