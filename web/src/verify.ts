// /verify — drop a geo file in, get a map render + validation report.
// No upload, no auth, no storage. Pure browser-side.
//
// Supported formats:
//   .geojson / .json  — parsed directly
//   .kml              — @tmcw/togeojson
//   .kmz              — JSZip → first .kml → togeojson
//   .parquet          — lazy DuckDB + WKB parse from src/db.ts
//
// URL state: /verify?url=https://... fetches a CORS-permissive remote
// and renders it. Shareable preview link.

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { kml as kmlToGeoJSON } from '@tmcw/togeojson';
import { escapeHtml } from './util';
import { validate, normaliseFC, INDIA_BBOX, type FC, type Report } from './validate';
import {
  inlineLoader,
  VERBS_VERIFY,
  VERBS_VERIFY_KMZ,
  VERBS_VERIFY_PARQUET,
  VERBS_VERIFY_FETCH,
} from './loading';
import { stashForSubmit } from './handoff';
const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const map = new maplibregl.Map({
  container: 'map',
  style: BASE_STYLE,
  bounds: INDIA_BBOX,
  fitBoundsOptions: { padding: 24 },
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');

const fileInput = document.getElementById('file') as HTMLInputElement;
const dropEl = document.getElementById('drop')!;
const sidebar = document.getElementById('sidebar')!;

// --- file -> FC pipeline --------------------------------------------------

async function fileToFC(
  file: File,
  loader: ReturnType<typeof inlineLoader>,
): Promise<{ fc: FC; format: string }> {
  const lname = file.name.toLowerCase();
  if (lname.endsWith('.geojson') || lname.endsWith('.json')) {
    const obj = JSON.parse(await file.text());
    return { fc: normaliseFC(obj), format: 'geojson' };
  }
  if (lname.endsWith('.kml')) {
    const xml = new DOMParser().parseFromString(await file.text(), 'text/xml');
    return { fc: kmlToGeoJSON(xml) as FC, format: 'kml' };
  }
  if (lname.endsWith('.kmz')) {
    loader.setVerbs(VERBS_VERIFY_KMZ);
    const JSZip = (await import('jszip')).default;
    const z = await JSZip.loadAsync(await file.arrayBuffer());
    const kmlEntry = Object.values(z.files).find((f) => /\.kml$/i.test(f.name) && !f.dir);
    if (!kmlEntry) throw new Error('KMZ contains no .kml file');
    const xml = new DOMParser().parseFromString(await kmlEntry.async('text'), 'text/xml');
    return { fc: kmlToGeoJSON(xml) as FC, format: 'kmz' };
  }
  if (lname.endsWith('.parquet')) {
    loader.setVerbs(VERBS_VERIFY_PARQUET);
    return { fc: await parquetToFC(file), format: 'parquet' };
  }
  throw new Error('Unsupported file type. Accepts: .geojson, .json, .kml, .kmz, .parquet');
}

async function parquetToFC(file: File): Promise<FC> {
  // Lazy-load DuckDB only when needed. Wire a temporary VFS file.
  const { getDb } = await import('./db');
  const db = await getDb();
  await db.registerFileBuffer('verify.parquet', new Uint8Array(await file.arrayBuffer()));
  const conn = await db.connect();
  try {
    const result = await conn.query("SELECT * FROM 'verify.parquet'");
    const rows = result.toArray();
    // Detect geometry column: 'geometry' (LGD style), 'geom', or first BLOB column
    const features: FC['features'] = [];
    const { parseWKB } = await import('./db');
    for (const row of rows) {
      const obj = row.toJSON() as Record<string, unknown>;
      const geomBytes = obj.geometry as Uint8Array | undefined;
      delete obj.geometry;
      for (const k of Object.keys(obj)) if (typeof obj[k] === 'bigint') obj[k] = Number(obj[k]);
      if (!(geomBytes instanceof Uint8Array)) continue;
      try {
        features.push({ type: 'Feature', geometry: parseWKB(geomBytes), properties: obj });
      } catch {
        /* skip malformed */
      }
    }
    return { type: 'FeatureCollection', features };
  } finally {
    await conn.close();
    await db.dropFile('verify.parquet');
  }
}

// --- render ---------------------------------------------------------------

function renderReport(report: Report, format: string, file: File): string {
  const fmtRows = (n: number) => n.toLocaleString('en-IN');
  const lines: string[] = [];
  lines.push(`<div class="kv"><span class="k">format</span><span class="v">${escapeHtml(format)} · ${(file.size / 1024).toFixed(1)} KB</span></div>`);
  lines.push(`<div class="kv"><span class="k">features</span><span class="v">${fmtRows(report.count)}</span></div>`);
  for (const [t, n] of Object.entries(report.byType)) {
    lines.push(`<div class="kv sub"><span class="k">· ${escapeHtml(t)}</span><span class="v">${fmtRows(n)}</span></div>`);
  }
  if (report.invalid > 0) {
    lines.push(`<div class="kv warn"><span class="k">invalid</span><span class="v">${fmtRows(report.invalid)}</span></div>`);
  }
  if (report.crs && !/(4326|CRS84)/i.test(report.crs)) {
    lines.push(`<div class="kv warn"><span class="k">CRS</span><span class="v">${escapeHtml(report.crs)} — expected EPSG:4326</span></div>`);
  }
  if (report.outsideIndia > 0) {
    lines.push(`<div class="kv warn"><span class="k">outside India bbox</span><span class="v">${fmtRows(report.outsideIndia)} coords</span></div>`);
  }
  if (report.topProps.length) {
    lines.push(`<div class="kv"><span class="k">top properties</span><span class="v"></span></div>`);
    for (const p of report.topProps) {
      lines.push(`<div class="kv sub"><span class="k">· ${escapeHtml(p)}</span><span class="v"></span></div>`);
    }
  }
  return lines.join('');
}

function renderOnMap(fc: FC, bbox: Report['bbox']) {
  for (const id of ['v-fill', 'v-line', 'v-pt']) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource('v')) map.removeSource('v');
  map.addSource('v', { type: 'geojson', data: fc as never });
  map.addLayer({
    id: 'v-fill',
    type: 'fill',
    source: 'v',
    paint: { 'fill-color': '#0a58ca', 'fill-opacity': 0.22 },
    filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
  });
  map.addLayer({
    id: 'v-line',
    type: 'line',
    source: 'v',
    paint: { 'line-color': '#0a58ca', 'line-width': 0.8 },
    filter: ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']]],
  });
  map.addLayer({
    id: 'v-pt',
    type: 'circle',
    source: 'v',
    paint: { 'circle-radius': 3, 'circle-color': '#0a58ca' },
    filter: ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]],
  });
  if (bbox) {
    map.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      { padding: 32, duration: 600 },
    );
  }
}

