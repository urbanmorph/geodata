// Bench the Overture nearby path with and without the top-K cap optimisation.
// Mirrors the prod Worker code path: parquet read → bbox row prune → centroid
// haversine → cleanProps + output object. Reports timing for both shapes so
// we can see whether the optimisation actually helps before pushing.

import { parquetMetadataAsync, parquetQuery, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

const URL = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/pois/overture-places/overture_places_india.parquet';
const CENTER = { lat: 12.9716, lng: 77.5946 };
const RADIUS_KM = 10;
const LIMIT = 20;

const JUNK_PROPS = new Set([
  'shape_leng', 'shape_area', 'shape_length', 'shape.starea()', 'shape.stlength()',
  'shape_le_1', 'st_area(shape)', 'st_perimeter(shape)',
  'inpoly_fid', 'simpgnflag', 'maxsimptol', 'minsimptol', 'ogc_fid',
]);

const round4 = (n) => Math.round(n * 10000) / 10000;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function queryBbox(lat, lng, r) {
  const dLat = r / 111.32;
  const dLng = r / (111.32 * Math.cos(lat * Math.PI / 180));
  return { xmin: lng - dLng, ymin: lat - dLat, xmax: lng + dLng, ymax: lat + dLat };
}

function cleanProps(row, skip) {
  const out = {};
  for (const k of Object.keys(row)) {
    if (skip.has(k) || JUNK_PROPS.has(k.toLowerCase())) continue;
    out[k] = row[k];
  }
  return out;
}

async function httpAsyncBuffer(url) {
  const head = await fetch(url, { method: 'HEAD' });
  const sz = +head.headers.get('content-length');
  return {
    byteLength: sz,
    async slice(s, e) {
      const r = await fetch(url, { headers: { Range: `bytes=${s}-${(e ?? sz) - 1}` } });
      return r.arrayBuffer();
    },
  };
}

async function readMatchingRows() {
  const file = await httpAsyncBuffer(URL);
  const meta = await parquetMetadataAsync(file);
  const cols = parquetSchema(meta).children.map((c) => c.element.name);
  const qb = queryBbox(CENTER.lat, CENTER.lng, RADIUS_KM);
  const t0 = Date.now();
  const rows = await parquetQuery({
    compressors, file,
    columns: cols.filter((c) => c !== 'geometry'),
    rowFormat: 'object',
    geoparquet: false,
    filter: {
      $and: [
        { xmin: { $lte: qb.xmax } }, { xmax: { $gte: qb.xmin } },
        { ymin: { $lte: qb.ymax } }, { ymax: { $gte: qb.ymin } },
      ],
    },
  });
  return { rows, readMs: Date.now() - t0 };
}

// OLD: allocate per-row hit (full cleanProps), sort all, slice
function processOld(rows) {
  const t0 = Date.now();
  const skip = new Set(['geometry', 'xmin', 'ymin', 'xmax', 'ymax', 'bbox']);
  const hits = [];
  for (const row of rows) {
    const cLat = (Number(row.ymin) + Number(row.ymax)) / 2;
    const cLng = (Number(row.xmin) + Number(row.xmax)) / 2;
    const d = haversineKm(CENTER.lat, CENTER.lng, cLat, cLng);
    if (d > RADIUS_KM) continue;
    hits.push({
      properties: cleanProps(row, skip),
      _lat: round4(cLat), _lng: round4(cLng),
      _distance_km: Math.round(d * 10) / 10,
    });
  }
  hits.sort((a, b) => a._distance_km - b._distance_km);
  return { total: hits.length, features: hits.slice(0, LIMIT), ms: Date.now() - t0 };
}

// NEW: top-K first, cleanProps only on winners
function processNew(rows) {
  const t0 = Date.now();
  const skip = new Set(['geometry', 'xmin', 'ymin', 'xmax', 'ymax', 'bbox']);
  let total = 0;
  const winners = [];
  for (const row of rows) {
    const cLat = (Number(row.ymin) + Number(row.ymax)) / 2;
    const cLng = (Number(row.xmin) + Number(row.xmax)) / 2;
    const d = haversineKm(CENTER.lat, CENTER.lng, cLat, cLng);
    if (d > RADIUS_KM) continue;
    total++;
    winners.push({ row, cLat, cLng, d });
  }
  winners.sort((a, b) => a.d - b.d);
  if (winners.length > LIMIT) winners.length = LIMIT;
  const features = winners.map((w) => ({
    properties: cleanProps(w.row, skip),
    _lat: round4(w.cLat), _lng: round4(w.cLng),
    _distance_km: Math.round(w.d * 10) / 10,
  }));
  return { total, features, ms: Date.now() - t0 };
}

const { rows, readMs } = await readMatchingRows();
console.log(`parquet read+filter: ${rows.length} rows / ${readMs} ms`);

const oldR = processOld(rows);
console.log(`OLD (cleanProps per row):  total=${oldR.total} returned=${oldR.features.length} process_ms=${oldR.ms}`);

const newR = processNew(rows);
console.log(`NEW (cleanProps on top-K): total=${newR.total} returned=${newR.features.length} process_ms=${newR.ms} ratio=${(newR.ms / oldR.ms).toFixed(2)}x`);
