// Bench the parquet-backed nearby logic against real R2 parquets via HTTP.
// Standalone .mjs: runs the same hyparquet path as web/functions/lib/nearby.ts
// but with an HTTP-Range AsyncBuffer instead of the R2 binding, so we don't
// need a live Worker. Pure benchmark — does not deploy or touch prod.
//
// The wkb/geoJSON centroid + queryBbox/haversineKm helpers are duplicated from
// web/functions/lib/* deliberately: this script can't import .ts and shouldn't
// depend on the Workers runtime.

import { parquetMetadataAsync, parquetQuery, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

const CENTER = { lat: 12.9716, lng: 77.5946 };
const KM_PER_DEG_LAT = 111.32;
const BBOX_COLS = ['xmin', 'ymin', 'xmax', 'ymax'];

const QUERIES = [
  { layer: 'bm_dams',                radius_km: 50, url: 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/water/irrigation/Bharatmaps_Dams.parquet' },
  { layer: 'gs_wildlife',            radius_km: 50, url: 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/environment/forests/GatiShakti_Wildlife_Sanctuaries_and_National_Parks.parquet' },
  { layer: 'nic_health',             radius_km: 10, url: 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/healthcare/facilities/INDIA_HEALTH_FACILITIES_NIC.parquet' },
  { layer: 'pmgsy_habitations',      radius_km: 10, url: 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/boundaries/pmgsy-habitations/PMGSY_Habitations.parquet' },
  { layer: 'overture_places_india',  radius_km: 10, url: 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/pois/overture-places/overture_places_india.parquet' },
];

function queryBbox(lat, lng, radiusKm) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
  return { xmin: lng - dLng, ymin: lat - dLat, xmax: lng + dLng, ymax: lat + dLat };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pickGeomCol(cols) {
  for (const c of ['geometry', 'wkb_geometry', 'geom']) if (cols.includes(c)) return c;
  return cols.find((c) => c.toLowerCase().includes('geom')) ?? null;
}

function geoJSONCentroid(g) {
  let sx = 0, sy = 0, n = 0;
  function walk(c) {
    if (!Array.isArray(c)) return;
    if (c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number') { sx += c[0]; sy += c[1]; n++; return; }
    for (const sub of c) walk(sub);
  }
  if (g && typeof g === 'object') {
    if (g.coordinates !== undefined) walk(g.coordinates);
    else if (Array.isArray(g.geometries)) for (const sub of g.geometries) {
      const c = geoJSONCentroid(sub);
      if (c) { sx += c[0]; sy += c[1]; n++; }
    }
  }
  if (n === 0) return null;
  return [sx / n, sy / n];
}

function extractCentroid(v) {
  if (v == null) return null;
  if (v instanceof Uint8Array) return wkbCentroid(v);
  if (typeof v === 'string') {
    const buf = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) buf[i] = v.charCodeAt(i) & 0xff;
    return wkbCentroid(buf);
  }
  if (typeof v === 'object') return geoJSONCentroid(v);
  return null;
}

function wkbCentroid(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0; let sx = 0, sy = 0, n = 0;
  function vertex(le, stride) {
    if (p + 8 * stride > dv.byteLength) return false;
    sx += dv.getFloat64(p, le); p += 8;
    sy += dv.getFloat64(p, le); p += 8;
    p += 8 * (stride - 2); n++; return true;
  }
  function read() {
    if (p + 5 > dv.byteLength) return false;
    const le = dv.getUint8(p) === 1; p += 1;
    const t = dv.getUint32(p, le); p += 4;
    const isE = (t & 0xE0000000) !== 0;
    let base, hasZ, hasM, hasSRID;
    if (isE) {
      base = t & 0x0fff;
      hasZ = (t & 0x80000000) !== 0;
      hasM = (t & 0x40000000) !== 0;
      hasSRID = (t & 0x20000000) !== 0;
    } else {
      base = t % 1000 || t;
      const fam = t - base;
      hasZ = fam === 1000 || fam === 3000;
      hasM = fam === 2000 || fam === 3000;
      hasSRID = false;
    }
    if (hasSRID) { if (p + 4 > dv.byteLength) return false; p += 4; }
    const stride = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
    switch (base) {
      case 1: return vertex(le, stride);
      case 2: { const c = dv.getUint32(p, le); p += 4; for (let i = 0; i < c; i++) if (!vertex(le, stride)) return false; return true; }
      case 3: {
        const r = dv.getUint32(p, le); p += 4;
        for (let i = 0; i < r; i++) {
          const c = dv.getUint32(p, le); p += 4;
          if (i === 0) { for (let j = 0; j < c; j++) if (!vertex(le, stride)) return false; }
          else { const skip = c * 8 * stride; if (p + skip > dv.byteLength) return false; p += skip; }
        }
        return true;
      }
      case 4: case 5: case 6: case 7: { const k = dv.getUint32(p, le); p += 4; for (let i = 0; i < k; i++) if (!read()) return false; return true; }
      default: return false;
    }
  }
  try { if (!read()) return null; } catch { return null; }
  if (n === 0) return null;
  return [sx / n, sy / n];
}

async function httpAsyncBuffer(url) {
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) throw new Error(`HEAD ${url} → ${head.status}`);
  const byteLength = Number(head.headers.get('content-length'));
  if (!byteLength) throw new Error(`no content-length for ${url}`);
  return {
    byteLength,
    async slice(start, end) {
      const last = (end ?? byteLength) - 1;
      const r = await fetch(url, { headers: { Range: `bytes=${start}-${last}` } });
      if (!r.ok && r.status !== 206) throw new Error(`Range fetch ${url} → ${r.status}`);
      return r.arrayBuffer();
    },
  };
}

async function runOne(q) {
  const start = Date.now();
  const file = await httpAsyncBuffer(q.url);
  const meta = await parquetMetadataAsync(file);
  const cols = parquetSchema(meta).children.map((c) => c.element.name);
  const geomCol = pickGeomCol(cols);
  const hasBbox = BBOX_COLS.every((c) => cols.includes(c));
  const qbbox = queryBbox(CENTER.lat, CENTER.lng, q.radius_km);

  let rows; let source;
  if (hasBbox) {
    source = 'parquet-bbox';
    rows = await parquetQuery({
      compressors, file,
      columns: cols.filter((c) => c !== geomCol),
      rowFormat: 'object',
      geoparquet: false,
      filter: {
        $and: [
          { xmin: { $lte: qbbox.xmax } },
          { xmax: { $gte: qbbox.xmin } },
          { ymin: { $lte: qbbox.ymax } },
          { ymax: { $gte: qbbox.ymin } },
        ],
      },
    });
  } else {
    source = 'parquet-scan';
    rows = await parquetQuery({ compressors, file, columns: cols, rowFormat: 'object' });
  }

  let hits = 0;
  for (const row of rows) {
    let cLat, cLng;
    if (hasBbox) {
      cLat = (Number(row.ymin) + Number(row.ymax)) / 2;
      cLng = (Number(row.xmin) + Number(row.xmax)) / 2;
    } else {
      const c = extractCentroid(row[geomCol]);
      if (!c) continue;
      [cLng, cLat] = c;
    }
    if (haversineKm(CENTER.lat, CENTER.lng, cLat, cLng) <= q.radius_km) hits++;
  }

  return {
    layer: q.layer,
    radius_km: q.radius_km,
    total: hits,
    rows_scanned: rows.length,
    file_bytes: file.byteLength,
    timing_ms: Date.now() - start,
    source,
    row_groups: meta.row_groups.length,
    has_bbox_cols: hasBbox,
  };
}

const results = [];
for (const q of QUERIES) {
  process.stderr.write(`${q.layer} (${q.radius_km}km)... `);
  try {
    const r = await runOne(q);
    results.push(r);
    process.stderr.write(`total=${r.total} scan=${r.rows_scanned} ${r.timing_ms}ms (${r.source})\n`);
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    results.push({ layer: q.layer, error: e.message });
  }
}
console.log(JSON.stringify({ center: CENTER, queries: results }, null, 2));