// --- driver ---------------------------------------------------------------

async function handle(file: File) {
  dropEl.classList.remove('dragover');
  sidebar.innerHTML = '';
  const loader = inlineLoader(sidebar, VERBS_VERIFY);
  try {
    const raw =
      file.size < 20_000_000 && /\.(json|geojson)$/i.test(file.name)
        ? JSON.parse(await file.text())
        : undefined;
    const { fc, format } = await fileToFC(file, loader);
    const report = validate(fc, raw);
    loader.dismiss();
    const errsBlock = report.invalid > 0 || (report.crs && !/(4326|CRS84)/i.test(report.crs));
    sidebar.innerHTML = renderReport(report, format, file) +
      (errsBlock
        ? ''
        : `<div class="cta-row" style="margin-top:18px;padding-top:14px;border-top:1px dashed var(--line)">
             <button id="submit-this" type="button" style="background:var(--accent);color:#fff;border:0;padding:8px 14px;border-radius:6px;font:inherit;font-weight:500;cursor:pointer">Submit this to the catalog →</button>
           </div>`);
    renderOnMap(fc, report.bbox);
    document.getElementById('submit-this')?.addEventListener('click', async () => {
      try {
        await stashForSubmit(file);
        window.location.href = '/submit';
      } catch (err) {
        sidebar.insertAdjacentHTML('beforeend', `<div class="error">hand-off failed: ${escapeHtml((err as Error).message)}</div>`);
      }
    });
  } catch (e) {
    loader.dismiss();
    sidebar.innerHTML = `<div class="error">${escapeHtml((e as Error).message)}</div>`;
  }
}

fileInput?.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) handle(f);
});

['dragenter', 'dragover'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    dropEl.classList.add('dragover');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev !== 'drop') dropEl.classList.remove('dragover');
  }),
);
window.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) handle(f);
});

// URL state: ?url=https://example.com/file.geojson
const urlParam = new URLSearchParams(location.search).get('url');
if (urlParam) {
  (async () => {
    sidebar.innerHTML = '';
    const fetchLoader = inlineLoader(sidebar, VERBS_VERIFY_FETCH);
    try {
      const resp = await fetch(urlParam);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const name = urlParam.split('/').pop() || 'remote.geojson';
      fetchLoader.dismiss();
      handle(new File([blob], name));
    } catch (e) {
      fetchLoader.dismiss();
      sidebar.innerHTML = `<div class="error">fetch failed: ${escapeHtml((e as Error).message)}</div>`;
    }
  })();
}
