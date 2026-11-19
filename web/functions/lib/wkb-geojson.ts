// WKB -> GeoJSON (ISO WKB and EWKB, 2D; Z/M dropped). parseWKB gives objects
// (the browser's DuckDB export, src/db.ts); wkbToText writes a shape's GeoJSON
// or KML text straight from the bytes, in pieces, for the API's filtered
// export (parquet-export.ts): one groundwater prospect polygon is 145,000
// points, and objects plus text for it took ~25 MB of a 128 MB Worker.

export type Geometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | { type: 'MultiPoint'; coordinates: [number, number][] }
  | { type: 'MultiLineString'; coordinates: [number, number][][] }
  | { type: 'MultiPolygon'; coordinates: [number, number][][][] }
  | { type: 'GeometryCollection'; geometries: Geometry[] };

/** One geometry's header at byte p: byte order, base type (1..7), doubles per
 *  point, and where its body starts. */
function geomHeader(dv: DataView, p: number): { le: boolean; t: number; stride: number; body: number } {
  const le = dv.getUint8(p) === 1;
  const typeWithFlags = dv.getUint32(p + 1, le);
  // Strip Z/M flags. Two encodings in the wild:
  //   ISO WKB:  base type + 1000*Z + 2000*M + 3000*ZM    (e.g. 1001 = Point Z)
  //   EWKB:     base type | 0x80000000 (Z) | 0x40000000 (M) | 0x20000000 (SRID)
  const isEWKB = (typeWithFlags & 0xE0000000) !== 0;
  const t = isEWKB ? typeWithFlags & 0x0fff : typeWithFlags % 1000 || typeWithFlags;
  const hasZ = isEWKB
    ? (typeWithFlags & 0x80000000) !== 0
    : ((typeWithFlags % 4000) >= 1000 && (typeWithFlags % 4000) < 2000) || typeWithFlags >= 3000;
  const hasM = isEWKB
    ? (typeWithFlags & 0x40000000) !== 0
    : ((typeWithFlags % 4000) >= 2000 && (typeWithFlags % 4000) < 3000) || typeWithFlags >= 3000;
  const hasSRID = isEWKB && (typeWithFlags & 0x20000000) !== 0;
  if (t < 1 || t > 7) throw new Error('unsupported WKB type ' + t);
  return { le, t, stride: 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0), body: p + 5 + (hasSRID ? 4 : 0) };
}

export function parseWKB(buf: Uint8Array): Geometry {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  function readGeom(): Geometry {
    const { le, t, stride, body } = geomHeader(dv, p);
    p = body;
    function pt(): [number, number] {
      const x = dv.getFloat64(p, le); p += 8;
      const y = dv.getFloat64(p, le); p += 8;
      p += 8 * (stride - 2); // skip Z/M doubles
      return [x, y];
    }
    function line(): [number, number][] {
      const n = dv.getUint32(p, le); p += 4;
      const out: [number, number][] = [];
      for (let i = 0; i < n; i++) out.push(pt());
      return out;
    }
    function poly(): [number, number][][] {
      const rn = dv.getUint32(p, le); p += 4;
      const rings: [number, number][][] = [];
      for (let r = 0; r < rn; r++) rings.push(line());
      return rings;
    }
    function parts<T>(): T[] {
      const n = dv.getUint32(p, le); p += 4;
      const out: T[] = [];
      for (let i = 0; i < n; i++) out.push(readGeom() as T);
      return out;
    }
    switch (t) {
      case 1: return { type: 'Point', coordinates: pt() };
      case 2: return { type: 'LineString', coordinates: line() };
      case 3: return { type: 'Polygon', coordinates: poly() };
      case 4: return { type: 'MultiPoint', coordinates: parts<{ coordinates: [number, number] }>().map((g) => g.coordinates) };
      case 5: return { type: 'MultiLineString', coordinates: parts<{ coordinates: [number, number][] }>().map((g) => g.coordinates) };
      case 6: return { type: 'MultiPolygon', coordinates: parts<{ coordinates: [number, number][][] }>().map((g) => g.coordinates) };
      default: return { type: 'GeometryCollection', geometries: parts<Geometry>() };
    }
  }
  return readGeom();
}

