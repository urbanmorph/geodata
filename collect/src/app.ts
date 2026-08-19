// The /c/<id>[/admin|/view] app: a full-bleed map with a fixed crosshair for
// pin-drop, an "Use my location" button (geolocation called synchronously in the
// tap handler), a bottom-sheet form generated from the collection's schema, and
// — for admin — a review queue + publish. Mobile-first.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { styleFor, INDIA_CENTER } from './basemap';
import { addReferenceOverlay, setReferenceVisible } from './geo/reference';
import { parseCtx, apiJson, type Ctx } from './api';
import { turnstileToken } from './turnstile';
import { validateRecordProperties, type Field } from './schema/validate-record';
import { orderedModes, drawGeometry, type GeomMode, type Coord } from './geo/draw';
import { representativeCoord } from './geo/admin-ctx';
import { escapeHtml } from './util';
import { toGeoJSON, toCSV, toKML, type ExportFeature } from './export/formats';
import { detectFormat, parseImport, type Parsed } from './import/parse';
import { autoMapping, buildRecords, errorsToCSV, type Mapping } from './import/build';
interface Counts { pending: number; published: number; total: number; rejected: number; }
interface Meta {
  id: string; name: string; purpose: string; status: string; moderation: number;
  schema: { geometry: string[]; fields: Field[]; basemap?: string; reference_layer?: { id: string; pmtiles_url: string } | null }; counts: Counts;
}
interface Feature { id: string; geometry: { type: string; coordinates: number[] }; properties: Record<string, unknown>; }

const app = document.getElementById('app')!;
let map: maplibregl.Map;
let meta: Meta;
let ctx: Ctx;

// Draw state (Phase 4). Points use the map centre; lines/polygons collect
// vertices by panning the crosshair and tapping "+ vertex".
const ACCENT = '#4f46e5';
let drawMode: GeomMode = 'point';
let verts: Coord[] = [];
let drawReady = false;
let allowsShapes = false; // collection declares line/polygon → draw layers are worth adding

const emptyFC = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

// Add the in-progress draw source + layers once the style is up (only needed
// for line/polygon collections — points-only stays light).
function setupDrawLayers(): void {
  if (drawReady || !allowsShapes || !map.isStyleLoaded()) return;
  map.addSource('draw', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': ACCENT, 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', filter: ['!=', '$type', 'Point'], paint: { 'line-color': ACCENT, 'line-width': 2.5 } });
  map.addLayer({ id: 'draw-vert', type: 'circle', source: 'draw', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': ACCENT, 'circle-stroke-width': 2 } });
  drawReady = true;
}

function redrawDraw(): void {
  if (!drawReady) { setupDrawLayers(); if (!drawReady) return; }
  const features: GeoJSON.Feature[] = verts.map((v) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: v }, properties: {} }));
  if (drawMode === 'polygon' && verts.length >= 3) {
    features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...verts, verts[0]]] }, properties: {} });
  } else if (verts.length >= 2) {
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: verts }, properties: {} });
  }
  (map.getSource('draw') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
}

function toast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2400);
}

function marker(coords: number[], color = ACCENT): void {
  if (coords.length >= 2) new maplibregl.Marker({ color }).setLngLat([coords[0], coords[1]]).addTo(map);
}

const TERMS = 'https://bharatlas.com/terms';
// Content-safety: a report/takedown path (mailto, no accounts) + terms link.
function safetyFooter(): string {
  const subject = encodeURIComponent(`Report: collect map ${ctx.id}`);
  const body = encodeURIComponent(`Reporting this map:\n${location.origin}/c/${ctx.id}\n\nReason:\n`);
  return `<p class="hint" style="margin-top:12px">Public places and assets only, not people. <a href="mailto:sathya@urbanmorph.com?subject=${subject}&body=${body}">Report this map</a> · <a href="${TERMS}" target="_blank" rel="noopener">Terms</a></p>`;
}

