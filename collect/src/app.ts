// The /c/<id>[/admin|/view] app: a full-bleed map with a fixed crosshair for
// pin-drop, an "Use my location" button (geolocation called synchronously in the
// tap handler), a bottom-sheet form generated from the collection's schema, and
// — for admin — a review queue + publish. Mobile-first.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildBaseStyle, setBasemap, getStoredBasemap, setStoredBasemap, normalizeBasemap, BASEMAPS, INDIA_CENTER, type BasemapId } from './basemap';
import { addReferenceOverlay, setReferenceVisible } from './geo/reference';
import { type RefLayer } from './geo/catalog';
import { mountLayerPicker } from './geo/layer-picker';
import { CATEGORIES, OPEN_LICENCES } from './options';
import { parseCtx, apiJson, type Ctx } from './api';
import { turnstileToken } from './turnstile';
import { validateRecordProperties, type Field } from './schema/validate-record';
import { orderedModes, drawGeometry, type GeomMode, type Coord } from './geo/draw';
import { representativeCoord } from './geo/admin-ctx';
import { geometryLngLats } from './geo/coords';
import { statusOf, filterByStatus, countsOf, popupActions, recordWho } from './review';
import { escapeHtml } from './util';
import { toGeoJSON, toCSV, toKML, type ExportFeature } from './export/formats';
import { detectFormat, parseImport, type Parsed } from './import/parse';
import { autoMapping, buildRecords, errorsToCSV, type Mapping } from './import/build';
import { rememberMap } from './maps-store';
import { linksMailtoHref, type MapLinks } from './share';
import { shareItemHtml, wireShareItems } from './share-ui';
interface Counts { pending: number; published: number; total: number; rejected: number; }
interface Meta {
  id: string; name: string; purpose: string; description: string | null; data_year: number | null; status: string; moderation: number; license: string;
  schema: { geometry: string[]; fields: Field[]; category?: string; basemap?: string; reference_layer?: { id: string; pmtiles_url: string } | null }; counts: Counts;
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

// A grab handle — the first child of every collapsible bottom sheet.
const GRAB = '<button type="button" class="grab" aria-expanded="true" aria-label="Collapse or expand this panel"></button>';

// ── sheet metrics ────────────────────────────────────────────────────────
// Keep --sheet-h current so the crosshair + floating map buttons sit above the
// panel, and let the grab handle collapse the sheet to a peek (map takes over).
function setSheetVar(px: number): void {
  document.getElementById('app')?.style.setProperty('--sheet-h', `${Math.max(0, Math.round(px))}px`);
}
function updateSheetMetrics(): void {
  const sheet = document.querySelector('#panel .sheet, #panel .bar') as HTMLElement | null;
  if (!sheet) { setSheetVar(0); return; }
  if (sheet.classList.contains('collapsed')) {
    // match the CSS peek strip, so the crosshair/buttons line up with the handle
    setSheetVar(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--peek-h')) || 30);
    return;
  }
  setSheetVar(sheet.getBoundingClientRect().height);
}
let sheetMetricsInstalled = false;
function installSheetMetrics(): void {
  if (sheetMetricsInstalled) return;
  sheetMetricsInstalled = true;
  const appEl = document.getElementById('app')!;
  new MutationObserver(() => requestAnimationFrame(updateSheetMetrics)).observe(appEl, { childList: true, subtree: true });
  appEl.addEventListener('click', (e) => {
    const grab = (e.target as HTMLElement).closest('.grab');
    if (!grab) return;
    const sheet = grab.closest('.sheet');
    const collapsed = sheet?.classList.toggle('collapsed') ?? false;
    grab.setAttribute('aria-expanded', String(!collapsed));
    // keep the grab operable, but pull the now-offscreen content out of the tab order
    sheet?.querySelectorAll('.body, .foot').forEach((el) => {
      if (collapsed) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    });
    updateSheetMetrics();
  });
  window.addEventListener('resize', () => requestAnimationFrame(updateSheetMetrics));
  requestAnimationFrame(updateSheetMetrics);
}

// The lng/lat under the crosshair. The crosshair rides above the sheet (not at
// the map's geometric centre), so read its real screen position and unproject:
// the placed point is exactly what the user sees targeted. Falls back to the map
// centre when there is no visible crosshair (missing, or display:none in view mode).
function crosshairLngLat(): [number, number] {
  const ch = document.querySelector('.crosshair') as HTMLElement | null;
  const cr = map.getCanvas().getBoundingClientRect();
  if (ch) {
    const r = ch.getBoundingClientRect();
    if (r.width !== 0) {
      const ll = map.unproject([r.left + r.width / 2 - cr.left, r.top + r.height / 2 - cr.top]);
      return [ll.lng, ll.lat];
    }
  }
  const c = map.getCenter();
  return [c.lng, c.lat];
}

// The crosshair's offset from the map centre, in screen px. Pass as a flyTo/easeTo
// `offset` to bring a coordinate UNDER the crosshair (locate, or framing an edited
// point). [0,0] when there is no visible crosshair, so it is a safe no-op.
function crosshairScreenOffset(): [number, number] {
  const ch = document.querySelector('.crosshair') as HTMLElement | null;
  if (!ch) return [0, 0];
  const r = ch.getBoundingClientRect();
  if (r.width === 0) return [0, 0];
  const cr = map.getCanvas().getBoundingClientRect();
  return [r.left + r.width / 2 - cr.left - cr.width / 2, r.top + r.height / 2 - cr.top - cr.height / 2];
}

// The on-map "Base map" switcher: a button + a small menu of the four basemaps.
// Switching flips layer visibility (setBasemap), so overlays + markers survive.
function installBasemapSwitcher(initial: BasemapId): void {
  const btn = document.getElementById('basemapbtn');
  const menu = document.getElementById('basemapmenu');
  if (!btn || !menu) return;
  let active = initial;
  const close = (): void => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const render = (): void => {
    menu.innerHTML = BASEMAPS.map((b) => `<button type="button" role="menuitemradio" aria-checked="${b.id === active}" class="basemap-opt${b.id === active ? ' on' : ''}" data-b="${b.id}"><strong>${escapeHtml(b.name)}</strong><span class="hint">${escapeHtml(b.hint)}</span></button>`).join('');
    menu.querySelectorAll<HTMLButtonElement>('.basemap-opt').forEach((o) => {
      o.onclick = () => { active = o.dataset.b as BasemapId; setBasemap(map, active); setStoredBasemap(active); render(); close(); };
    });
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    if (menu.hidden) { render(); menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); } else close();
  };
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== btn) close(); });
  render();
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
  // Autosave to "Your maps" so a shared collect/view link is one tap to reopen.
  rememberMap(ctx.id, meta.name, isAdmin ? 'owner' : isView ? 'view' : 'collect', location.href);

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
      <button class="locate" id="basemapbtn" aria-label="Base map" title="Base map" aria-haspopup="true" aria-expanded="false" style="left:12px;top:12px;right:auto;bottom:auto">◱</button>
      <div class="basemap-menu" id="basemapmenu" role="menu" aria-label="Base map" hidden></div>
      ${meta.schema.reference_layer ? '<button class="locate" id="reftoggle" aria-label="Reference layer" title="Reference layer" aria-pressed="true" style="left:12px;top:66px;right:auto;bottom:auto">◪</button>' : ''}
      ${isAdmin ? `<button class="locate" id="manage" aria-label="Manage map${meta.counts.pending ? `, ${meta.counts.pending} pending review` : ''}" style="left:12px;right:auto;bottom:76px;width:auto;padding:0 14px">⚙${meta.counts.pending ? ` ${meta.counts.pending}` : ''}</button>` : ''}
    </div>
    <div id="panel"></div>`;
  installSheetMetrics();

  const initialBasemap = getStoredBasemap() ?? normalizeBasemap(meta.schema.basemap);
  map = new maplibregl.Map({
    container: 'map', style: buildBaseStyle(initialBasemap), center: INDIA_CENTER, zoom: 4,
    attributionControl: false,
  });
  // Attribution bottom-left so it never sits under the locate button (bottom-right).
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  installBasemapSwitcher(initialBasemap);
  drawReady = false; verts = [];
  allowsShapes = orderedModes(meta.schema.geometry).some((m) => m !== 'point');
  map.on('load', () => {
    document.getElementById('maploading')?.remove();
    if (!isView && allowsShapes) setupDrawLayers();
    if (meta.schema.reference_layer) void addReferenceOverlay(map, meta.schema.reference_layer.pmtiles_url).catch(() => {});
    if (isAdmin) syncReviewLayer();   // admin: the clickable, status-coloured review layer (driven by the list)
    else void loadRecords();          // view / collect: published points as context
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
        (pos) => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 16, offset: crosshairScreenOffset() }),
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
  panel.innerHTML = `<div class="sheet">${GRAB}<div class="body">
    <strong>${escapeHtml(meta.name)}</strong>
    ${meta.purpose ? `<p class="hint">${escapeHtml(meta.purpose)}</p>` : ''}
    <p class="hint">${n ? `${n} point${n === 1 ? '' : 's'} on the map.` : 'No points published yet.'}</p>
    ${safetyFooter()}
  </div></div>`;
}

let recordShapes: GeoJSON.Feature[] = [];
let reviewFeats: Feature[] = [];               // the current filter's rows (a slice of allFeats)
let allFeats: Feature[] = [];                  // every record, fetched once; chips filter this in memory
let reviewLoaded = false;                      // is allFeats fresh? (invalidated on moderate/delete/import/add)
let reviewGen = 0;                             // bumps on invalidation, so a stale in-flight fetch is discarded
let lastReviewFetch = 0;                        // Date.now() of the last records fetch (throttles revalidation)

// A local record change invalidates the cache AND advances the generation, so a
// records fetch already in flight won't overwrite the cache with pre-change data.
function invalidateReview(): void { reviewLoaded = false; reviewGen++; }
let reviewMarker: maplibregl.Marker | undefined; // highlight on the map during review
let selectedIdx: number | null = null;         // the linked map<->list selection
let recordPopup: maplibregl.Popup | undefined; // the on-map attribute tooltip

// ── linked map <-> list (admin review) ───────────────────────────────────
// The review features get their own clickable, status-coloured layer keyed to the
// list rows, so clicking a marker highlights + scrolls its entry (and pops a
// tooltip), and clicking a row flies to and highlights the marker.
const STATUS_COLOR = ['match', ['get', 'status'], 'pending', '#d97706', 'rejected', '#dc2626', ACCENT] as maplibregl.ExpressionSpecification;

function reviewFC(): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: reviewFeats.map((f, idx) => ({
      type: 'Feature',
      id: idx, // numeric id so feature-state (the selection highlight) works
      geometry: f.geometry as GeoJSON.Geometry,
      properties: { idx, status: statusOf(f) },
    })),
  };
}

// Draw / update the review layer from reviewFeats. Safe to call before the style
// loads (it no-ops, and the map-load handler calls it again) or repeatedly.
function syncReviewLayer(): void {
  if (!map.isStyleLoaded()) return;
  const src = map.getSource('review') as maplibregl.GeoJSONSource | undefined;
  if (src) { src.setData(reviewFC()); return; }
  map.addSource('review', { type: 'geojson', data: reviewFC() });
  map.addLayer({
    id: 'review-fill', type: 'fill', source: 'review', filter: ['==', '$type', 'Polygon'],
    paint: { 'fill-color': STATUS_COLOR, 'fill-opacity': ['case', ['boolean', ['feature-state', 'sel'], false], 0.3, 0.12] },
  });
  map.addLayer({
    id: 'review-line', type: 'line', source: 'review', filter: ['!=', '$type', 'Point'],
    paint: { 'line-color': STATUS_COLOR, 'line-width': ['case', ['boolean', ['feature-state', 'sel'], false], 4, 2] },
  });
  map.addLayer({
    id: 'review-pt', type: 'circle', source: 'review', filter: ['==', '$type', 'Point'],
    paint: {
      'circle-radius': ['case', ['boolean', ['feature-state', 'sel'], false], 9, 6],
      'circle-color': STATUS_COLOR,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['case', ['boolean', ['feature-state', 'sel'], false], 3, 2],
    },
  });
  for (const id of ['review-pt', 'review-fill', 'review-line']) {
    map.on('click', id, (e) => {
      const idx = e.features?.[0]?.properties?.idx;
      if (typeof idx === 'number') selectFromMap(idx);
    });
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
}

// Set (or clear, with null) the map-side selection highlight via feature-state.
function selectReviewFeature(idx: number | null): void {
  if (map.getSource('review')) {
    if (selectedIdx !== null) map.removeFeatureState({ source: 'review', id: selectedIdx }, 'sel');
    if (idx !== null) map.setFeatureState({ source: 'review', id: idx }, { sel: true });
  }
  selectedIdx = idx;
}

function clearSelection(): void {
  recordPopup?.remove();
  recordPopup = undefined;
  selectReviewFeature(null);
  clearRowSelection();
}

// The on-map attribute tooltip for a record. It carries the record's moderation
// actions inline (approve / reject / open) so an admin with hundreds of points
// can pan, tap a marker, and act on just that one — no list scrolling. "Open"
// drops into the full detail sheet (edit / delete / every attribute).
function showRecordPopup(idx: number, coord: [number, number]): void {
  const f = reviewFeats[idx];
  if (!f) return;
  const p = f.properties as { _status?: string; [k: string]: unknown };
  const st = p._status || 'published';
  const rows = attrRowsHtml(p, 'pop-attr');
  const actions = popupActions(st)
    .map((a) => `<button type="button" class="pop-btn ${a.cls}" data-act="${a.act}">${escapeHtml(a.label)}</button>`)
    .join('');
  const html = `<div class="pop">
      <div class="pop-head"><strong>${escapeHtml(cardTitle(p))}</strong><span class="badge badge--${st}">${st}</span></div>
      <div class="pop-attrs">${rows || '<p class="hint" style="margin:0">No fields on this map.</p>'}</div>
      <div class="pop-actions">${actions}</div>
    </div>`;
  recordPopup?.remove();
  recordPopup = new maplibregl.Popup({ closeOnClick: false, maxWidth: '280px', offset: 14, className: 'record-popup' })
    .setLngLat(coord).setHTML(html).addTo(map);
  recordPopup.getElement()?.querySelectorAll<HTMLButtonElement>('.pop-actions .pop-btn').forEach((b) => {
    const act = b.dataset.act!;
    b.addEventListener('click', () => (act === 'open' ? openReview(idx) : void moderateFromMap(String(f.id), act)));
  });
  recordPopup.on('close', () => { if (selectedIdx === idx) clearSelection(); });
}

// Moderate a record straight from its map tooltip, then repaint in place and stay
// on the map (the fast field-review path). Errors surface as a toast.
async function moderateFromMap(id: string, status: string): Promise<void> {
  try {
    await apiJson(`/records/${id}/moderate`, ctx.token, { method: 'POST', body: JSON.stringify({ status }) });
    toast(status === 'published' ? 'Approved ✓' : 'Rejected');
    await refreshReviewSurfaces();
  } catch (e) { toast((e as Error).message); }
}

// Repaint whatever review surfaces are live after a mutation: always the map
// layer, plus the list + counts when the manage sheet is showing. Clears the
// tooltip/highlight so the just-moderated point doesn't keep a stale popup.
async function refreshReviewSurfaces(): Promise<void> {
  invalidateReview();
  await ensureReviewData(true);
  if (document.getElementById('points')) {
    updateReviewCounts(meta.counts);
    renderPoints();            // recomputes reviewFeats for the active filter + repaints the layer (also clears the selection)
  } else {
    reviewFeats = filterByStatus(allFeats, activeFilter());
    syncReviewLayer();
    clearSelection();
  }
}

// A marker/shape was tapped: highlight it, pop the tooltip, and highlight +
// scroll the matching list row (when the review list is showing).
function selectFromMap(idx: number): void {
  selectReviewFeature(idx);
  clearRowSelection();
  const row = document.querySelector<HTMLElement>(`.point-row[data-idx="${idx}"]`);
  if (row) { row.classList.add('point-row--sel'); row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  const c = representativeCoord(reviewFeats[idx]?.geometry);
  if (c) {
    showRecordPopup(idx, c);
    map.easeTo({ center: c, offset: sheetLiftOffset(), duration: 300 });
  }
}

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

let didFit = false; // fit the camera to the data once, on first load (see fitToFeatures)

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
    fitToFeatures(fc.features || []);
  } catch { /* map still usable */ }
}

// Zoom/pan so all the loaded features sit in the viewport (above the sheet). Runs
// once (a map full of points opening at India level looks empty); an empty first
// load doesn't burn the one-shot, so the fit still happens when data first arrives.
function fitToFeatures(feats: Feature[]): void {
  if (didFit) return;
  const b = new maplibregl.LngLatBounds();
  for (const f of feats) {
    if (f.geometry && 'coordinates' in f.geometry) {
      for (const ll of geometryLngLats(f.geometry.coordinates)) b.extend(ll);
    }
  }
  if (b.isEmpty()) return;
  didFit = true;
  // --sheet-h may not be measured yet on the admin path; fall back to a generous
  // share of the viewport so points never fit UNDER where the sheet will be.
  const sheetH = parseFloat(getComputedStyle(document.getElementById('app')!).getPropertyValue('--sheet-h')) || Math.round(window.innerHeight * 0.45);
  map.fitBounds(b, { padding: { top: 64, bottom: Math.round(sheetH) + 48, left: 40, right: 40 }, maxZoom: 16, duration: 0 });
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
    verts.push(crosshairLngLat()); redrawDraw(); syncDrawUI();
  };
  (document.getElementById('vundo') as HTMLButtonElement).onclick = () => {
    verts.pop(); redrawDraw(); syncDrawUI();
  };
  (document.getElementById('place') as HTMLButtonElement).onclick = () => {
    const geometry = drawGeometry(drawMode, verts, crosshairLngLat());
    if (!geometry) { toast(`A ${NOUN[drawMode]} needs ${drawMode === 'line' ? '2' : '3'} points or more`); return; }
    detailsSheet(geometry, modes);
  };
}

function detailsSheet(geometry: GeoJSON.Geometry, modes: GeomMode[]): void {
  const fields = meta.schema.fields.filter((f) => !f.deleted);
  const noun = NOUN[drawMode];
  const panel = document.getElementById('panel')!;
  panel.innerHTML = `<div class="sheet">
    ${GRAB}
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
      invalidateReview(); // a new record invalidates the review cache
      // In admin the status-coloured review layer owns the on-map display; a plain
      // pin here would double it once they return to Review. Contributors get the pin.
      if (ctx.mode !== 'admin') {
        if (geometry.type === 'Point') marker((geometry as GeoJSON.Point).coordinates as number[]);
        else addRecordShape(geometry);
      }
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

