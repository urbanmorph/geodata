import { describe, it, expect } from 'vitest';
import { lngLatToTile, tilePointToLngLat } from '../functions/lib/tile-math';

describe('lngLatToTile', () => {
  it('converts Bengaluru to correct tile at zoom 14', () => {
    const { x, y } = lngLatToTile(77.5946, 12.9716, 14);
    expect(x).toBe(11723);
    expect(y).toBe(7596);
  });

  it('converts Delhi to correct tile at zoom 14', () => {
    const { x, y } = lngLatToTile(77.2090, 28.6139, 14);
    expect(x).toBe(11705);
    expect(y).toBe(6831);
  });

  it('handles 0,0 (null island)', () => {
    const { x, y } = lngLatToTile(0, 0, 14);
    expect(x).toBe(8192);
    expect(y).toBe(8192);
  });

  it('handles zoom 0 (single tile)', () => {
    const { x, y } = lngLatToTile(77.5, 12.9, 0);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });

  it('clamps to valid tile range', () => {
    const { x, y } = lngLatToTile(180, 0, 1);
    expect(x).toBeLessThanOrEqual(1);
    expect(y).toBeLessThanOrEqual(1);
  });
});

describe('tilePointToLngLat: the corners of a tile', () => {
  const corners = (x: number, y: number, z: number, extent = 4096) => {
    const [west, north] = tilePointToLngLat(z, x, y, 0, 0, extent);
    const [east, south] = tilePointToLngLat(z, x, y, extent, extent, extent);
    return { west, north, east, south };
  };
  it('a Bengaluru tile', () => {
    const b = corners(11723, 7596, 14);
    expect(b.west).toBeCloseTo(77.585, 2);
    expect(b.east).toBeCloseTo(77.607, 2);
    expect(b.south).toBeCloseTo(12.962, 2);
    expect(b.north).toBeCloseTo(12.983, 2);
  });
  it('tile 0/0/0 covers the world, whatever the extent', () => {
    for (const extent of [4096, 512]) {
      const b = corners(0, 0, 0, extent);
      expect(b.west).toBeCloseTo(-180, 0);
      expect(b.east).toBeCloseTo(180, 0);
      expect(b.north).toBeCloseTo(85.05, 0);
      expect(b.south).toBeCloseTo(-85.05, 0);
    }
  });
  it('a point in the tile\'s buffer (outside 0..extent) is the next tile\'s point', () => {
    const [lng, lat] = tilePointToLngLat(14, 11723, 7596, -64, 4096 + 64, 4096);
    const [lng2, lat2] = tilePointToLngLat(14, 11722, 7597, 4096 - 64, 64, 4096);
    expect(lng).toBeCloseTo(lng2, 9);
    expect(lat).toBeCloseTo(lat2, 9);
  });
});
