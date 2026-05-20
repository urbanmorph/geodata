import { describe, it, expect } from 'vitest';
import { parseWKB } from '../src/db';

// Helpers to build ISO WKB blobs byte-by-byte. Little-endian (typical for parquet output).
function wkbBuilder() {
  const bytes: number[] = [];
  return {
    le() {
      bytes.push(1);
      return this;
    },
    uint32(n: number) {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n, 0);
      bytes.push(...b);
      return this;
    },
    double(n: number) {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(n, 0);
      bytes.push(...b);
      return this;
    },
    pt(x: number, y: number) {
      return this.double(x).double(y);
    },
    build(): Uint8Array {
      return Uint8Array.from(bytes);
    },
  };
}

describe('parseWKB', () => {
  it('decodes a Point', () => {
    const buf = wkbBuilder().le().uint32(1).pt(77.5946, 12.9716).build();
    const geom = parseWKB(buf);
    expect(geom).toEqual({ type: 'Point', coordinates: [77.5946, 12.9716] });
  });

  it('decodes a LineString', () => {
    const buf = wkbBuilder().le().uint32(2).uint32(3).pt(0, 0).pt(1, 1).pt(2, 0).build();
    const geom = parseWKB(buf);
    expect(geom).toEqual({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
    });
  });

  it('decodes a Polygon (single ring)', () => {
    const buf = wkbBuilder()
      .le()
      .uint32(3) // Polygon
      .uint32(1) // 1 ring
      .uint32(4) // 4 points
      .pt(0, 0)
      .pt(1, 0)
      .pt(1, 1)
      .pt(0, 0)
      .build();
    const geom = parseWKB(buf) as { type: 'Polygon'; coordinates: number[][][] };
    expect(geom.type).toBe('Polygon');
    expect(geom.coordinates).toHaveLength(1);
    expect(geom.coordinates[0]).toHaveLength(4);
  });

  it('decodes a Polygon with a hole', () => {
    const buf = wkbBuilder()
      .le()
      .uint32(3)
      .uint32(2) // 2 rings
      .uint32(4)
      .pt(0, 0).pt(10, 0).pt(10, 10).pt(0, 0)
      .uint32(4)
      .pt(2, 2).pt(8, 2).pt(8, 8).pt(2, 2)
      .build();
    const geom = parseWKB(buf) as { type: 'Polygon'; coordinates: number[][][] };
    expect(geom.coordinates).toHaveLength(2);
  });

  it('decodes a MultiPolygon (two parts)', () => {
    const inner = (offX: number) =>
      wkbBuilder()
        .le()
        .uint32(3)
        .uint32(1)
        .uint32(4)
        .pt(offX, 0).pt(offX + 1, 0).pt(offX + 1, 1).pt(offX, 0)
        .build();
    const a = Array.from(inner(0));
    const b = Array.from(inner(5));
    const buf = Uint8Array.from([
      ...Array.from(wkbBuilder().le().uint32(6).uint32(2).build()),
      ...a,
      ...b,
    ]);
    const geom = parseWKB(buf) as { type: 'MultiPolygon'; coordinates: unknown[] };
    expect(geom.type).toBe('MultiPolygon');
    expect(geom.coordinates).toHaveLength(2);
  });

  it('decodes a GeometryCollection of two points', () => {
    const inner = (x: number, y: number) =>
      Array.from(wkbBuilder().le().uint32(1).pt(x, y).build());
    const buf = Uint8Array.from([
      ...Array.from(wkbBuilder().le().uint32(7).uint32(2).build()),
      ...inner(0, 0),
      ...inner(1, 1),
    ]);
    const geom = parseWKB(buf) as { type: 'GeometryCollection'; geometries: unknown[] };
    expect(geom.type).toBe('GeometryCollection');
    expect(geom.geometries).toHaveLength(2);
  });

  it('handles ISO Z-coordinates by skipping the Z value', () => {
    // ISO WKB encodes 3D Point with type 1001 (Z flag in 1000-1999 range)
    const buf = wkbBuilder().le().uint32(1001).pt(77, 28).double(100).build();
    const geom = parseWKB(buf) as { type: 'Point'; coordinates: [number, number] };
    expect(geom.type).toBe('Point');
    expect(geom.coordinates).toEqual([77, 28]);
  });

  it('throws on an unknown WKB type', () => {
    const buf = wkbBuilder().le().uint32(99).build();
    expect(() => parseWKB(buf)).toThrow('unsupported WKB type');
  });
});