// Admin "Edit map settings" — fix the name/description/purpose/category/data
// year + map background/reference layer. Licence editable only with no records.
async function editSettings(): Promise<void> {
  const panel = document.getElementById('panel')!;
  const s = meta.schema;
  const locked = meta.counts.total > 0;
  const sel = (v: string, cur: string): string => (v === cur ? ' selected' : '');
  panel.innerHTML = `<div class="sheet">
    ${GRAB}
    <form class="body" id="editform">
      <strong>Edit map settings</strong>
      <label>Name</label><input id="e-name" maxlength="120" value="${escapeHtml(meta.name)}" required />
      <label>What's it for?</label><textarea id="e-purpose" maxlength="2000">${escapeHtml(meta.purpose)}</textarea>
      <label>Description <span class="hint">(optional)</span></label><input id="e-desc" maxlength="2000" value="${escapeHtml(meta.description || '')}" />
      <label>Category</label><select id="e-category">${CATEGORIES.map(([id, l]) => `<option value="${id}"${sel(id, s.category || 'other')}>${l}</option>`).join('')}</select>
      <label>Data year <span class="hint">(optional)</span></label><input id="e-year" inputmode="numeric" value="${meta.data_year ?? ''}" />
      <label>Reference layer</label>
      <div id="e-refnow">${s.reference_layer ? `<div class="link-box"><code>${escapeHtml(s.reference_layer.id)}</code><button type="button" id="e-ref-remove">Remove</button></div>` : '<p class="hint">None.</p>'}</div>
      <input id="e-ref-search" placeholder="Browse layers, or type to filter…" autocomplete="off" />
      <div id="e-ref-results" class="ref-results"></div>
      <label>Licence</label>
      ${locked ? `<p class="hint">${escapeHtml(meta.license)}, locked now the map has points.</p>` : `<select id="e-license">${OPEN_LICENCES.map(([id, l]) => `<option value="${id}"${sel(id, meta.license)}>${l}</option>`).join('')}</select>`}
    </form>
    <div class="foot row">
      <button type="button" id="e-cancel">← Back</button>
      <button class="primary" id="e-save" style="flex:1">Save settings</button>
    </div>
  </div>`;

  // reference change: undefined = leave as-is; null = remove; RefLayer = replace
  let refChange: RefLayer | null | undefined;
  const refNow = document.getElementById('e-refnow')!;
  (document.getElementById('e-ref-remove') as HTMLButtonElement | null)?.addEventListener('click', () => {
    refChange = null; refNow.innerHTML = '<p class="hint">Will be removed on save.</p>';
  });
  const results = document.getElementById('e-ref-results')!;
  const searchEl = document.getElementById('e-ref-search') as HTMLInputElement;
  mountLayerPicker(searchEl, results, (l) => {
    refChange = l; results.innerHTML = ''; searchEl.value = '';
    refNow.innerHTML = `<div class="link-box"><code>${escapeHtml(l.label)}</code></div>`;
  });

  (document.getElementById('e-cancel') as HTMLButtonElement).onclick = () => void manageSheet();
  (document.getElementById('e-save') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    if (!(document.getElementById('editform') as HTMLFormElement).reportValidity()) return;
    const yr = (document.getElementById('e-year') as HTMLInputElement).value.trim();
    const patch: Record<string, unknown> = {
      name: (document.getElementById('e-name') as HTMLInputElement).value,
      purpose: (document.getElementById('e-purpose') as HTMLTextAreaElement).value,
      description: (document.getElementById('e-desc') as HTMLInputElement).value,
      category: (document.getElementById('e-category') as HTMLSelectElement).value,
      data_year: yr === '' ? null : Number(yr),
    };
    if (!locked) patch.license = (document.getElementById('e-license') as HTMLSelectElement).value;
    if (refChange !== undefined) patch.reference_layer = refChange ? { id: refChange.id, pmtiles_url: refChange.pmtiles_url } : null;
    // Only a reference-overlay change needs a reload to re-style the map; the
    // basemap is a per-viewer runtime switch, not an author setting.
    const mapChanged = refChange !== undefined;
    btn.disabled = true;
    try {
      await apiJson(`/collections/${ctx.id}`, ctx.token, { method: 'PATCH', body: JSON.stringify(patch) });
      toast('Settings saved ✓');
      if (mapChanged) { location.reload(); return; } // reload to apply the new basemap/overlay
      meta = await apiJson<Meta>(`/collections/${ctx.id}`, ctx.token);
      // Reflect a rename in the topbar AND the saved "Your maps" list (localStorage
      // was the stale surface — it doesn't re-read the server on refresh).
      const nameEl = document.querySelector('.topbar span');
      if (nameEl) nameEl.textContent = meta.name;
      rememberMap(ctx.id, meta.name, 'owner', location.href);
      void manageSheet();
    } catch (e) { toast((e as Error).message); btn.disabled = false; }
  };
}