async function boot(): Promise<void> {
  ctx = parseCtx()!;
  meta = await apiJson<Meta>(`/collections/${ctx.id}`, ctx.token);
  const isView = ctx.mode === 'view';
  const isAdmin = ctx.mode === 'admin';

  app.innerHTML = `
    <div class="topbar">
      <a href="/" aria-label="Back to start">←</a><span>${escapeHtml(meta.name)}</span>
      <span class="muted" style="margin-left:auto">${isAdmin ? 'admin' : isView ? 'view' : ''}</span>
    </div>
    <div class="map">
      <div id="map"></div>
      <div class="crosshair" aria-hidden="true" ${isView ? 'style="display:none"' : ''}></div>
      <div class="map-loading" id="maploading"><span class="spinner"></span> Loading map…</div>
      ${isView ? '' : '<button class="locate" id="locate" aria-label="Use my location">◎</button>'}
      ${meta.schema.reference_layer ? '<button class="locate" id="reftoggle" aria-pressed="true" style="left:12px;top:12px;right:auto;bottom:auto;width:auto;padding:0 12px">◪ Layer</button>' : ''}
      ${isAdmin ? `<button class="locate" id="manage" aria-label="Manage map${meta.counts.pending ? `, ${meta.counts.pending} pending review` : ''}" style="left:12px;right:auto;bottom:76px;width:auto;padding:0 14px">⚙${meta.counts.pending ? ` ${meta.counts.pending}` : ''}</button>` : ''}
    </div>
    <div id="panel"></div>`;

  map = new maplibregl.Map({
    container: 'map', style: styleFor(meta.schema.basemap), center: INDIA_CENTER, zoom: 4,
    attributionControl: false,
  });
  // Attribution bottom-left so it never sits under the locate button (bottom-right).
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  drawReady = false; verts = [];
  allowsShapes = orderedModes(meta.schema.geometry).some((m) => m !== 'point');
  map.on('load', () => {
    document.getElementById('maploading')?.remove();
    if (!isView && allowsShapes) setupDrawLayers();
    if (meta.schema.reference_layer) void addReferenceOverlay(map, meta.schema.reference_layer.pmtiles_url).catch(() => {});
    void loadRecords();
  });

  const reftoggle = document.getElementById('reftoggle') as HTMLButtonElement | null;
  if (reftoggle) reftoggle.onclick = () => {
    const on = reftoggle.getAttribute('aria-pressed') !== 'true';
    reftoggle.setAttribute('aria-pressed', String(on));
    reftoggle.style.opacity = on ? '1' : '0.55';
    setReferenceVisible(map, on);
  };

  if (!isView) {
    const locate = document.getElementById('locate') as HTMLButtonElement;
    locate.onclick = () => {
      if (!navigator.geolocation) return toast('Location not available');
      navigator.geolocation.getCurrentPosition(
        (pos) => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 16 }),
        () => toast("Couldn't get your location"),
        { enableHighAccuracy: true, timeout: 8000 },
      );
    };
    if (isAdmin) {
      // Admin lands on Manage (review + CRUD + publish); the ⚙ button returns here.
      (document.getElementById('manage') as HTMLButtonElement).onclick = manageSheet;
      void manageSheet();
    } else {
      captureSheet();
    }
  }
  if (isView) viewPanel();
}

function viewPanel(): void {
  const panel = document.getElementById('panel')!;
  const n = meta.counts.published;
  panel.innerHTML = `<div class="sheet"><div class="body">
    <strong>${escapeHtml(meta.name)}</strong>
    ${meta.purpose ? `<p class="hint">${escapeHtml(meta.purpose)}</p>` : ''}
    <p class="hint">${n ? `${n} point${n === 1 ? '' : 's'} on the map.` : 'No points published yet.'}</p>
    ${safetyFooter()}
  </div></div>`;
}

let recordShapes: GeoJSON.Feature[] = [];

