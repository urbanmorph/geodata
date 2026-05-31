import { describe, it, expect } from 'vitest';
import { queryBbox, haversineKm } from '../functions/lib/nearby';
import { wkbCentroid, geoJSONCentroid, extractCentroid } from '../functions/lib/wkb-centroid';

describe('queryBbox', () => {
  it('produces a roughly square bbox at the equator', () => {
    const b = queryBbox(0, 80, 100);
    const dxLng = b.xmax - b.xmin;
    const dyLat = b.ymax - b.ymin;
    expect(dxLng).toBeCloseTo(dyLat, 1);
  });

  it('expands lng range at high latitude (Kashmir)', () => {
    const b = queryBbox(34, 75, 100);
    const dxLng = b.xmax - b.xmin;
    const dyLat = b.ymax - b.ymin;
    expect(dxLng / dyLat).toBeCloseTo(1 / Math.cos(34 * Math.PI / 180), 1);
  });

  it('100km radius is roughly 0.9 degrees lat', () => {
    const b = queryBbox(12.97, 77.59, 100);
    expect(b.ymax - b.ymin).toBeCloseTo(2 * 100 / 111.32, 2);
  });
});

describe('haversineKm', () => {
  it('Bangalore to Mysore is ~140 km', () => {
    const d = haversineKm(12.9716, 77.5946, 12.2958, 76.6394);
    expect(d).toBeGreaterThan(125);
    expect(d).toBeLessThan(150);
  });

  it('zero distance for same point', () => {
    expect(haversineKm(12.97, 77.59, 12.97, 77.59)).toBe(0);
  });

  it('Mumbai to Delhi is ~1150 km', () => {
    const d = haversineKm(19.0760, 72.8777, 28.6139, 77.2090);
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1200);
  });
});

// Build a tiny WKB blob by hand: ISO Point (lng=77.5946, lat=12.9716)
function wkbPoint(lng: number, lat: number, le = true): Uint8Array {
  const buf = new ArrayBuffer(21);
  const dv = new DataView(buf);
  dv.setUint8(0, le ? 1 : 0);
  dv.setUint32(1, 1, le);  // type 1 = Point
  dv.setFloat64(5, lng, le);
  dv.setFloat64(13, lat, le);
  return new Uint8Array(buf);
}

// WKB Polygon: 1 ring with 4 corners (unit square around centroid)
function wkbSquarePolygon(cx: number, cy: number, half: number): Uint8Array {
  // header(5) + ring_count(4) + point_count(4) + 4 * 16-byte points = 77 bytes
  const buf = new ArrayBuffer(77);
  const dv = new DataView(buf);
  const le = true;
  dv.setUint8(0, 1);
  dv.setUint32(1, 3, le);  // type 3 = Polygon
  dv.setUint32(5, 1, le);  // 1 ring
  dv.setUint32(9, 4, le);  // 4 points
  const pts: [number, number][] = [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
  ];
  let p = 13;
  for (const [x, y] of pts) {
    dv.setFloat64(p, x, le); p += 8;
    dv.setFloat64(p, y, le); p += 8;
  }
  return new Uint8Array(buf);
}

describe('wkbCentroid', () => {
  it('extracts a Point centroid exactly', () => {
    const c = wkbCentroid(wkbPoint(77.5946, 12.9716));
    expect(c).not.toBeNull();
    expect(c![0]).toBeCloseTo(77.5946, 6);
    expect(c![1]).toBeCloseTo(12.9716, 6);
  });

  it('extracts a Point centroid from big-endian WKB', () => {
    const buf = new ArrayBuffer(21);
    const dv = new DataView(buf);
    dv.setUint8(0, 0);  // big-endian flag
    dv.setUint32(1, 1, false);  // type 1 = Point, BE
    dv.setFloat64(5, 77.5946, false);
    dv.setFloat64(13, 12.9716, false);
    const c = wkbCentroid(new Uint8Array(buf));
    expect(c![0]).toBeCloseTo(77.5946, 6);
    expect(c![1]).toBeCloseTo(12.9716, 6);
  });

  it('averages a square Polygon to its center', () => {
    const c = wkbCentroid(wkbSquarePolygon(77, 13, 0.5));
    expect(c![0]).toBeCloseTo(77, 6);
    expect(c![1]).toBeCloseTo(13, 6);
  });

  it('returns null on truncated input', () => {
    const c = wkbCentroid(new Uint8Array([1, 1, 0, 0, 0]));  // header only, no coords
    expect(c).toBeNull();
  });

  it('returns null on unsupported type', () => {
    const buf = new ArrayBuffer(5);
    const dv = new DataView(buf);
    dv.setUint8(0, 1);
    dv.setUint32(1, 99, true);
    expect(wkbCentroid(new Uint8Array(buf))).toBeNull();
  });
});

describe('geoJSONCentroid', () => {
  it('extracts a Point', () => {
    const c = geoJSONCentroid({ type: 'Point', coordinates: [77.5946, 12.9716] });
    expect(c![0]).toBeCloseTo(77.5946, 6);
    expect(c![1]).toBeCloseTo(12.9716, 6);
  });

  it('averages a Polygon ring', () => {
    const c = geoJSONCentroid({ type: 'Polygon', coordinates: [[[76, 12], [78, 12], [78, 14], [76, 14], [76, 12]]] });
    expect(c![0]).toBeCloseTo(76.8, 1);
    expect(c![1]).toBeCloseTo(12.8, 1);
  });

  it('handles 3D coordinates (GeoParquet sometimes adds a Z)', () => {
    const c = geoJSONCentroid({ type: 'Point', coordinates: [77, 13, 100] });
    expect(c![0]).toBeCloseTo(77, 6);
    expect(c![1]).toBeCloseTo(13, 6);
  });

  it('returns null for null/empty geometry', () => {
    expect(geoJSONCentroid(null)).toBeNull();
    expect(geoJSONCentroid({})).toBeNull();
  });
});

describe('extractCentroid (multi-format dispatch)', () => {
  it('routes Uint8Array → wkbCentroid', () => {
    const wkb = (() => {
      const b = new ArrayBuffer(21); const dv = new DataView(b);
      dv.setUint8(0, 1); dv.setUint32(1, 1, true);
      dv.setFloat64(5, 80, true); dv.setFloat64(13, 20, true);
      return new Uint8Array(b);
    })();
    const c = extractCentroid(wkb);
    expect(c![0]).toBeCloseTo(80, 6);
  });

  it('routes GeoJSON object → geoJSONCentroid', () => {
    const c = extractCentroid({ type: 'Point', coordinates: [80, 20] });
    expect(c![0]).toBeCloseTo(80, 6);
  });

  it('routes utf8-decoded WKB string → wkbCentroid', () => {
    // Same WKB as above, but each byte mapped into a JS string code unit
    const bytes = new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 84, 64, 0, 0, 0, 0, 0, 0, 52, 64]);
    let s = ''; for (const b of bytes) s += String.fromCharCode(b);
    const c = extractCentroid(s);
    expect(c![0]).toBeCloseTo(80, 6);
    expect(c![1]).toBeCloseTo(20, 6);
  });

  it('returns null for unknown input', () => {
    expect(extractCentroid(null)).toBeNull();
    expect(extractCentroid(42)).toBeNull();
  });
});