const GEOJSON_TYPES = ['', 'Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection'];

/**
 * A shape's text from its WKB, in pieces of about `piece` characters: GeoJSON
 * exactly as JSON.stringify(parseWKB(buf)), or KML exactly as
 * geometryToKML(parseWKB(buf)) (shared/kml.mjs; which writes nothing for a
 * MultiPoint). Memory is one piece, whatever the shape's size.
 */
export function* wkbToText(buf: Uint8Array, format: 'geojson' | 'kml', piece = 64 * 1024): Generator<string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const json = format === 'geojson';
  let p = 0;
  let out = '';

  // n points: GeoJSON [x,y],[x,y]  KML x,y x,y
  function* points(le: boolean, stride: number, n: number): Generator<string> {
    for (let i = 0; i < n; i++) {
      const x = dv.getFloat64(p, le);
      const y = dv.getFloat64(p + 8, le);
      p += 8 * stride;
      if (json) out += `${i ? ',' : ''}[${Number.isFinite(x) ? x : null},${Number.isFinite(y) ? y : null}]`;
      else out += `${i ? ' ' : ''}${x},${y}`;
      if (out.length >= piece) { yield out; out = ''; }
    }
  }
  function count(le: boolean): number {
    const n = dv.getUint32(p, le);
    p += 4;
    return n;
  }
  function* ring(le: boolean, stride: number, tag: 'LinearRing' | 'LineString'): Generator<string> {
    const n = count(le);
    out += json ? '[' : `<${tag}><coordinates>`;
    yield* points(le, stride, n);
    out += json ? ']' : `</coordinates></${tag}>`;
  }
  function* polygonBody(le: boolean, stride: number): Generator<string> {
    const rings = count(le);
    out += json ? '[' : '<Polygon>';
    for (let r = 0; r < rings; r++) {
      if (json) { if (r) out += ','; } else out += r ? '<innerBoundaryIs>' : '<outerBoundaryIs>';
      yield* ring(le, stride, 'LinearRing');
      if (!json) out += r ? '</innerBoundaryIs>' : '</outerBoundaryIs>';
    }
    out += json ? ']' : '</Polygon>';
  }
  // A geometry's coordinates (GeoJSON) or element (KML), from its header on.
  function* body(): Generator<string> {
    const { le, t, stride, body: start } = geomHeader(dv, p);
    p = start;
    if (t === 1) {
      out += json ? '' : '<Point><coordinates>';
      yield* points(le, stride, 1);
      out += json ? '' : '</coordinates></Point>';
    } else if (t === 2) {
      yield* ring(le, stride, 'LineString');
    } else if (t === 3) {
      yield* polygonBody(le, stride);
    } else {
      const n = count(le);
      const kmlParts = !json && t !== 4; // MultiPoint: no KML (as geometryToKML)
      out += json ? (t === 7 ? '' : '[') : kmlParts ? '<MultiGeometry>' : '';
      for (let i = 0; i < n; i++) {
        if (json && i) out += ',';
        if (t === 7) yield* geometry();
        else if (json || kmlParts) yield* body();
        else skip();
      }
      out += json ? (t === 7 ? '' : ']') : kmlParts ? '</MultiGeometry>' : '';
    }
  }
  // Steps over a geometry without writing it (a KML MultiPoint's points).
  function skip(): void {
    const { stride, body: start } = geomHeader(dv, p);
    p = start + 8 * stride;
  }
  // A whole geometry: GeoJSON {"type":...,"coordinates":...}; KML its element.
  function* geometry(): Generator<string> {
    const t = geomHeader(dv, p).t;
    if (json) out += `{"type":"${GEOJSON_TYPES[t]}","${t === 7 ? 'geometries' : 'coordinates'}":${t === 7 ? '[' : ''}`;
    yield* body();
    if (json) out += t === 7 ? ']}' : '}';
  }

  yield* geometry(); // a truncated shape throws (DataView RangeError) before its end is written
  if (out) yield out;
}