// The admin sheet is tabbed so each job stands alone (the old one-scroll panel
// stacked review + share + download + import together). Review is the daily job
// and stays the default; Share and Data sit one tap away. Publish + Add points
// stay in the footer, reachable from any tab.
type ManageTab = 'review' | 'share' | 'data';
let manageTab: ManageTab = 'review';
// Links minted this session, so re-opening a link row returns the same one.
const minted: { edit?: string; view?: string } = {};

async function manageSheet(): Promise<void> {
  clearHighlight(); // leaving a review detail clears the map highlight
  // meta was loaded at boot; counts are kept fresh from the record cache, so no
  // per-open refetch (this ran on every tab-in and every back-out of a review).
  const c = meta.counts;
  const panel = document.getElementById('panel')!;
  panel.innerHTML = `<div class="sheet">
    ${GRAB}
    <div class="body">
      <div class="row" style="justify-content:space-between;align-items:center">
        <strong>Manage map</strong>
        <button id="edit-settings" style="min-height:36px;font-size:13px">✎ Settings</button>
      </div>
      <div class="tabs" id="mtabs" role="tablist" aria-label="Manage sections">
        <button type="button" role="tab" data-t="review">Review${c.pending ? ` · ${c.pending}` : ''}</button>
        <button type="button" role="tab" data-t="share">Share</button>
        <button type="button" role="tab" data-t="data">Data</button>
      </div>
      <div id="tabbody" role="tabpanel" tabindex="0"></div>
    </div>
    <div class="foot row">
      <button id="back">+ Add points</button>
      <button class="primary" id="publish" style="flex:1">Submit → catalog</button>
    </div>
  </div>`;
  (document.getElementById('back') as HTMLButtonElement).onclick = captureSheet;
  (document.getElementById('publish') as HTMLButtonElement).onclick = confirmPublish;
  (document.getElementById('edit-settings') as HTMLButtonElement).onclick = () => void editSettings();
  document.querySelectorAll<HTMLButtonElement>('#mtabs button').forEach((b) => {
    b.onclick = () => { manageTab = b.dataset.t as ManageTab; renderManageTab(); };
  });
  renderManageTab();
}

