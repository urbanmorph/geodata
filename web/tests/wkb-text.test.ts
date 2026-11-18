// A shape's GeoJSON or KML written straight from its WKB, in pieces: one
// groundwater prospect polygon is 145,000 points (5.5 MB of GeoJSON), and
// building it as objects then text took ~25 MB of a 128 MB Worker. The text
// must be exactly what the object route gave.
import { describe, it, expect } from 'vitest';
import { parseWKB, wkbToText } from '../functions/lib/wkb-geojson';
import { geometryToKML } from '../../shared/kml.mjs';

const le = (type: number) => [1, ...u32(type)];
function u32(n: number): number[] {
  const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return [...b];
}
function f64(...xs: number[]): number[] {
  return xs.flatMap((x) => { const b = Buffer.alloc(8); b.writeDoubleLE(x); return [...b]; });
}
const pts = (n: number, x0 = 0) => Array.from({ length: n }, (_, i) => [x0 + i * 0.5, 12.25 + i / 3]);
const ringBytes = (p: number[][]) => [...u32(p.length), ...p.flatMap(([x, y]) => f64(x, y))];
const point = (x: number, y: number) => [...le(1), ...f64(x, y)];
const line = (p: number[][]) => [...le(2), ...ringBytes(p)];
const polygon = (rings: number[][][]) => [...le(3), ...u32(rings.length), ...rings.flatMap(ringBytes)];
const multi = (type: number, parts: number[][]) => [...le(type), ...u32(parts.length), ...parts.flat()];
const closed = (p: number[][]) => [...p, p[0]];

const cases: Record<string, number[]> = {
  point: point(77.5946, 12.9716),
  line: line(pts(5)),
  polygon: polygon([closed(pts(6))]),
  polygonWithHoles: polygon([closed(pts(8)), closed(pts(4, 1)), closed(pts(4, 2))]),
  multiPoint: multi(4, [point(1, 2), point(3, 4)]),
  multiLine: multi(5, [line(pts(3)), line(pts(2, 9))]),
  multiPolygon: multi(6, [polygon([closed(pts(5)), closed(pts(4, 1))]), polygon([closed(pts(4, 7))])]),
  collection: multi(7, [point(1, 2), line(pts(3)), polygon([closed(pts(4))])]),
  pointZ: [...le(1001), ...f64(77, 28, 100)],
  ewkbSrid: [...le(0x20000003), ...u32(4326), ...u32(1), ...ringBytes(closed(pts(4)))],
};

const text = (b: Uint8Array, f: 'geojson' | 'kml', piece?: number) => [...wkbToText(b, f, piece)].join('');

describe('wkbToText', () => {
  for (const [name, bytes] of Object.entries(cases)) {
    const buf = Uint8Array.from(bytes);
    it(`${name}: GeoJSON equals JSON.stringify(parseWKB) and KML equals geometryToKML(parseWKB)`, () => {
      expect(text(buf, 'geojson')).toBe(JSON.stringify(parseWKB(buf)));
      expect(text(buf, 'kml')).toBe(geometryToKML(parseWKB(buf)));
    });
  }

  it('a big shape comes out in pieces of about the given size, with the same text', () => {
    const buf = Uint8Array.from(polygon([closed(pts(20_000))]));
    const pieces = [...wkbToText(buf, 'geojson', 4096)];
    expect(pieces.length).toBeGreaterThan(50);
    expect(Math.max(...pieces.map((p) => p.length))).toBeLessThan(4096 + 100);
    expect(pieces.join('')).toBe(JSON.stringify(parseWKB(buf)));
    expect([...wkbToText(buf, 'kml', 4096)].join('')).toBe(geometryToKML(parseWKB(buf)));
  });

  it('a non-finite coordinate is null in GeoJSON, as JSON.stringify writes it', () => {
    const buf = Uint8Array.from(point(NaN, NaN)); // an empty point
    expect(text(buf, 'geojson')).toBe('{"type":"Point","coordinates":[null,null]}');
  });

  it('throws on a truncated or unknown shape rather than writing half of it', () => {
    expect(() => text(Uint8Array.from(line(pts(5))).subarray(0, 30), 'geojson')).toThrow();
    expect(() => text(Uint8Array.from(le(99)), 'geojson')).toThrow(/unsupported WKB type/);
  });
});