// The non-point records overlay: one accumulating source for existing +
// just-added lines/polygons. Points are plain markers.
function syncRecordShapes(): void {
  if (!map.isStyleLoaded()) return;
  const data = { type: 'FeatureCollection', features: recordShapes } as GeoJSON.FeatureCollection;
  const src = map.getSource('records') as maplibregl.GeoJSONSource | undefined;
  if (src) { src.setData(data); return; }
  map.addSource('records', { type: 'geojson', data });
  map.addLayer({ id: 'records-fill', type: 'fill', source: 'records', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': ACCENT, 'fill-opacity': 0.1 } });
  map.addLayer({ id: 'records-line', type: 'line', source: 'records', filter: ['!=', '$type', 'Point'], paint: { 'line-color': ACCENT, 'line-width': 2, 'line-opacity': 0.7 } });
}

function addRecordShape(geometry: GeoJSON.Geometry): void {
  recordShapes.push({ type: 'Feature', geometry, properties: {} });
  syncRecordShapes();
}

async function loadRecords(): Promise<void> {
  try {
    // Published-only on the capture map (admin's un-moderated pins live in the queue).
    const fc = await apiJson<{ features: Feature[] }>(`/collections/${ctx.id}/records?status=published`, ctx.token);
    recordShapes = [];
    for (const f of fc.features || []) {
      if (f.geometry?.type === 'Point') marker(f.geometry.coordinates);
      else if (f.geometry) recordShapes.push({ type: 'Feature', geometry: f.geometry as GeoJSON.Geometry, properties: {} });
    }
    if (recordShapes.length) syncRecordShapes();
  } catch { /* map still usable */ }
}

function fieldInput(f: Field): string {
  const req = f.required ? ' required' : '';
  const ml = f.maxLength ? ` maxlength="${f.maxLength}"` : '';
  switch (f.type) {
    case 'paragraph': return `<textarea data-k="${f.key}"${req}${ml}></textarea>`;
    case 'number': return `<input data-k="${f.key}" inputmode="${f.integer ? 'numeric' : 'decimal'}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''} step="${f.integer ? '1' : 'any'}"${req} />`;
    case 'date': return `<input data-k="${f.key}" type="date"${req} />`;
    case 'url': return `<input data-k="${f.key}" type="url"${req} placeholder="https://" />`;
    case 'select':
      return `<select data-k="${f.key}"${req}><option value=""></option>${(f.options || []).map((o) => `<option>${escapeHtml(o)}</option>`).join('')}</select>`;
    case 'multiselect':
      return `<div class="row" data-k="${f.key}" data-multi>${(f.options || []).map((o) => `<button type="button" class="chip" data-v="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}</div>`;
    default: return `<input data-k="${f.key}"${req}${ml} />`;
  }
}

const NOUN: Record<GeomMode, string> = { point: 'point', line: 'line', polygon: 'area' };
function nounFor(geometryType: string): string {
  if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') return NOUN.polygon;
  if (geometryType === 'LineString' || geometryType === 'MultiLineString') return NOUN.line;
  return NOUN.point;
}
const CAP_HELP: Record<GeomMode, string> = {
  point: 'Move the map so the crosshair sits on the spot.',
  line: 'Pan the map so the crosshair sits on a point, then tap "Add point here". Repeat along the line.',
  polygon: 'Pan the map so the crosshair sits on a corner, then tap "Add point here", going around the area.',
};

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);
let lastContributor = '';
let lastAdded = '';

// Capture is two steps so the MAP is the centre-piece while marking:
//   1. renderPlaceBar — a compact bar; position the crosshair and place the shape
//   2. detailsSheet   — the form slides up only once a shape is placed
function captureSheet(): void {
  const modes = orderedModes(meta.schema.geometry);
  drawMode = modes[0];
  verts = [];
  redrawDraw();
  renderPlaceBar(modes);
}

function renderPlaceBar(modes: GeomMode[]): void {
  const panel = document.getElementById('panel')!;
  const seg = modes.length > 1
    ? `<div class="seg" id="modesw">${modes.map((m) => `<button type="button" data-m="${m}"${m === drawMode ? ' class="on"' : ''}>${cap(NOUN[m])}</button>`).join('')}</div>`
    : '';
  panel.innerHTML = `<div class="bar">
    ${seg}
    <p class="hint" id="cap-help">${CAP_HELP[drawMode]}</p>
    <div class="row" id="drawctl" style="display:none;align-items:center">
      <button type="button" id="vadd" class="accent">+ Add point here</button>
      <button type="button" id="vundo">Undo</button>
      <span class="hint" id="vcount"></span>
    </div>
    <button class="primary" id="place">Add ${NOUN[drawMode]}</button>
    <div id="lastadded" class="hint">${lastAdded}</div>
  </div>`;

  const syncDrawUI = (): void => {
    document.getElementById('cap-help')!.textContent = CAP_HELP[drawMode];
    (document.getElementById('place') as HTMLButtonElement).textContent = `Add ${NOUN[drawMode]}`;
    document.getElementById('drawctl')!.style.display = drawMode === 'point' ? 'none' : 'flex';
    const need = drawMode === 'line' ? 2 : 3;
    const n = verts.length;
    document.getElementById('vcount')!.textContent =
      n < need ? `${n} point${n === 1 ? '' : 's'} · add ${need - n} more`
               : `${n} points · tap "Add ${NOUN[drawMode]}" when ready`;
    document.querySelectorAll('#modesw button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.m === drawMode));
    document.querySelector('.crosshair')?.classList.toggle('crosshair--draw', drawMode !== 'point');
  };
  syncDrawUI();

  document.querySelectorAll<HTMLButtonElement>('#modesw button').forEach((b) => {
    b.onclick = () => { drawMode = b.dataset.m as GeomMode; verts = []; redrawDraw(); syncDrawUI(); };
  });
  (document.getElementById('vadd') as HTMLButtonElement).onclick = () => {
    const c = map.getCenter(); verts.push([c.lng, c.lat]); redrawDraw(); syncDrawUI();
  };
  (document.getElementById('vundo') as HTMLButtonElement).onclick = () => {
    verts.pop(); redrawDraw(); syncDrawUI();
  };
  (document.getElementById('place') as HTMLButtonElement).onclick = () => {
    const c = map.getCenter();
    const geometry = drawGeometry(drawMode, verts, [c.lng, c.lat]);
    if (!geometry) { toast(`A ${NOUN[drawMode]} needs ${drawMode === 'line' ? '2' : '3'} points or more`); return; }
    detailsSheet(geometry, modes);
  };
}

function detailsSheet(geometry: GeoJSON.Geometry, modes: GeomMode[]): void {
  const fields = meta.schema.fields.filter((f) => !f.deleted);
  const noun = NOUN[drawMode];
  const panel = document.getElementById('panel')!;
  panel.innerHTML = `<div class="sheet">
    <form class="body" id="capform">
      <strong>${cap(noun)} details</strong>
      <p class="hint">Placed on the map. Add the details, then save. Public places and assets only, not people.</p>
      ${fields.map((f) => `<label>${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>${f.hint ? `<p class="hint" style="margin:-2px 0 4px">${escapeHtml(f.hint)}</p>` : ''}${fieldInput(f)}`).join('')}
      <label>Your name <span class="hint">(optional, published with the data)</span></label>
      <input id="contributor" />
    </form>
    <div class="foot row">
      <button type="button" id="cancel">← Back</button>
      <button class="primary" id="save" style="flex:1">Save ${noun}</button>
    </div>
  </div>`;
  (document.getElementById('contributor') as HTMLInputElement).value = lastContributor;
  panel.querySelectorAll<HTMLElement>('[data-multi] .chip').forEach((c) => { c.onclick = () => c.classList.toggle('on'); });
  // Back keeps a line/area's vertices so drawing work isn't lost.
  (document.getElementById('cancel') as HTMLButtonElement).onclick = () => renderPlaceBar(modes);

  (document.getElementById('save') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const form = document.getElementById('capform') as HTMLFormElement;
    if (!form.reportValidity()) return;
    const raw: Record<string, unknown> = {};
    for (const f of fields) {
      const el = panel.querySelector(`[data-k="${f.key}"]`);
      if (!el) continue;
      if (f.type === 'multiselect') {
        const on = [...el.querySelectorAll('.chip.on')].map((c2) => (c2 as HTMLElement).dataset.v);
        if (on.length) raw[f.key] = on;
      } else {
        const val = (el as HTMLInputElement).value;
        if (val) raw[f.key] = val;
      }
    }
    const valid = validateRecordProperties(fields, raw);
    if (!valid.ok) { toast(valid.error); return; }
    btn.disabled = true;
    try {
      lastContributor = (document.getElementById('contributor') as HTMLInputElement).value;
      const turnstile_token = await turnstileToken();
      const res = await apiJson<{ id: string; edit_token: string }>(`/collections/${ctx.id}/records`, ctx.token, {
        method: 'POST',
        body: JSON.stringify({ geometry, properties: valid.properties, contributor: lastContributor, turnstile_token }),
      });
      if (geometry.type === 'Point') marker((geometry as GeoJSON.Point).coordinates as number[]);
      else addRecordShape(geometry);
      verts = []; redrawDraw();
      toast(meta.moderation ? 'Added, pending review ✓' : 'Added ✓');
      const editUrl = `${location.origin}/c/${ctx.id}/r/${res.id}#${res.edit_token}`;
      lastAdded = `✓ Added. <a href="${editUrl}">edit this ${noun}</a>`;
      renderPlaceBar(modes); // back to the map, ready for the next one
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}. Your details are kept, tap Save to retry.`);
      btn.disabled = false;
    }
  };
}

async function manageSheet(): Promise<void> {
  meta = await apiJson<Meta>(`/collections/${ctx.id}`, ctx.token).catch(() => meta);
  const c = meta.counts;
  const panel = document.getElementById('panel')!;
  panel.innerHTML = `<div class="sheet">
    <div class="body">
      <strong>Manage map</strong>
      <p class="hint" id="mcounts">${c.published} approved · ${c.pending} pending · ${c.rejected} rejected</p>
      <div class="row" id="pfilter" style="margin:8px 0 4px">
        <button type="button" class="chip on" data-s="">All ${c.total}</button>
        <button type="button" class="chip" data-s="pending">Pending ${c.pending}</button>
        <button type="button" class="chip" data-s="published">Approved ${c.published}</button>
        ${c.rejected ? `<button type="button" class="chip" data-s="rejected">Rejected ${c.rejected}</button>` : ''}
      </div>
      <div id="points"><p class="hint">Loading points…</p></div>
      <strong style="display:block;margin-top:14px">Share links</strong>
      <p class="hint">Mint a fresh link to share. The original links can't be shown again.</p>
      <div class="row">
        <button id="mint-edit">+ Collect link</button>
        <button id="mint-view">+ View-only link</button>
      </div>
      <div id="minted"></div>
      <strong style="display:block;margin-top:14px">Download the data</strong>
      <p class="hint">Every collected point, to use anywhere.</p>
      <div class="row">
        <button data-dl="geojson">GeoJSON</button>
        <button data-dl="csv">CSV</button>
        <button data-dl="kml">KML</button>
      </div>
      <strong style="display:block;margin-top:14px">Import data</strong>
      <p class="hint">Add many points at once from a CSV, GeoJSON or KML file.</p>
      <label class="btn wide" style="cursor:pointer">⬆ Choose a file<input id="import-file" type="file" accept=".csv,.geojson,.json,.kml" hidden></label>
      <div id="import-panel"></div>
      ${safetyFooter()}
    </div>
    <div class="foot row">
      <button id="back">+ Add points</button>
      <button class="primary" id="publish" style="flex:1">Publish → atlas</button>
    </div>
  </div>`;
  (document.getElementById('back') as HTMLButtonElement).onclick = captureSheet;
  (document.getElementById('publish') as HTMLButtonElement).onclick = doPublish;
  document.querySelectorAll<HTMLButtonElement>('#pfilter .chip').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#pfilter .chip').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      void renderPoints();
    };
  });

  const mint = async (permission: 'edit' | 'view') => {
    try {
      const res = await apiJson<{ link: string }>(`/collections/${ctx.id}/tokens`, ctx.token, {
        method: 'POST', body: JSON.stringify({ permission }),
      });
      const box = document.getElementById('minted')!;
      const row = document.createElement('div');
      row.className = 'link-box';
      row.innerHTML = `<code></code><button>Copy</button>`;
      row.querySelector('code')!.textContent = res.link; // textContent — never innerHTML a URL
      const btn = row.querySelector('button')!;
      btn.onclick = () => { navigator.clipboard?.writeText(res.link); btn.textContent = '✓'; };
      box.prepend(row);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  (document.getElementById('mint-edit') as HTMLButtonElement).onclick = () => mint('edit');
  (document.getElementById('mint-view') as HTMLButtonElement).onclick = () => mint('view');
  document.querySelectorAll<HTMLButtonElement>('button[data-dl]').forEach((b) => {
    b.onclick = () => void downloadData(b.dataset.dl as 'geojson' | 'csv' | 'kml');
  });
  (document.getElementById('import-file') as HTMLInputElement).onchange = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void importFlow(file);
  };

  void renderPoints();
}

const slug = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'collect-map';

function downloadText(content: string, filename: string, mime: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Fetch every record and hand the author a file — no server round-trip.
async function downloadData(format: 'geojson' | 'csv' | 'kml'): Promise<void> {
  try {
    const fc = await apiJson<{ features: ExportFeature[] }>(`/collections/${ctx.id}/records?limit=100000`, ctx.token);
    const features = fc.features || [];
    if (!features.length) { toast('No points to download yet'); return; }
    const keys = meta.schema.fields.filter((f) => !f.deleted).map((f) => f.key);
    const [content, mime, ext] =
      format === 'geojson' ? [toGeoJSON(features, keys), 'application/geo+json', 'geojson']
      : format === 'csv' ? [toCSV(features, keys), 'text/csv', 'csv']
      : [toKML(features, keys, meta.name), 'application/vnd.google-earth.kml+xml', 'kml'];
    downloadText(content, `${slug(meta.name)}.${ext}`, mime);
    toast(`Downloaded ${features.length} point${features.length === 1 ? '' : 's'} as ${ext.toUpperCase()}`);
  } catch (e) {
    toast((e as Error).message);
  }
}

// Import (Phase 5): parse a file → map columns to fields → validate → bulk POST.
async function importFlow(file: File): Promise<void> {
  const panel = document.getElementById('import-panel');
  if (!panel) return;
  const format = detectFormat(file.name);
  if (!format) { panel.innerHTML = '<p class="warn">Use a .csv, .geojson or .kml file.</p>'; return; }
  let parsed: Parsed;
  try { parsed = parseImport(await file.text(), format); }
  catch (e) { panel.innerHTML = `<p class="warn">Couldn't read the file: ${escapeHtml((e as Error).message)}</p>`; return; }
  if (!parsed.features.length) { panel.innerHTML = '<p class="hint">No rows found in the file.</p>'; return; }

  const fields = meta.schema.fields.filter((f) => !f.deleted);
  const needsLngLat = format === 'csv';
  const guess = autoMapping(fields, parsed.columns);
  const opts = (sel?: string): string =>
    `<option value="">— none —</option>` + parsed.columns.map((c) => `<option${c === sel ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
  panel.innerHTML = `
    <p class="hint">${parsed.features.length} rows in ${format.toUpperCase()}. Match columns to your fields.</p>
    ${needsLngLat ? `<label>Longitude column</label><select data-map="lng">${opts(guess.lng)}</select><label>Latitude column</label><select data-map="lat">${opts(guess.lat)}</select>` : ''}
    ${fields.map((f) => `<label>${escapeHtml(f.label)}${f.required ? ' *' : ''}</label><select data-field="${f.key}">${opts(guess.fields[f.key])}</select>`).join('')}
    <button class="primary" id="do-import" style="margin-top:12px">Import ${parsed.features.length} rows</button>
    <div id="import-result"></div>`;

  (document.getElementById('do-import') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const m: Mapping = { fields: {} };
    if (needsLngLat) {
      m.lng = (panel.querySelector('[data-map="lng"]') as HTMLSelectElement).value || undefined;
      m.lat = (panel.querySelector('[data-map="lat"]') as HTMLSelectElement).value || undefined;
    }
    panel.querySelectorAll<HTMLSelectElement>('[data-field]').forEach((s) => { if (s.value) m.fields[s.dataset.field!] = s.value; });
    const { records, errors } = buildRecords(parsed.features, m, fields, meta.schema.geometry);
    const result = document.getElementById('import-result')!;
    if (!records.length) {
      result.innerHTML = `<p class="warn">Nothing valid to import — ${errors.length} row${errors.length === 1 ? '' : 's'} had problems.</p><button id="dl-errors">Download error file</button>`;
      (document.getElementById('dl-errors') as HTMLButtonElement).onclick = () => downloadText(errorsToCSV(errors), 'import-errors.csv', 'text/csv');
      return;
    }
    btn.disabled = true;
    try {
      const res = await apiJson<{ imported: number; errors: unknown[] }>(`/collections/${ctx.id}/import`, ctx.token, { method: 'POST', body: JSON.stringify({ records }) });
      await refreshCounts();
      void renderPoints();
      toast(`Imported ${res.imported} point${res.imported === 1 ? '' : 's'} ✓`);
      result.innerHTML = `<p class="hint">Imported ${res.imported}.${errors.length ? ` ${errors.length} row${errors.length === 1 ? '' : 's'} skipped (bad data).` : ''}</p>`
        + (errors.length ? `<button id="dl-errors">Download error file</button>` : '');
      if (errors.length) (document.getElementById('dl-errors') as HTMLButtonElement).onclick = () => downloadText(errorsToCSV(errors), 'import-errors.csv', 'text/csv');
    } catch (e) { toast((e as Error).message); btn.disabled = false; }
  };
}

function activeFilter(): string {
  return (document.querySelector('#pfilter .chip.on') as HTMLElement | null)?.dataset.s || '';
}

// Refresh the counts line + filter-chip totals after a moderation/delete.
async function refreshCounts(): Promise<void> {
  try {
    meta = await apiJson<Meta>(`/collections/${ctx.id}`, ctx.token);
    const c = meta.counts;
    const line = document.getElementById('mcounts');
    if (line) line.textContent = `${c.published} approved · ${c.pending} pending · ${c.rejected} rejected`;
    const label: Record<string, string> = { '': `All ${c.total}`, pending: `Pending ${c.pending}`, published: `Approved ${c.published}`, rejected: `Rejected ${c.rejected}` };
    document.querySelectorAll<HTMLElement>('#pfilter .chip').forEach((b) => {
      const t = label[b.dataset.s || ''];
      if (t) b.textContent = t;
    });
  } catch { /* leave stale counts */ }
}

type AdminCtx = { state?: string; district?: string; subdistrict?: string } | null;
function fmtAdminCtx(ctx: AdminCtx): string {
  if (!ctx) return '';
  const parts = [ctx.district, ctx.state].filter(Boolean);
  return parts.length ? ` · 📍 ${parts.join(', ')}` : '';
}

// Queue card label: the record's `name`, else the first author field value
// (the author may have renamed/removed the seeded `name` field).
function cardTitle(props: Record<string, unknown>): string {
  const named = props.name;
  if (typeof named === 'string' && named.trim()) return named;
  for (const [k, v] of Object.entries(props)) {
    if (!k.startsWith('_') && typeof v === 'string' && v.trim()) return v;
  }
  return '(no name)';
}

// The admin point manager: every marked point (filtered) with per-point CRUD —
// approve/reject (moderation), edit (opens the record editor with the admin
// token), delete. Read = list; Update = edit link; Delete = delete; Create =
// the "+ Add points" button (capture) or a contributor's own add.
async function renderPoints(): Promise<void> {
  const q = document.getElementById('points');
  if (!q) return;
  const status = activeFilter();
  q.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const qs = status ? `?status=${status}&limit=300` : '?limit=300';
    const fc = await apiJson<{ features: Feature[] }>(`/collections/${ctx.id}/records${qs}`, ctx.token);
    const feats = fc.features || [];
    if (!feats.length) { q.innerHTML = '<p class="empty">No points here yet. Share the collect link and they will show up as people add them.</p>'; return; }
    q.innerHTML = feats.map((f) => {
      const p = f.properties as { _status?: string; _contributor?: string; _admin_ctx?: AdminCtx };
      const st = p._status || 'published';
      const geom = f.geometry?.type && f.geometry.type !== 'Point' ? `<span class="hint">${nounFor(f.geometry.type)}</span> ` : '';
      // Two action rows (max two buttons each) so labels never wrap: moderation
      // on top, then edit/delete. Better hierarchy, and it fits at 360px.
      const mod = [
        st !== 'published' ? `<button data-act="published" data-id="${f.id}">✓ Approve</button>` : '',
        st === 'pending' ? `<button class="danger" data-act="rejected" data-id="${f.id}">✗ Reject</button>` : '',
      ].filter(Boolean).join('');
      const crud = `<button data-edit="${f.id}">✎ Edit</button><button class="danger" data-del="${f.id}">🗑 Delete</button>`;
      return `<div class="card" data-id="${f.id}">
        <div class="row" style="justify-content:space-between;align-items:center;gap:6px">
          <strong style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${geom}${escapeHtml(cardTitle(f.properties))}</strong>
          <span class="badge badge--${st}">${st}</span>
        </div>
        <div class="hint">${escapeHtml(p._contributor || 'anonymous')}${fmtAdminCtx(p._admin_ctx ?? null)}</div>
        ${mod ? `<div class="row" style="margin-top:8px">${mod}</div>` : ''}
        <div class="row" style="margin-top:8px">${crud}</div>
      </div>`;
    }).join('');

    q.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
      b.onclick = async () => {
        try {
          await apiJson(`/records/${b.dataset.id}/moderate`, ctx.token, { method: 'POST', body: JSON.stringify({ status: b.dataset.act }) });
          await refreshCounts();
          void renderPoints();
        } catch (e) { toast((e as Error).message); }
      };
    });
    q.querySelectorAll<HTMLButtonElement>('button[data-edit]').forEach((b) => {
      b.onclick = () => { location.href = `/c/${ctx.id}/r/${b.dataset.edit}#${ctx.token}`; };
    });
    q.querySelectorAll<HTMLButtonElement>('button[data-del]').forEach((b) => {
      let armed = false;
      b.onclick = async () => {
        if (!armed) { armed = true; b.textContent = 'Tap to confirm'; return; }
        try {
          await apiJson(`/records/${b.dataset.del}`, ctx.token, { method: 'DELETE' });
          await refreshCounts();
          void renderPoints();
        } catch (e) { toast((e as Error).message); }
      };
    });
  } catch (e) {
    q.innerHTML = `<p class="warn">${escapeHtml((e as Error).message)}</p>`;
  }
}

async function doPublish(ev: Event): Promise<void> {
  const btn = ev.currentTarget as HTMLButtonElement;
  btn.disabled = true;
  try {
    const res = await apiJson<{ version: number; share_url: string; feature_count: number }>(
      `/collections/${ctx.id}/publish`, ctx.token, { method: 'POST' },
    );
    toast(`Published v${res.version} · ${res.feature_count} features`);
    const panel = document.getElementById('panel')!;
    panel.innerHTML = `<div class="sheet"><div class="body">
      <strong>Published to the atlas 🎉</strong>
      <p class="hint">Version ${res.version} · ${res.feature_count} features.</p>
      <a class="btn primary" href="${res.share_url}" target="_blank" rel="noopener">View on bharatlas →</a>
      </div><div class="foot"><button id="back">← Back to capture</button></div></div>`;
    (document.getElementById('back') as HTMLButtonElement).onclick = captureSheet;
  } catch (e) {
    toast((e as Error).message);
    btn.disabled = false;
  }
}

// The contributor's own record: edit / delete / de-identify via the rec_ token
// (reached at /c/<id>/r/<record-id>#<rec_>).
async function recordEditor(): Promise<void> {
  const rec = await apiJson<{
    id: string; status: string; contributor: string | null;
    geometry: { type: string; coordinates: number[] };
    properties: Record<string, unknown>;
    schema: { geometry: string[]; fields: Field[]; basemap?: string }; collection_name: string;
  }>(`/records/${ctx.recordId}`, ctx.token);
  const fields = rec.schema.fields.filter((f) => !f.deleted);
  const isPoint = rec.geometry.type === 'Point';
  const noun = nounFor(rec.geometry.type);
  const center = representativeCoord(rec.geometry) ?? INDIA_CENTER;

  app.innerHTML = `
    <div class="topbar"><a href="/c/${ctx.id}#${ctx.token}" aria-label="Back">←</a><span>Your ${noun}</span>
      <span class="muted" style="margin-left:auto">${escapeHtml(rec.collection_name)}</span></div>
    <div class="map">
      <div id="map"></div>${isPoint ? '<div class="crosshair" aria-hidden="true"></div>' : ''}
      <div class="map-loading" id="maploading"><span class="spinner"></span> Loading map…</div>
      ${isPoint ? '<button class="locate" id="locate" aria-label="Use my location">◎</button>' : ''}
    </div>
    <div id="panel"><div class="sheet">
      <form class="body" id="recform">
        <strong>Edit your ${noun}</strong>
        <p class="hint">${isPoint ? 'Move the map to reposition; update the details.' : 'Update the details below.'} Status: ${rec.status}.</p>
        ${fields.map((f) => `<label>${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>${f.hint ? `<p class="hint" style="margin:-2px 0 4px">${escapeHtml(f.hint)}</p>` : ''}${fieldInput(f)}`).join('')}
      </form>
      <div class="foot">
        <button class="primary" id="save">Save changes</button>
        <div class="row" style="margin-top:8px">
          <button type="button" id="deid" style="flex:1"${rec.contributor ? '' : ' disabled'}>Remove my name</button>
          <button type="button" id="del" style="flex:1">Delete ${noun}</button>
        </div>
      </div>
    </div></div>`;

  map = new maplibregl.Map({ container: 'map', style: styleFor(rec.schema.basemap), center, zoom: isPoint ? 16 : 14, attributionControl: false });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.on('load', () => {
    document.getElementById('maploading')?.remove();
    if (isPoint) { marker(center); return; }
    map.addSource('rec', { type: 'geojson', data: { type: 'Feature', geometry: rec.geometry as GeoJSON.Geometry, properties: {} } });
    map.addLayer({ id: 'rec-fill', type: 'fill', source: 'rec', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': ACCENT, 'fill-opacity': 0.15 } });
    map.addLayer({ id: 'rec-line', type: 'line', source: 'rec', filter: ['!=', '$type', 'Point'], paint: { 'line-color': ACCENT, 'line-width': 2.5 } });
  });

  const panel = document.getElementById('panel')!;
  for (const f of fields) {
    const el = panel.querySelector(`[data-k="${f.key}"]`);
    if (!el) continue;
    const val = rec.properties[f.key];
    if (f.type === 'multiselect') {
      const arr = Array.isArray(val) ? val : [];
      el.querySelectorAll<HTMLElement>('.chip').forEach((c) => {
        c.onclick = () => c.classList.toggle('on');
        if (arr.includes(c.dataset.v)) c.classList.add('on');
      });
    } else if (val != null) {
      (el as HTMLInputElement).value = String(val);
    }
  }

  const locateBtn = document.getElementById('locate') as HTMLButtonElement | null;
  if (locateBtn) locateBtn.onclick = () => {
    if (!navigator.geolocation) return toast('Location not available');
    navigator.geolocation.getCurrentPosition(
      (pos) => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 16 }),
      () => toast("Couldn't get your location"), { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  (document.getElementById('save') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const form = document.getElementById('recform') as HTMLFormElement;
    if (!form.reportValidity()) return;
    btn.disabled = true;
    try {
      const raw: Record<string, unknown> = {};
      for (const f of fields) {
        const el = panel.querySelector(`[data-k="${f.key}"]`);
        if (!el) continue;
        if (f.type === 'multiselect') {
          const on = [...el.querySelectorAll('.chip.on')].map((c) => (c as HTMLElement).dataset.v);
          if (on.length) raw[f.key] = on;
        } else {
          const v = (el as HTMLInputElement).value; if (v) raw[f.key] = v;
        }
      }
      const valid = validateRecordProperties(fields, raw);
      if (!valid.ok) { toast(valid.error); btn.disabled = false; return; }
      // Points can be repositioned by panning; shapes edit properties only.
      const body: Record<string, unknown> = { properties: valid.properties };
      if (isPoint) { const c = map.getCenter(); body.geometry = { type: 'Point', coordinates: [c.lng, c.lat] }; }
      await apiJson(`/records/${ctx.recordId}`, ctx.token, { method: 'PATCH', body: JSON.stringify(body) });
      toast('Saved ✓');
    } catch (e) { toast((e as Error).message); }
    btn.disabled = false;
  };

  (document.getElementById('deid') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      await apiJson(`/records/${ctx.recordId}/deidentify`, ctx.token, { method: 'POST' });
      toast('Your name was removed ✓');
    } catch (e) { toast((e as Error).message); btn.disabled = false; }
  };

  let delArmed = false;
  (document.getElementById('del') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    if (!delArmed) { delArmed = true; btn.textContent = 'Tap again to delete'; return; }
    btn.disabled = true;
    try {
      await apiJson(`/records/${ctx.recordId}`, ctx.token, { method: 'DELETE' });
      app.innerHTML = `<div class="pad"><h1>${noun[0].toUpperCase()}${noun.slice(1)} deleted</h1><p class="hint">Your contribution was removed.</p><a class="btn" href="/c/${ctx.id}#${ctx.token}">← Back to the map</a></div>`;
    } catch (e) { toast((e as Error).message); btn.disabled = false; }
  };
}

const initCtx = parseCtx();
if (!initCtx?.token) {
  app.innerHTML = `<div class="pad"><h1>Invalid link</h1><p class="hint">Open a collect link (with its token in the URL) to continue.</p></div>`;
} else {
  ctx = initCtx;
  app.innerHTML = `<div class="pad center"><span class="spinner"></span><p class="hint">Loading…</p></div>`;
  (initCtx.mode === 'record' ? recordEditor() : boot()).catch((e) => {
    app.innerHTML = `<div class="pad"><h1>Couldn't load</h1><p class="warn">${(e as Error).message}</p></div>`;
  });
}