function renderManageTab(): void {
  document.querySelectorAll<HTMLElement>('#mtabs button').forEach((b) => {
    const on = b.dataset.t === manageTab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  const body = document.getElementById('tabbody');
  if (!body) return;
  if (manageTab !== 'review') clearSelection(); // don't leave a tooltip/highlight behind
  if (manageTab === 'share') return renderShareTab(body);
  if (manageTab === 'data') return renderDataTab(body);
  return renderReviewTab(body);
}

// Review: moderate the points. The records are fetched ONCE (ensureReviewData);
// the filter chips slice that cache in memory, so a chip tap is instant.
function renderReviewTab(body: HTMLElement): void {
  const c = reviewLoaded ? countsOf(allFeats) : meta.counts;
  body.innerHTML = `
    <p class="hint" id="mcounts">${c.published} approved · ${c.pending} pending · ${c.rejected} rejected</p>
    ${c.pending ? `<div class="notice">
      <div><strong>${c.pending} point${c.pending === 1 ? '' : 's'} awaiting your approval.</strong> People you share the map with can't see ${c.pending === 1 ? 'it' : 'them'}, and ${c.pending === 1 ? "it isn't" : "they aren't"} exported or published to the catalog until you approve.</div>
      <button type="button" class="primary" id="approve-all">✓ Approve all ${c.pending}</button>
    </div>` : ''}
    <div class="row" id="pfilter" style="margin:8px 0 4px">
      <button type="button" class="chip on" data-s="">All ${c.total}</button>
      <button type="button" class="chip" data-s="pending">Pending ${c.pending}</button>
      <button type="button" class="chip" data-s="published">Approved ${c.published}</button>
      ${c.rejected ? `<button type="button" class="chip" data-s="rejected">Rejected ${c.rejected}</button>` : ''}
    </div>
    <div id="points"><p class="hint">Loading points…</p></div>`;
  const approveAll = document.getElementById('approve-all') as HTMLButtonElement | null;
  if (approveAll) approveAll.onclick = async () => {
    approveAll.disabled = true;
    try {
      const res = await apiJson<{ changed: number }>(`/collections/${ctx.id}/moderate-all`, ctx.token, { method: 'POST', body: JSON.stringify({ to: 'published' }) });
      invalidateReview();
      await ensureReviewData(true);
      toast(`Approved ${res.changed} ✓`);
      renderManageTab(); // rebuild: notice clears, points show approved, counts refresh
    } catch (e) { toast((e as Error).message); approveAll.disabled = false; }
  };
  document.querySelectorAll<HTMLButtonElement>('#pfilter .chip').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#pfilter .chip').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      renderPoints(); // in-memory filter — instant, no network
    };
  });
  if (reviewLoaded) {
    renderPoints();      // instant from the cache
    revalidateReview();  // quietly pull fresh data so submissions from elsewhere show up
  } else {
    void ensureReviewData().then(() => {
      const q = document.getElementById('points');
      if (!reviewLoaded) { if (q) q.innerHTML = '<p class="warn">Could not load points. Tap Review again to retry.</p>'; return; }
      updateReviewCounts(meta.counts);
      renderPoints();
    });
  }
}

