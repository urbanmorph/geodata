// Cheap centroid for the geometry column values hyparquet hands back. The
// shape isn't consistent across GeoParquet versions: a single column can
// surface as raw WKB bytes (Uint8Array), a utf8-decoded WKB-as-string (when
// hyparquet treats it as BYTE_ARRAY with utf8=true), or an already-decoded
// GeoJSON object. extractCentroid() normalises all three.
//
// Returns the unweighted average of vertices touched (outer ring for polygons,
// every point for everything else). Good enough for "is this within R km of
// (lat, lng)?" — not a true area centroid, but bias is bounded by the
// geometry's own extent. Never throws; returns null on truncated/unsupported
// input so the caller can drop the row.

export function wkbCentroid(buf: Uint8Array): [number, number] | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  let sx = 0, sy = 0, n = 0;

  function vertex(le: boolean, stride: number): boolean {
    if (p + 8 * stride > dv.byteLength) return false;
    sx += dv.getFloat64(p, le); p += 8;
    sy += dv.getFloat64(p, le); p += 8;
    p += 8 * (stride - 2);
    n++;
    return true;
  }

  function read(): boolean {
    if (p + 5 > dv.byteLength) return false;
    const le = dv.getUint8(p) === 1; p += 1;
    const t = dv.getUint32(p, le); p += 4;
    const isEWKB = (t & 0xE0000000) !== 0;
    let base: number, hasZ: boolean, hasM: boolean, hasSRID: boolean;
    if (isEWKB) {
      base = t & 0x0fff;
      hasZ = (t & 0x80000000) !== 0;
      hasM = (t & 0x40000000) !== 0;
      hasSRID = (t & 0x20000000) !== 0;
    } else {
      // ISO WKB: 1000s digit = Z, 2000s = M, 3000s = ZM
      base = t % 1000 || t;
      const fam = t - base;
      hasZ = fam === 1000 || fam === 3000;
      hasM = fam === 2000 || fam === 3000;
      hasSRID = false;
    }
    if (hasSRID) { if (p + 4 > dv.byteLength) return false; p += 4; }
    const stride = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);

    switch (base) {
      case 1: // Point
        return vertex(le, stride);
      case 2: { // LineString
        if (p + 4 > dv.byteLength) return false;
        const c = dv.getUint32(p, le); p += 4;
        for (let i = 0; i < c; i++) if (!vertex(le, stride)) return false;
        return true;
      }
      case 3: { // Polygon — only the outer ring contributes
        if (p + 4 > dv.byteLength) return false;
        const r = dv.getUint32(p, le); p += 4;
        for (let i = 0; i < r; i++) {
          if (p + 4 > dv.byteLength) return false;
          const c = dv.getUint32(p, le); p += 4;
          if (i === 0) {
            for (let j = 0; j < c; j++) if (!vertex(le, stride)) return false;
          } else {
            const skip = c * 8 * stride;
            if (p + skip > dv.byteLength) return false;
            p += skip;
          }
        }
        return true;
      }
      case 4: case 5: case 6: case 7: { // Multi / Collection
        if (p + 4 > dv.byteLength) return false;
        const k = dv.getUint32(p, le); p += 4;
        for (let i = 0; i < k; i++) if (!read()) return false;
        return true;
      }
      default:
        return false;
    }
  }

  try {
    if (!read()) return null;
  } catch {
    return null;
  }
  if (n === 0) return null;
  return [sx / n, sy / n];
}

export function geoJSONCentroid(g: unknown): [number, number] | null {
  let sx = 0, sy = 0, n = 0;
  function walk(coords: unknown): void {
    if (!Array.isArray(coords)) return;
    if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      sx += coords[0]; sy += coords[1]; n++; return;
    }
    for (const c of coords) walk(c);
  }
  if (g && typeof g === 'object') {
    const o = g as { coordinates?: unknown; geometries?: unknown };
    if (o.coordinates !== undefined) walk(o.coordinates);
    else if (Array.isArray(o.geometries)) for (const sub of o.geometries) {
      const c = geoJSONCentroid(sub);
      if (c) { sx += c[0]; sy += c[1]; n++; }
    }
  }
  if (n === 0) return null;
  return [sx / n, sy / n];
}

export function extractCentroid(v: unknown): [number, number] | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return wkbCentroid(v);
  if (typeof v === 'string') {
    // Re-pack utf8-decoded WKB: each byte landed in the low byte of one
    // UTF-16 code unit when hyparquet decoded BYTE_ARRAY as a string.
    const buf = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) buf[i] = v.charCodeAt(i) & 0xff;
    return wkbCentroid(buf);
  }
  if (typeof v === 'object') return geoJSONCentroid(v);
  return null;
}