// Stale-while-revalidate: the list is shown from cache instantly, then this quietly
// refetches (throttled) so points added or moderated elsewhere appear without a
// manual reload. It only re-renders when the record set actually changed, so it
// never yanks the list out from under the admin mid-scroll.
function reviewSig(): string {
  return `${allFeats.length}|${allFeats.map((f) => `${f.id}:${statusOf(f)}`).join(',')}`;
}
function revalidateReview(): void {
  if (Date.now() - lastReviewFetch < 3000) return; // just fetched — don't spam the network
  const before = reviewSig();
  void ensureReviewData(true).then(() => {
    if (reviewSig() !== before) { updateReviewCounts(meta.counts); renderPoints(); }
  });
}

// Share: each link is a collapsible row — tap it to reveal Copy / Share / QR.
// The admin link is this device's URL; collect and view links are minted lazily
// the first time their row is opened (so there's no confusing "+ create" button —
// the link already exists conceptually, opening the row just reveals it).
type LinkRow = { role: string; perm?: 'edit' | 'view'; icon: string; title: string; hint: string; note?: string };
const LINK_ROWS: LinkRow[] = [
  { role: 'admin', icon: '🔑', title: 'Admin link', hint: 'this device, keep secret', note: 'Use this to open the map on your other device. Keep it private.' },
  { role: 'collect', perm: 'edit', icon: '🔗', title: 'Collect link', hint: 'lets people add points' },
  { role: 'view', perm: 'view', icon: '👁', title: 'View-only link', hint: 'read only' },
];

// A one-line reminder that pending points are held back (invisible to shared
// links, excluded from exports) — shown atop Share + Data so the consequence sits
// where the owner acts. The Review tab carries the full notice + Approve-all.
function pendingHint(): string {
  const c = reviewLoaded ? countsOf(allFeats) : meta.counts;
  if (!c.pending) return '';
  return `<div class="notice notice--inline"><div><strong>${c.pending} point${c.pending === 1 ? '' : 's'} pending.</strong> Held back from people you share with, and from exports, until approved in Review.</div></div>`;
}

function renderShareTab(body: HTMLElement): void {
  const title = meta.name || 'bharatlas collect map';
  const adminLink = location.href;
  body.innerHTML = `
    ${pendingHint()}
    <p class="hint">Tap a link to open its copy options. No accounts, so the link is the key: whoever holds it can use it at that level.</p>
    ${LINK_ROWS.map((r) => `<div class="linkrow" data-role="${r.role}">
      <button type="button" class="linkrow__head" aria-expanded="false">
        <span class="linkrow__title">${r.icon} ${escapeHtml(r.title)} <span class="hint">${escapeHtml(r.hint)}</span></span>
        <span class="linkrow__chev" aria-hidden="true">▾</span>
      </button>
      <div class="linkrow__body" hidden></div>
    </div>`).join('')}
    <a class="btn wide" id="email-links" style="margin-top:12px">✉ Email these links to me</a>`;

  const emailA = document.getElementById('email-links') as HTMLAnchorElement;
  const refreshEmail = (): void => { emailA.href = linksMailtoHref({ admin: adminLink, ...minted } as MapLinks, meta.name); };
  refreshEmail();

  // The URL for a row — admin is this page; collect/view mint once, then cache.
  const linkFor = async (r: LinkRow): Promise<string | null> => {
    if (r.role === 'admin') return adminLink;
    const perm = r.perm!;
    if (minted[perm]) return minted[perm]!;
    try {
      const res = await apiJson<{ link: string }>(`/collections/${ctx.id}/tokens`, ctx.token, { method: 'POST', body: JSON.stringify({ permission: perm }) });
      minted[perm] = res.link;
      refreshEmail();
      return res.link;
    } catch (e) { toast((e as Error).message); return null; }
  };

  let busy = false; // a mint is in flight — block other taps (else double-mint / two rows open)
  LINK_ROWS.forEach((r) => {
    const row = body.querySelector<HTMLElement>(`.linkrow[data-role="${r.role}"]`)!;
    const head = row.querySelector<HTMLButtonElement>('.linkrow__head')!;
    const bodyEl = row.querySelector<HTMLElement>('.linkrow__body')!;
    head.onclick = async () => {
      if (busy) return;
      const wasOpen = !bodyEl.hasAttribute('hidden');
      // accordion: only one row open at a time — collapse them all first
      body.querySelectorAll('.linkrow__body').forEach((b) => b.setAttribute('hidden', ''));
      body.querySelectorAll('.linkrow__head').forEach((h) => h.setAttribute('aria-expanded', 'false'));
      if (wasOpen) return; // toggling the open row closed
      if (!bodyEl.dataset.filled) {
        busy = true;
        head.setAttribute('aria-busy', 'true');
        const url = await linkFor(r);
        head.removeAttribute('aria-busy');
        busy = false;
        if (!url) return;
        bodyEl.innerHTML = shareItemHtml(r.role, '', url, r.note); // no label — the row header is the label
        wireShareItems(bodyEl, title);
        bodyEl.dataset.filled = '1';
      }
      bodyEl.removeAttribute('hidden');
      head.setAttribute('aria-expanded', 'true');
    };
  });
}

// Data: download every point, or bulk-import a file.
function renderDataTab(body: HTMLElement): void {
  body.innerHTML = `
    ${pendingHint()}
    <strong style="display:block">Download the data</strong>
    <p class="hint">Every approved point, to use anywhere.</p>
    <div class="row">
      <button data-dl="geojson">GeoJSON</button>
      <button data-dl="csv">CSV</button>
      <button data-dl="kml">KML</button>
    </div>
    <strong style="display:block;margin-top:14px">Import data</strong>
    <p class="hint">Add many points at once from a CSV, GeoJSON or KML file.</p>
    <label class="btn wide" style="cursor:pointer">⬆ Choose a file<input id="import-file" type="file" accept=".csv,.geojson,.json,.kml" hidden></label>
    <div id="import-panel"></div>
    ${safetyFooter()}`;
  body.querySelectorAll<HTMLButtonElement>('button[data-dl]').forEach((b) => {
    b.onclick = () => void downloadData(b.dataset.dl as 'geojson' | 'csv' | 'kml');
  });
  (document.getElementById('import-file') as HTMLInputElement).onchange = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void importFlow(file);
  };
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
    `<option value="">choose a column</option>` + parsed.columns.map((c) => `<option${c === sel ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
  const n = parsed.features.length;
  // A column map (applies to ALL rows), not a single-record form.
  panel.innerHTML = `
    <p class="hint"><strong>${n} row${n === 1 ? '' : 's'}</strong> found in your ${format.toUpperCase()} file. Match each map field to a column from the file. This applies to <strong>all ${n}</strong> at once, not one point.</p>
    ${needsLngLat
      ? `<div class="maplabel">Location <span class="hint">(a CSV keeps coordinates in columns)</span></div>
         <div class="maprow"><span>Longitude</span><select data-map="lng">${opts(guess.lng)}</select></div>
         <div class="maprow"><span>Latitude</span><select data-map="lat">${opts(guess.lat)}</select></div>`
      : `<p class="hint">Locations come from the file's own geometry, so there's nothing to match for coordinates.</p>`}
    <div class="maplabel">Fields <span class="hint">(which column fills each)</span></div>
    ${fields.map((f) => `<div class="maprow"><span>${escapeHtml(f.label)}${f.required ? ' *' : ''}</span><select data-field="${f.key}">${opts(guess.fields[f.key])}</select></div>`).join('')}
    <div id="map-preview" class="hint" style="margin:10px 0"></div>
    <div class="maplabel">Where's this data from? <span class="hint">(the source, shown in the published credit)</span></div>
    <input id="imp-source" placeholder="e.g. SOI Forest Atlas 2021, or a link" maxlength="200" />
    <label class="chip" style="gap:8px;margin-top:10px;align-items:flex-start;border-radius:12px;padding:10px 12px"><input type="checkbox" id="imp-rights" style="width:auto;min-height:auto;margin-top:3px"><span style="white-space:normal;font-weight:400;font-size:13px">I have the right to publish this under the map's licence (${escapeHtml(meta.license)}): it's my own data, or from a source whose terms allow it.</span></label>
    <button class="primary" id="do-import" style="margin-top:12px">Import all ${n} rows</button>
    <div id="import-result"></div>`;

  const readMapping = (): Mapping => {
    const m: Mapping = { fields: {} };
    if (needsLngLat) {
      m.lng = (panel.querySelector('[data-map="lng"]') as HTMLSelectElement).value || undefined;
      m.lat = (panel.querySelector('[data-map="lat"]') as HTMLSelectElement).value || undefined;
    }
    panel.querySelectorAll<HTMLSelectElement>('[data-field]').forEach((s) => { if (s.value) m.fields[s.dataset.field!] = s.value; });
    return m;
  };
  // Live preview of the first row so the mapping is tangible (bulk, not entry).
  const preview = (): void => {
    const el = document.getElementById('map-preview');
    if (!el) return;
    const { records, errors } = buildRecords(parsed.features.slice(0, 1), readMapping(), fields, meta.schema.geometry);
    if (records.length) {
      const g = records[0].geometry as { type: string; coordinates: number[] };
      const props = records[0].properties as Record<string, unknown>;
      const label = String(props.name ?? Object.values(props)[0] ?? '(unnamed)');
      const where = g.type === 'Point' ? `${g.coordinates[0]}, ${g.coordinates[1]}` : g.type.toLowerCase();
      el.innerHTML = `Preview · row 1 → <strong>${escapeHtml(label)}</strong> at ${escapeHtml(where)}`;
    } else {
      el.innerHTML = `<span class="warn">Row 1 won't import: ${escapeHtml(errors[0]?.error || 'check the mapping')}</span>`;
    }
  };
  panel.querySelectorAll('select').forEach((s) => { (s as HTMLSelectElement).onchange = preview; });
  preview();

  (document.getElementById('do-import') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const source = (document.getElementById('imp-source') as HTMLInputElement).value.trim();
    const rights = (document.getElementById('imp-rights') as HTMLInputElement).checked;
    if (!rights) { toast('Tick the box: you can publish this under the map licence'); return; }
    if (!source) { toast('Name where this data comes from'); return; }
    const { records, errors } = buildRecords(parsed.features, readMapping(), fields, meta.schema.geometry);
    const result = document.getElementById('import-result')!;
    if (!records.length) {
      result.innerHTML = `<p class="warn">Nothing valid to import. ${errors.length} row${errors.length === 1 ? '' : 's'} had problems.</p>${errorsBlock()}`;
      wireErrorDownload(errors);
      return;
    }
    btn.disabled = true;
    try {
      const res = await apiJson<{ imported: number; errors: unknown[] }>(`/collections/${ctx.id}/import`, ctx.token, { method: 'POST', body: JSON.stringify({ records, source, rights_confirmed: true }) });
      await refreshCounts(); // refetch the cache so Review shows the imported points
      toast(`Imported ${res.imported} point${res.imported === 1 ? '' : 's'} ✓`);
      result.innerHTML = `<p class="hint">Imported ${res.imported}.${errors.length ? ` ${errors.length} row${errors.length === 1 ? '' : 's'} couldn't be read.` : ''}</p>`
        + (errors.length ? errorsBlock() : '');
      wireErrorDownload(errors);
    } catch (e) { toast((e as Error).message); btn.disabled = false; }
  };
}

// The rejected rows, as a spreadsheet to fix + re-import (with a plain-words prompt).
function errorsBlock(): string {
  return `<button id="dl-errors">Download the rows to fix</button>
    <p class="hint" style="margin-top:6px">A spreadsheet of only the skipped rows, each with a <code>why</code> column. Fix them, delete that column, and import the file again.</p>`;
}
function wireErrorDownload(errors: { row: number; error: string; source: Record<string, string> }[]): void {
  const b = document.getElementById('dl-errors') as HTMLButtonElement | null;
  if (b) b.onclick = () => downloadText(errorsToCSV(errors), 'rows-to-fix.csv', 'text/csv');
}

function activeFilter(): string {
  return (document.querySelector('#pfilter .chip.on') as HTMLElement | null)?.dataset.s || '';
}

// Fetch every record once (all statuses) into allFeats; the chips filter it in
// memory. Recomputes meta.counts locally so counts stay correct without a
// separate meta round-trip. Pass force to refresh the cache after a mutation.
async function ensureReviewData(force = false): Promise<void> {
  if (reviewLoaded && !force) return;
  const gen = reviewGen;
  try {
    const fc = await apiJson<{ features: Feature[] }>(`/collections/${ctx.id}/records?limit=2000`, ctx.token);
    if (gen !== reviewGen) return; // invalidated mid-flight (e.g. a point was added) — discard this snapshot
    allFeats = fc.features || [];
    reviewLoaded = true;
    lastReviewFetch = Date.now();
    meta.counts = countsOf(allFeats);
  } catch { /* keep the previous cache */ }
}

// Update the counts line + filter-chip totals in place (no fetch).
function updateReviewCounts(c: Counts): void {
  const line = document.getElementById('mcounts');
  if (line) line.textContent = `${c.published} approved · ${c.pending} pending · ${c.rejected} rejected`;
  const label: Record<string, string> = { '': `All ${c.total}`, pending: `Pending ${c.pending}`, published: `Approved ${c.published}`, rejected: `Rejected ${c.rejected}` };
  document.querySelectorAll<HTMLElement>('#pfilter .chip').forEach((b) => {
    const t = label[b.dataset.s || ''];
    if (t) b.textContent = t;
  });
}

// After a mutation (moderate / delete / import): refresh the cache. The counts-line
// update is defensive — callers usually rebuild the whole panel right after.
async function refreshCounts(): Promise<void> {
  await ensureReviewData(true);
  updateReviewCounts(meta.counts);
}

type AdminCtx = { state?: string; district?: string; subdistrict?: string } | null;
function fmtAdminCtx(ctx: AdminCtx): string {
  if (!ctx) return '';
  const parts = [ctx.district, ctx.state].filter(Boolean);
  return parts.length ? `📍 ${parts.join(', ')}` : '';
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
// Compact, tappable list — scales to hundreds of points. Titles wrap (never
// truncate). Per-point actions live in the review detail, not the row.
// Render the current filter's rows from the in-memory cache (no network). The
// records are loaded once by ensureReviewData; chip taps just re-run this.
function renderPoints(): void {
  const q = document.getElementById('points');
  if (!q) return;
  const status = activeFilter();
  reviewFeats = filterByStatus(allFeats, status);
  clearSelection();     // the previous selection points at stale indices
  syncReviewLayer();    // redraw the clickable markers for this filter
  fitToFeatures(reviewFeats);
  if (!reviewFeats.length) {
    q.innerHTML = (status && allFeats.length)
      ? `<p class="empty">No ${status === 'published' ? 'approved' : status} points.</p>`
      : '<p class="empty">No points here yet. Share the collect link and they will show up as people add them.</p>';
    return;
  }
  q.innerHTML = reviewFeats.map((f, i) => {
    const st = statusOf(f);
    const geom = f.geometry?.type && f.geometry.type !== 'Point' ? `${nounFor(f.geometry.type)} · ` : '';
    return `<button type="button" class="point-row" data-idx="${i}">
      <span class="point-row__title">${escapeHtml(geom)}${escapeHtml(cardTitle(f.properties))}</span>
      <span class="badge badge--${st}">${st}</span>
      <span class="point-row__chev" aria-hidden="true">›</span>
    </button>`;
  }).join('');
  q.querySelectorAll<HTMLButtonElement>('.point-row').forEach((b) => {
    b.onclick = () => openReview(Number(b.dataset.idx));
  });
}

const fmtVal = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : v == null || v === '' ? '—' : String(v));

// One attribute row per (non-deleted) field — shared by the review sheet
// (prefix "attr") and the map tooltip (prefix "pop-attr"). Empty-state per caller.
function attrRowsHtml(p: Record<string, unknown>, prefix: string): string {
  return meta.schema.fields
    .filter((x) => !x.deleted)
    .map((fl) => `<div class="${prefix}"><span class="${prefix}__k">${escapeHtml(fl.label)}</span><span class="${prefix}__v">${escapeHtml(fmtVal(p[fl.key]))}</span></div>`)
    .join('');
}

// Lift a point into the band above the review sheet (which floats over the map).
function sheetLiftOffset(): [number, number] { return [0, -Math.round(window.innerHeight * 0.2)]; }

function clearRowSelection(): void {
  document.querySelectorAll('.point-row--sel').forEach((el) => el.classList.remove('point-row--sel'));
}

function clearHighlight(): void {
  if (reviewMarker) { reviewMarker.remove(); reviewMarker = undefined; }
  recordPopup?.remove(); recordPopup = undefined;
  selectReviewFeature(null);
}

// Tap a point → see it on the map (fly + highlight) + every attribute, and
// verify: approve / reject / edit / delete right there.
function openReview(idx: number): void {
  const f = reviewFeats[idx];
  if (!f) return;
  const p = f.properties as { _status?: string; _contributor?: string; _admin_ctx?: AdminCtx; _source?: string; [k: string]: unknown };
  const st = p._status || 'published';

  const c = representativeCoord(f.geometry);
  clearHighlight();
  selectReviewFeature(idx); // emphasise the same feature on the map
  if (c) {
    reviewMarker = new maplibregl.Marker({ color: '#d97706' }).setLngLat(c).addTo(map);
    map.flyTo({ center: c, zoom: Math.max(map.getZoom(), 14), offset: sheetLiftOffset(), duration: 500 });
  }

  const attrs = attrRowsHtml(p, 'attr');
  // meta line: who (source or a named contributor; nothing for an unnamed capture) + place
  const who = recordWho(p._source, p._contributor);
  const meta = [who ? escapeHtml(who) : '', fmtAdminCtx(p._admin_ctx ?? null)].filter(Boolean).join(' · ');
  const panel = document.getElementById('panel')!;
  panel.innerHTML = `<div class="sheet">
    ${GRAB}
    <div class="body">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px">
        <strong style="flex:1">${escapeHtml(cardTitle(p))}</strong>
        <span class="badge badge--${st}">${st}</span>
      </div>
      ${meta ? `<p class="hint">${meta}</p>` : ''}
      <div class="attrs">${attrs || '<p class="hint">No fields on this map.</p>'}</div>
    </div>
    <div class="foot">
      ${st === 'pending'
        ? `<div class="row" style="margin-bottom:8px"><button class="danger" id="rv-reject" style="flex:1">✗ Reject</button><button class="primary" id="rv-approve" style="flex:1">✓ Approve</button></div>`
        : st === 'rejected'
          ? `<button class="primary" id="rv-approve" style="width:100%;margin-bottom:8px">✓ Approve</button>`
          : ''}
      <div class="row">
        <button id="rv-back" style="flex:1">← List</button>
        <button id="rv-edit" style="flex:1">✎ Edit</button>
        <button class="danger" id="rv-delete" style="flex:1">🗑 Delete</button>
      </div>
    </div>
  </div>`;

  const back = () => { clearHighlight(); void manageSheet(); };
  (document.getElementById('rv-back') as HTMLButtonElement).onclick = back;
  (document.getElementById('rv-edit') as HTMLButtonElement).onclick = () => { location.href = `/c/${ctx.id}/r/${f.id}#${ctx.token}`; };
  const moderate = async (s: string) => {
    try { await apiJson(`/records/${f.id}/moderate`, ctx.token, { method: 'POST', body: JSON.stringify({ status: s }) }); await refreshCounts(); back(); }
    catch (e) { toast((e as Error).message); }
  };
  document.getElementById('rv-approve')?.addEventListener('click', () => void moderate('published'));
  document.getElementById('rv-reject')?.addEventListener('click', () => void moderate('rejected'));
  let armed = false;
  (document.getElementById('rv-delete') as HTMLButtonElement).onclick = async (ev) => {
    const b = ev.currentTarget as HTMLButtonElement;
    if (!armed) { armed = true; b.textContent = 'Tap to confirm'; return; }
    try { await apiJson(`/records/${f.id}`, ctx.token, { method: 'DELETE' }); await refreshCounts(); back(); }
    catch (e) { toast((e as Error).message); }
  };
}

// Publishing to the public catalog is a bigger step than "save" — the points are
// already on this map. Explain that first; it curbs accidental catalog submissions
// from people who think publishing is how they view or keep their data.
function confirmPublish(): void {
  const c = meta.counts;
  const panel = document.getElementById('panel')!;
  panel.innerHTML = `<div class="sheet">${GRAB}<div class="body">
    <strong>Submit to the public catalog?</strong>
    <p class="hint">Your ${c.published} approved point${c.published === 1 ? '' : 's'} are already saved and shown on this map. Submitting sends them to the open <strong>bharatlas catalog</strong>. <strong>A bharatlas maintainer reviews and approves every submission before it goes live</strong> at bharatlas.com — it won't be public until then. Do this once the map is ready to share widely.</p>
    ${c.pending ? `<p class="hint">${c.pending} pending point${c.pending === 1 ? '' : 's'} won't be included until you approve them in Review.</p>` : ''}
  </div><div class="foot row">
    <button id="pub-cancel">← Back</button>
    <button class="primary" id="pub-go" style="flex:1">${c.published ? `Submit ${c.published} for review` : 'Submit'}</button>
  </div></div>`;
  (document.getElementById('pub-cancel') as HTMLButtonElement).onclick = () => void manageSheet();
  (document.getElementById('pub-go') as HTMLButtonElement).onclick = (e) => void runPublish(e.currentTarget as HTMLButtonElement);
}

async function runPublish(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const res = await apiJson<{ version: number; feature_count: number; message?: string }>(
      `/collections/${ctx.id}/publish`, ctx.token, { method: 'POST' },
    );
    toast(`Submitted v${res.version} · ${res.feature_count} features`);
    const panel = document.getElementById('panel')!;
    panel.innerHTML = `<div class="sheet">${GRAB}<div class="body">
      <strong>Submitted for review ✓</strong>
      <p class="hint">Version ${res.version} · ${res.feature_count} features. ${escapeHtml(res.message || 'A curator reviews it before it goes live in the bharatlas catalog.')}</p>
      </div><div class="foot"><button id="back">← Back to manage</button></div></div>`;
    (document.getElementById('back') as HTMLButtonElement).onclick = () => void manageSheet();
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
      ${GRAB}
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
  installSheetMetrics();

  map = new maplibregl.Map({ container: 'map', style: buildBaseStyle(getStoredBasemap() ?? normalizeBasemap(rec.schema.basemap)), center, zoom: isPoint ? 16 : 14, attributionControl: false });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  // Only rewrite the point's location if the user actually repositioned it — a
  // plain "fix a typo and Save" must leave the point exactly where it was.
  let moved = false;
  map.on('dragstart', () => { moved = true; });
  map.on('load', () => {
    document.getElementById('maploading')?.remove();
    if (isPoint) {
      marker(center);
      // Sit the point UNDER the crosshair (which rides above map centre), so the
      // marker and the target line up and repositioning reads true.
      map.easeTo({ center, offset: crosshairScreenOffset(), duration: 0 });
      return;
    }
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
      (pos) => { moved = true; map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 16, offset: crosshairScreenOffset() }); },
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
      // Points can be repositioned by panning; shapes edit properties only. Only
      // write geometry when the user actually moved the map (else leave it put).
      const body: Record<string, unknown> = { properties: valid.properties };
      if (isPoint && moved) body.geometry = { type: 'Point', coordinates: crosshairLngLat() };
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
