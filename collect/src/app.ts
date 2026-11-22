// The /c/<id>[/admin|/view] app: a full-bleed map with a fixed crosshair for
// pin-drop, an "Use my location" button (geolocation called synchronously in the
// tap handler), a bottom-sheet form generated from the collection's schema, and
// — for admin — a review queue + publish. Mobile-first.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildBaseStyle, setBasemap, getStoredBasemap, setStoredBasemap, normalizeBasemap, BASEMAPS, INDIA_CENTER, type BasemapId } from './basemap';
import { type RefLayer } from './geo/catalog';
import { mountLayerPicker } from './geo/layer-picker';
import { CATEGORIES, OPEN_LICENCES } from './options';
import { parseCtx, api, apiJson, jsonWithOfflineCopy, loadErrorText, ApiError, type Ctx } from './api';
import { mapUrl, recordUrl } from './map-path';
import type { BuilderField } from './schema-builder';
import type { ImportReply } from './import/report';
import { basemapOfflineNote, isConnectionError } from './offline-notes';
import { savePoint, queuedFor, discardQueued, sendQueued, sendWhenOnline, OUTBOX_CHANGED, type Saved, type OutboxChange } from './send-queue';
import { validateRecordProperties, type Field } from './schema/validate-record';
import { orderedModes, drawGeometry, type GeomMode, type Coord } from './geo/draw';
import { representativeCoord } from './geo/admin-ctx';
import { geometryLngLats } from './geo/coords';
import { statusOf, filterByStatus, countsOf, popupActions, recordWho, recordVia, recordWhen, recordPlace, withStatus, withoutRecord, withAiReview, rowsToShow, reviewSignature } from './review';
import { focusSheet, SHEET_TITLE } from './sheet-focus';
import { escapeHtml, downloadText, plural } from './util';
import { toast } from './toast';
import { confirmTwice, busy } from './buttons';
import { wireLocate } from './geo/locate-button';
import { linkProblemHtml, isLinkProblem } from './link-problem';
import { fieldsHtml, setPressed, wireChips, fillAnswers, readAnswers } from './form-fields';
import type { ExportFeature } from './export/formats';
import type { Parsed } from './import/parse';
import type { Mapping } from './import/build';
import { rememberMap, rememberRecord, forgetRecord, recordLabel, myMaps, backLink, replaceAdminLink } from './maps-store';
import { loadContributorName, saveContributorName } from './contributor-name';
import { wireSheetSwipe } from './sheet-swipe';
import { pickNearest } from './pick-nearest';
import { linksMailtoHref, shareTabLinks, heldToken, type MapLinks, type LinkInfo } from './share';
import { shareItemHtml, wireShareItems } from './share-ui';
import { startAutoSync } from './syncing';
import { modeOf, photoFields } from './schema/modes';
import { readDataYear } from './schema/data-year';
import { modeChoices } from './create/plan';
import { isInIndia, geomBucket } from './geo/bounds';
import { metresBetween, ringArea, lineLength, formatArea, formatLength, simplify } from './geo/measure';
import { createTrace, averageFix, type Trace, type Fix } from './capture/trace';
import { saveWalk, loadWalk, clearWalk } from './capture/walk-store';
import { keepScreenOn, watchFixes } from './capture/gps';
import { preparePhoto } from './photos/prepare';
import { mountPhotoField, authedSrc, releasePhotos, openViewer, type PhotoField, type PhotoFieldOptions, type PhotoItem } from './photos/widget';
import { newClientId, stuckReason } from './outbox';
import { uploadPhoto } from './send-queue';
import { aiNotesHtml, type Notes } from './review-ai';
import { PALETTE } from '../../shared/brand.mjs';
import { fetchAllPages } from './paging';
import './register-sw';
interface Counts { pending: number; published: number; total: number; rejected: number; }
interface Meta {
  id: string; name: string; purpose: string; description: string | null; data_year: number | null; status: string; moderation: number; license: string;
  schema: { geometry: string[]; fields: Field[]; category?: string; basemap?: string; reference_layer?: { id: string; pmtiles_url: string } | null; mode?: string; data_saver?: boolean }; counts: Counts;
}
interface Feature { id: string; geometry: { type: string; coordinates: number[] }; properties: Record<string, unknown>; }

const app = document.getElementById('app')!;
let map: maplibregl.Map;
let meta: Meta;
let ctx: Ctx;

// Draw state (Phase 4). Points use the map centre; lines/polygons collect
// vertices by panning the crosshair and tapping "+ vertex".
const ACCENT = PALETTE.navyLink; // brand navy: reads on the light basemap, distinct from pending amber
const TAP_PX = 14; // a tap counts for a point this close (fingertip, not cursor)

// The map screen is an app surface: a pinch zooms the map, never the page. iPad
// Safari sends its own pinch (gesture*) events and zooms the page even over the
// map; MapLibre uses touch events, so cancelling these leaves map pinch working.
// (Page pinch is also off via touch-action in styles.css; the home and form
// pages stay zoomable.)
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(t, (e) => { if (document.querySelector('#app > .map')) e.preventDefault(); }, { passive: false });
}
let drawMode: GeomMode = 'point';
let verts: Coord[] = [];
let drawReady = false;
let allowsShapes = false; // collection declares line/polygon → draw layers are worth adding

const emptyFC = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

/** A GeoJSON source's area fill (<id>-fill) and its line and area edges (<id>-line). */
function addShapeLayers(id: string, fill: maplibregl.FillLayerSpecification['paint'], line: maplibregl.LineLayerSpecification['paint']): void {
  map.addLayer({ id: `${id}-fill`, type: 'fill', source: id, filter: ['==', '$type', 'Polygon'], paint: fill });
  map.addLayer({ id: `${id}-line`, type: 'line', source: id, filter: ['!=', '$type', 'Point'], paint: line });
}

// Add the in-progress draw source + layers once the style is up (only needed
// for line/polygon collections — points-only stays light).
function setupDrawLayers(): void {
  if (drawReady || !allowsShapes || !map.isStyleLoaded()) return;
  map.addSource('draw', { type: 'geojson', data: emptyFC() });
  addShapeLayers('draw', { 'fill-color': ACCENT, 'fill-opacity': 0.15 }, { 'line-color': ACCENT, 'line-width': 2.5 });
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

function marker(coords: number[], color = ACCENT): maplibregl.Marker | undefined {
  if (coords.length >= 2) return new maplibregl.Marker({ color }).setLngLat([coords[0], coords[1]]).addTo(map);
}

const PENDING = '#9ca3af'; // grey: kept on this phone, not sent yet
const pendingPins = new Map<string, maplibregl.Marker>(); // client_id → its grey pin

// A point (or shape) on the map; a queued point gets a grey pin until it's sent.
function pin(geometry: GeoJSON.Geometry, queuedAs?: string): void {
  if (geometry.type !== 'Point' || !queuedAs) return addRecordShape(geometry);
  const m = marker(geometry.coordinates, PENDING);
  if (m) pendingPins.set(queuedAs, m);
}

async function showQueued(): Promise<void> {
  for (const p of await queuedFor(ctx.id)) pin(p.geometry, p.client_id);
}

// Sent: its grey pin turns into a normal one. Discarded: the pin goes.
function settlePins({ sent, discarded }: OutboxChange): void {
  for (const { client_id, link } of sent) {
    if (lastQueued === client_id) lastAdded = `✓ Sent. <a href="${escapeHtml(link)}">edit it</a>`;
    const grey = pendingPins.get(client_id);
    if (!grey) continue;
    pendingPins.delete(client_id);
    const { lng, lat } = grey.getLngLat();
    grey.remove();
    addRecordShape({ type: 'Point', coordinates: [lng, lat] });
  }
  for (const id of discarded) {
    pendingPins.get(id)?.remove();
    pendingPins.delete(id);
  }
  const last = document.getElementById('lastadded');
  if (last) last.innerHTML = lastAdded;
}

// "3 waiting to send" under the capture bar, and any point the server refused
// for good, with its reason and a way to discard it.
async function renderOutbox(): Promise<void> {
  const box = document.getElementById('outbox');
  if (!box) return;
  const queued = await queuedFor(ctx.id);
  const waiting = queued.filter((p) => !p.error).length;
  const refused = queued.filter((p) => p.error);
  const why = stuckReason(queued) ?? "They go when you're back online.";
  box.innerHTML = `${waiting ? `<p class="hint">⏳ ${waiting} waiting to send. ${escapeHtml(why)} <button type="button" class="ghost" id="sendnow">Send now</button></p>` : ''}
    ${refused.map((p) => `<p class="warn">Couldn't send "${escapeHtml(p.label)}": ${escapeHtml(p.error!)}. <button type="button" class="ghost" data-discard="${p.client_id}">Discard</button></p>`).join('')}`;
  const now = box.querySelector<HTMLButtonElement>('#sendnow');
  if (now) now.onclick = () => { now.disabled = true; void sendQueued(); };
  box.querySelectorAll<HTMLButtonElement>('[data-discard]').forEach((b) => { b.onclick = () => void discardQueued(b.dataset.discard!); });
}
window.addEventListener(OUTBOX_CHANGED, (e) => {
  const change = (e as CustomEvent<OutboxChange>).detail;
  if (change.sent.length) invalidateReview(); // queued points reached the server
  settlePins(change);
  void renderOutbox();
});

// A grab handle — the first child of every collapsible bottom sheet.
const GRAB = '<button type="button" class="grab" aria-expanded="true" aria-label="Collapse or expand this panel"></button>';

/** A bottom sheet: the grab handle, its body (a form when `form` names one) and
 *  a footer, either the usual "← Back | primary" row or `foot`'s own markup. */
function sheetHtml(body: string, o: { form?: string; back?: string | [id: string, label: string]; primary?: [id: string, label: string]; foot?: string } = {}): string {
  const [backId, backLabel] = typeof o.back === 'string' ? [o.back, '← Back'] : o.back ?? [];
  const foot = o.foot !== undefined ? `<div class="foot">${o.foot}</div>`
    : backId && o.primary ? `<div class="foot row"><button type="button" id="${backId}">${backLabel}</button><button class="primary" id="${o.primary[0]}" style="flex:1">${o.primary[1]}</button></div>`
      : '';
  return `<div class="sheet">${GRAB}${o.form ? `<form class="body" id="${o.form}">${body}</form>` : `<div class="body">${body}</div>`}${foot}</div>`;
}

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
  // Only the panel's content changes the sheet's height (not the map's own DOM).
  new MutationObserver(() => requestAnimationFrame(updateSheetMetrics)).observe(document.getElementById('panel') ?? appEl, { childList: true, subtree: true });
  const toggleSheet = (grab: Element): void => {
    const sheet = grab.closest('.sheet');
    const collapsed = sheet?.classList.toggle('collapsed') ?? false;
    grab.setAttribute('aria-expanded', String(!collapsed));
    // keep the grab operable, but pull the now-offscreen content out of the tab order
    sheet?.querySelectorAll('.body, .foot').forEach((el) => {
      if (collapsed) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    });
    updateSheetMetrics();
  };
  // Tap the handle, or swipe it down / up (sheet-swipe.ts), to collapse / expand.
  wireSheetSwipe(appEl, toggleSheet);
  appEl.addEventListener('click', (e) => {
    const grab = (e.target as HTMLElement).closest('.grab');
    if (grab) toggleSheet(grab);
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

// The on-map "Base map" switcher: a button + a small list of the four basemaps
// (plain buttons, the chosen one pressed; not an ARIA menu, which needs arrow keys).
// Switching flips layer visibility (setBasemap), so overlays + markers survive.
function installBasemapSwitcher(initial: BasemapId): void {
  const btn = document.getElementById('basemapbtn');
  const menu = document.getElementById('basemapmenu');
  if (!btn || !menu) return;
  let active = initial;
  const close = (): void => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const render = (): void => {
    menu.innerHTML = BASEMAPS.map((b) => `<button type="button" aria-pressed="${b.id === active}" class="basemap-opt${b.id === active ? ' on' : ''}" data-b="${b.id}"><strong>${escapeHtml(b.name)}</strong><span class="hint">${escapeHtml(b.hint)}</span></button>`).join('');
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
  const body = encodeURIComponent(`Reporting this map:\n${mapUrl(location.origin, ctx.id)}\n\nReason:\n`);
  return `<p class="hint" style="margin-top:12px">Public places and assets only, not people. <a href="mailto:sathya@urbanmorph.com?subject=${subject}&body=${body}">Report this map</a> · <a href="${TERMS}" target="_blank" rel="noopener">Terms</a></p>`;
}

/** The map in #map: compact attribution bottom-left (so it never sits under the
 *  locate button, bottom-right), and the "Loading map…" note gone once it loads. */
function mountMap(style: maplibregl.StyleSpecification, center: [number, number], zoom: number): maplibregl.Map {
  const m = new maplibregl.Map({ container: 'map', style, center, zoom, attributionControl: false });
  m.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  m.on('load', () => document.getElementById('maploading')?.remove());
  return m;
}

/** Brings a located position under the crosshair. */
const easeToFix = (lngLat: [number, number]): void => { map.easeTo({ center: lngLat, zoom: 16, offset: crosshairScreenOffset() }); };

async function boot(): Promise<void> {
  ctx = parseCtx()!;
  // Saved on each online load, so a map opened once with signal opens without it.
  const loaded = await jsonWithOfflineCopy<Meta>(`collect:meta:${ctx.id}`, () => api(`/collections/${ctx.id}`, ctx.token), localStorage);
  meta = loaded.data;
  if (loaded.offline) toast("You're offline. New points are kept on this phone and sent when you're back online.");
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
      <button class="locate" id="basemapbtn" aria-label="Base map" title="Base map" aria-expanded="false" aria-controls="basemapmenu" style="left:12px;top:12px;right:auto;bottom:auto">◱</button>
      <div class="basemap-menu" id="basemapmenu" role="group" aria-label="Base map" hidden></div>
      ${meta.schema.reference_layer ? '<button class="locate" id="reftoggle" aria-label="Reference layer" title="Reference layer" aria-pressed="true" style="left:12px;top:66px;right:auto;bottom:auto">◪</button>' : ''}
      ${isAdmin ? `<button class="locate" id="manage" aria-label="Manage map${meta.counts.pending ? `, ${meta.counts.pending} pending review` : ''}" style="left:12px;right:auto;bottom:76px;width:auto;padding:0 14px">⚙${meta.counts.pending ? ` ${meta.counts.pending}` : ''}</button>` : ''}
    </div>
    <div id="panel"></div>`;
  installSheetMetrics();

  const initialBasemap = getStoredBasemap() ?? normalizeBasemap(meta.schema.basemap);
  map = mountMap(buildBaseStyle(initialBasemap), INDIA_CENTER, 4);
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  installBasemapSwitcher(initialBasemap);
  watchBasemapConnection();
  drawReady = false; verts = [];
  allowsShapes = orderedModes(meta.schema.geometry).some((m) => m !== 'point');
  map.on('load', () => {
    if (!isView && allowsShapes) setupDrawLayers();
    // Loaded only when the form has a reference layer (it pulls in pmtiles).
    if (meta.schema.reference_layer) {
      const url = meta.schema.reference_layer.pmtiles_url;
      void import('./geo/reference').then((r) => r.addReferenceOverlay(map, url)).catch(() => {});
    }
    if (isAdmin) syncReviewLayer();   // admin: the clickable, status-coloured review layer (driven by the list)
    else void loadRecords();          // view / collect: published points as context
    if (!isView) void showQueued();   // points kept on this phone, not sent yet
  });

  const reftoggle = document.getElementById('reftoggle') as HTMLButtonElement | null;
  if (reftoggle) reftoggle.onclick = () => {
    const on = reftoggle.getAttribute('aria-pressed') !== 'true';
    reftoggle.setAttribute('aria-pressed', String(on));
    reftoggle.style.opacity = on ? '1' : '0.55';
    void import('./geo/reference').then((r) => r.setReferenceVisible(map, on));
  };

  if (!isView) {
    wireLocate(document.getElementById('locate') as HTMLButtonElement, easeToFix);
    if (isAdmin) {
      // Admin lands on Manage (review + CRUD + publish); the ⚙ button returns here.
      (document.getElementById('manage') as HTMLButtonElement).onclick = () => void manageSheet();
      void manageSheet(false); // on load, focus stays at the top of the page
    } else {
      captureSheet();
    }
  }
  if (isView) viewPanel();
}

function viewPanel(): void {
  const panel = document.getElementById('panel')!;
  const n = meta.counts.published;
  panel.innerHTML = sheetHtml(`
    <strong>${escapeHtml(meta.name)}</strong>
    ${meta.purpose ? `<p class="hint">${escapeHtml(meta.purpose)}</p>` : ''}
    <p class="hint">${n ? `${plural(n, 'point')} on the map.` : 'No points published yet.'}</p>
    ${safetyFooter()}`);
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
  addShapeLayers('review',
    { 'fill-color': STATUS_COLOR, 'fill-opacity': ['case', ['boolean', ['feature-state', 'sel'], false], 0.3, 0.12] },
    { 'line-color': STATUS_COLOR, 'line-width': ['case', ['boolean', ['feature-state', 'sel'], false], 4, 2] });
  map.addLayer({
    id: 'review-pt', type: 'circle', source: 'review', filter: ['==', '$type', 'Point'],
    paint: {
      'circle-radius': ['case', ['boolean', ['feature-state', 'sel'], false], 9, 6],
      'circle-color': STATUS_COLOR,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['case', ['boolean', ['feature-state', 'sel'], false], 3, 2],
    },
  });
  // One tap handler with a finger-sized radius: the nearest point within TAP_PX,
  // else a line or area under the tap (points win, being the hardest to hit).
  map.on('click', (e) => {
    const { x, y } = e.point;
    const near = map.queryRenderedFeatures([[x - TAP_PX, y - TAP_PX], [x + TAP_PX, y + TAP_PX]], { layers: ['review-pt', 'review-fill', 'review-line'] });
    const pts = near.filter((f) => f.layer.id === 'review-pt').map((f) => {
      const s = map.project((f.geometry as GeoJSON.Point).coordinates as [number, number]);
      return { idx: f.properties.idx as number, x: s.x, y: s.y };
    });
    const idx = pickNearest(pts, e.point, TAP_PX) ?? (near.find((f) => f.layer.id !== 'review-pt')?.properties.idx as number | undefined);
    if (typeof idx === 'number') selectFromMap(idx);
  });
  for (const id of ['review-pt', 'review-fill', 'review-line']) {
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
    patchReview(withStatus(allFeats, id, status));
    refreshReviewSurfaces();
  } catch (e) { toast((e as Error).message, 'error'); }
}

// One record changed here (approved, rejected, deleted, notes reviewed): the
// cached list takes the change in place instead of fetching every record again.
// A fetch already in flight is discarded, as it predates the change.
function patchReview(next: Feature[]): void {
  allFeats = next;
  meta.counts = countsOf(allFeats);
  reviewGen++;
}

// Repaint whatever review surfaces are live after a mutation: always the map
// layer, plus the list + counts when the manage sheet is showing. Clears the
// tooltip/highlight so the just-moderated point doesn't keep a stale popup.
function refreshReviewSurfaces(): void {
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

// The records overlay: one accumulating source for existing + just-added
// points, lines and polygons. Points draw as a circle layer, not DOM markers:
// hundreds of markers are each moved on every frame of a pan (slow on phones).
// Only a queued point keeps a (grey) DOM marker until it's sent.
function syncRecordShapes(): void {
  if (!map.isStyleLoaded()) return;
  const data = { type: 'FeatureCollection', features: recordShapes } as GeoJSON.FeatureCollection;
  const src = map.getSource('records') as maplibregl.GeoJSONSource | undefined;
  if (src) { src.setData(data); return; }
  map.addSource('records', { type: 'geojson', data });
  addShapeLayers('records', { 'fill-color': ACCENT, 'fill-opacity': 0.1 }, { 'line-color': ACCENT, 'line-width': 2, 'line-opacity': 0.7 });
  map.addLayer({ id: 'records-point', type: 'circle', source: 'records', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 6, 'circle-color': ACCENT, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
}

function addRecordShape(geometry: GeoJSON.Geometry): void {
  recordShapes.push({ type: 'Feature', geometry, properties: {} });
  syncRecordShapes();
}

let didFit = false; // fit the camera to the data once, on first load (see fitToFeatures)

async function loadRecords(): Promise<void> {
  try {
    // Published-only on the capture map (admin's un-moderated pins live in the queue).
    // Kept on the phone (up to ~500 KB) so a map opened offline still shows what others added.
    // Every published record, not just the server's first page.
    const { data: fc } = await jsonWithOfflineCopy<{ features: Feature[] }>(
      `collect:records:${ctx.id}`,
      async () => new Response(JSON.stringify({ features: await allRecords<Feature>('published', true) })),
      localStorage, 500_000);
    recordShapes = [];
    for (const f of fc.features || []) {
      if (f.geometry) recordShapes.push({ type: 'Feature', geometry: f.geometry as GeoJSON.Geometry, properties: {} });
    }
    if (recordShapes.length) syncRecordShapes();
    fitToFeatures(fc.features || []);
  } catch { /* map still usable */ }
}

// When the background tiles can't load for lack of a connection, say so over the
// map (naming the basemap), and that points still save; hide it once back online.
function watchBasemapConnection(): void {
  const owner = new Map(BASEMAPS.flatMap((b) => Object.keys(b.sources).map((id) => [id, b] as const)));
  map.on('error', (e: { sourceId?: string; error?: unknown }) => {
    const basemap = e.sourceId ? owner.get(e.sourceId) : undefined;
    if (!basemap || !isConnectionError(e.error, navigator.onLine)) return;
    let note = document.getElementById('mapnote');
    if (!note) {
      note = Object.assign(document.createElement('div'), { id: 'mapnote', className: 'map-note' });
      note.setAttribute('role', 'status');
      document.getElementById('map')?.appendChild(note);
    }
    note.textContent = basemapOfflineNote(basemap);
  });
  window.addEventListener('online', () => document.getElementById('mapnote')?.remove());
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

const NOUN: Record<GeomMode, string> = { point: 'point', line: 'line', polygon: 'area' };
const nounFor = (geometryType: string): string => NOUN[geomBucket(geometryType) ?? 'point'];
const CAP_HELP: Record<GeomMode, string> = {
  point: 'Move the map so the crosshair sits on the spot.',
  line: 'Pan the map so the crosshair sits on a point, then tap "Add point here". Repeat along the line.',
  polygon: 'Pan the map so the crosshair sits on a corner, then tap "Add point here", going around the area.',
};

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);
let lastAdded = '';
let lastQueued = ''; // client_id of the last point saved offline, to say when it's sent

// A route or an area is marked one of three ways: panning the crosshair to each
// corner ("On the map"), walking it with the GPS on, or standing at each corner
// while the GPS settles. Corners can then be dragged against the satellite view.
type DrawHow = 'map' | 'walk' | 'corners';
let drawHow: DrawHow = 'map';
let trace: Trace | null = null;           // a walk being recorded
let stopGps: (() => void) | null = null;  // ends the GPS watch + screen lock of a walk or corner
let cornerTimer: ReturnType<typeof setInterval> | undefined;
let cornerLeft = 0;
let lastFix: Fix | null = null;
let vertexMarkers: maplibregl.Marker[] = [];
const CORNER_SECONDS = 5;

const HOW_LABEL: Record<'line' | 'polygon', Record<DrawHow, string>> = {
  line: { map: 'On the map', walk: 'Walk along it', corners: 'Stand at each turn' },
  polygon: { map: 'On the map', walk: 'Walk around it', corners: 'Stand at each corner' },
};
const HOW_HELP: Record<'walk' | 'corners', Record<'line' | 'polygon', string>> = {
  walk: {
    line: 'Tap Start and walk the route. Keep this screen open while you walk; it works with no signal.',
    polygon: "Tap Start and walk the edge. The shape closes when you're back at the start. Keep this screen open while you walk; it works with no signal.",
  },
  corners: {
    line: 'At each turn, tap "Add this point" and hold still for a few seconds while the GPS settles.',
    polygon: 'At each corner, tap "Add this corner" and hold still for a few seconds while the GPS settles.',
  },
};

function stopRecording(): void {
  stopGps?.();
  stopGps = null;
  clearInterval(cornerTimer);
  cornerTimer = undefined;
}

function clearVertexMarkers(): void {
  vertexMarkers.forEach((m) => m.remove());
  vertexMarkers = [];
}

/** "6 points · 1 acre 10 guntas" or "5 points · 240 m". */
function shapeSummary(): string {
  const n = verts.length;
  const need = drawMode === 'line' ? 2 : 3;
  const size = drawMode === 'polygon' && n >= 3 ? formatArea(ringArea(verts)) : drawMode === 'line' && n >= 2 ? formatLength(lineLength(verts)) : '';
  const count = n < need ? `${plural(n, 'point')} · add ${need - n} more` : `${n} points`;
  const gps = drawHow !== 'map' && lastFix ? ` · GPS ±${Math.round(lastFix.accuracy)} m` : '';
  return [count, size].filter(Boolean).join(' · ') + gps;
}

// Capture is two steps so the MAP is the centre-piece while marking:
//   1. renderPlaceBar — a compact bar; position the crosshair and place the shape
//   2. detailsSheet   — the form slides up only once a shape is placed
// A "just photos" map has one step: each photo is a point (renderPhotoBar).
function captureSheet(): void {
  const modes = orderedModes(meta.schema.geometry);
  drawMode = modes[0];
  verts = [];
  stopRecording();
  trace = null;
  if (modeOf(meta.schema) === 'photos_ai') { redrawDraw(); return renderPhotoBar(); }
  // A walk the phone cut short (the tab was killed in the background) comes back.
  const kept = loadWalk(sessionStorage, ctx.id);
  if (kept && modes.includes(kept.mode)) {
    drawMode = kept.mode;
    drawHow = kept.how;
    verts = kept.verts;
    if (kept.walking) trace = createTrace(kept.verts); // paused: Resume picks it up
  }
  redrawDraw();
  renderPlaceBar(modes);
}

/** Keeps a shape being marked with the GPS for this map (see walk-store.ts). */
function keepWalk(): void {
  if (drawMode === 'point' || drawHow === 'map') clearWalk(sessionStorage, ctx.id);
  else saveWalk(sessionStorage, ctx.id, { mode: drawMode, how: drawHow, verts, walking: !!trace });
}

function renderPlaceBar(modes: GeomMode[], focus?: string): void {
  const panel = document.getElementById('panel')!;
  const seg = modes.length > 1
    ? `<div class="seg" id="modesw" role="group" aria-label="What to add">${modes.map((m) => `<button type="button" data-m="${m}" aria-pressed="${m === drawMode}"${m === drawMode ? ' class="on"' : ''}>${cap(NOUN[m])}</button>`).join('')}</div>`
    : '';
  panel.innerHTML = `<div class="bar">
    ${seg}
    <div class="seg seg--how" id="howsw" role="group" aria-label="How to mark it">${(['map', 'walk', 'corners'] as DrawHow[]).map((h) => `<button type="button" data-h="${h}"></button>`).join('')}</div>
    <p class="hint" id="cap-help"></p>
    <div class="row" id="drawctl" style="display:none;align-items:center">
      <button type="button" id="vadd" class="accent"></button>
      <button type="button" id="vundo">Undo</button>
      <span class="hint" id="vcount" aria-live="polite"></span>
    </div>
    <button class="primary" id="place">Add ${NOUN[drawMode]}</button>
    <div id="lastadded" class="hint">${lastAdded}</div>
    <div id="outbox"></div>
  </div>`;
  void renderOutbox();

  const vadd = document.getElementById('vadd') as HTMLButtonElement;
  const syncDrawUI = (): void => {
    const shape = drawMode !== 'point';
    const how = shape ? drawHow : 'map';
    document.getElementById('cap-help')!.textContent = how === 'map' ? CAP_HELP[drawMode] : HOW_HELP[how][drawMode as 'line' | 'polygon'];
    const howsw = document.getElementById('howsw')!;
    howsw.hidden = !shape;
    if (shape) howsw.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.textContent = HOW_LABEL[drawMode as 'line' | 'polygon'][b.dataset.h as DrawHow];
      setPressed(b, b.dataset.h === drawHow);
    });
    (document.getElementById('place') as HTMLButtonElement).textContent = trace ? `Finish, add ${NOUN[drawMode]} details` : `Add ${NOUN[drawMode]}`;
    document.getElementById('drawctl')!.style.display = shape ? 'flex' : 'none';
    vadd.disabled = !!cornerTimer;
    vadd.textContent = how === 'map' ? '+ Add point here'
      : how === 'walk' ? (trace ? (trace.paused() ? 'Resume' : 'Pause') : verts.length ? 'Walk it again' : 'Start walking')
      : cornerTimer ? `Hold still… ${cornerLeft}` : drawMode === 'polygon' ? '+ Add this corner' : '+ Add this point';
    const vcount = document.getElementById('vcount')!;
    // Quiet while a walk records (it changes on every GPS reading); it speaks once paused or stopped.
    vcount.setAttribute('aria-live', trace && !trace.paused() ? 'off' : 'polite');
    vcount.textContent = shapeSummary();
    document.querySelectorAll('#modesw button').forEach((b) => setPressed(b, (b as HTMLElement).dataset.m === drawMode));
    const ch = document.querySelector('.crosshair');
    ch?.classList.toggle('crosshair--draw', shape);
    ch?.classList.toggle('crosshair--off', shape && how !== 'map');
    syncVertexMarkers();
    keepWalk(); // every change to the shape (each GPS reading too) is kept for a reload
  };

  // Corners as handles to drag (not while recording; a long walk is simplified first).
  function syncVertexMarkers(): void {
    clearVertexMarkers();
    if (drawMode === 'point' || stopGps || verts.length > 60) return;
    verts.forEach((v, i) => {
      const el = document.createElement('div');
      el.className = 'vertex-handle';
      const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(v).addTo(map);
      m.on('drag', () => { const ll = m.getLngLat(); verts[i] = [ll.lng, ll.lat]; redrawDraw(); });
      m.on('dragend', syncDrawUI);
      vertexMarkers.push(m);
    });
  }

  const finishWalk = (): void => {
    stopRecording();
    if (!trace) return;
    const pts = simplify(trace.points(), 1.5);
    // Back at the start: the ring closes itself, so drop the near-duplicate last point.
    if (drawMode === 'polygon' && pts.length > 3 && metresBetween(pts[0], pts[pts.length - 1]) < 8) pts.pop();
    verts = pts;
    trace = null;
    redrawDraw();
    syncDrawUI();
  };

  const startWalk = (): void => {
    trace = createTrace();
    verts = [];
    lastFix = null;
    redrawDraw();
    watchWalk();
  };

  // The GPS feeding the walk (a new one, or one brought back after a reload).
  const watchWalk = (): void => {
    const sleep = keepScreenOn();
    const stopWatch = watchFixes((f) => {
      lastFix = f;
      if (!trace) return;
      if (trace.add(f) === 'added') {
        verts = trace.points();
        redrawDraw();
        map.easeTo({ center: [f.lng, f.lat], duration: 300 });
        if (drawMode === 'polygon' && trace.closed()) { finishWalk(); toast('Back at the start: the area is closed ✓'); return; }
      }
      syncDrawUI();
    }, (m) => toast(m, 'error'));
    stopGps = () => { stopWatch(); sleep(); };
  };

  const addCorner = (): void => {
    const fixes: Fix[] = [];
    const sleep = keepScreenOn();
    const stopWatch = watchFixes((f) => { fixes.push(f); lastFix = f; }, (m) => toast(m, 'error'));
    stopGps = () => { stopWatch(); sleep(); };
    cornerLeft = CORNER_SECONDS;
    cornerTimer = setInterval(() => {
      cornerLeft--;
      if (cornerLeft > 0) { syncDrawUI(); return; }
      stopRecording();
      const c = averageFix(fixes);
      if (!c) toast('No good GPS reading here. Step into the open and try again.', 'error');
      else {
        verts.push([c.lng, c.lat]);
        lastFix = c;
        redrawDraw();
        map.easeTo({ center: [c.lng, c.lat], duration: 300 });
      }
      syncDrawUI();
    }, 1000);
  };

  syncDrawUI();

  const reset = (): void => { stopRecording(); trace = null; verts = []; lastFix = null; redrawDraw(); syncDrawUI(); };
  document.querySelectorAll<HTMLButtonElement>('#modesw button').forEach((b) => {
    b.onclick = () => { drawMode = b.dataset.m as GeomMode; reset(); };
  });
  document.querySelectorAll<HTMLButtonElement>('#howsw button').forEach((b) => {
    b.onclick = () => { drawHow = b.dataset.h as DrawHow; reset(); };
  });
  // Location requests start inside these tap handlers (iPhone ignores them after an await).
  vadd.onclick = () => {
    if (drawHow === 'map' || drawMode === 'point') verts.push(crosshairLngLat());
    else if (drawHow === 'walk') {
      if (!trace) startWalk();
      else if (trace.paused()) { trace.resume(); if (!stopGps) watchWalk(); }
      else trace.pause();
    } else if (!cornerTimer) addCorner();
    redrawDraw();
    syncDrawUI();
  };
  (document.getElementById('vundo') as HTMLButtonElement).onclick = () => {
    if (trace) trace.undo();
    verts.pop();
    redrawDraw();
    syncDrawUI();
  };
  (document.getElementById('place') as HTMLButtonElement).onclick = () => {
    if (trace) finishWalk();
    const geometry = drawGeometry(drawMode, verts, crosshairLngLat());
    if (!geometry) { toast(`A ${NOUN[drawMode]} needs ${drawMode === 'line' ? '2' : '3'} points or more`, 'error'); return; }
    stopRecording();
    clearVertexMarkers();
    detailsSheet(geometry, modes);
  };
  if (focus) focusSheet(panel, focus);
}

// "Just photos": each photo becomes a point where it was taken (the photo's own
// location, else the phone's, else the crosshair), and a model fills the form
// for the owner to check. Nothing else to fill in, so nothing to slow anyone down.
function renderPhotoBar(): void {
  const field = photoFields(meta.schema.fields)[0];
  const panel = document.getElementById('panel')!;
  panel.innerHTML = `<div class="bar">
    <p class="hint">Take a photo of each one. It's added where it was taken, and the details are filled in from the photo, then checked. Keep faces and number plates out of the frame.</p>
    <label class="btn primary photo-snap">📷 Take a photo<input type="file" accept="image/*" capture="environment" data-src="camera" hidden></label>
    <div class="row">
      <label class="btn photo-add--quiet" style="flex:1">From gallery<input type="file" accept="image/*" data-src="gallery" hidden></label>
      <input id="contributor" autocomplete="name" maxlength="120" placeholder="Your name (optional)" aria-label="Your name (optional, published with the data)" style="flex:1" />
    </div>
    <div id="lastadded" class="hint" aria-live="polite">${lastAdded}</div>
    <div id="outbox"></div>
  </div>`;
  void renderOutbox();
  const who = document.getElementById('contributor') as HTMLInputElement;
  who.value = loadContributorName();
  let phone: { lng: number; lat: number; at: number } | null = null;
  panel.querySelectorAll<HTMLLabelElement>('.photo-snap, .photo-add--quiet').forEach((l) => {
    // Ask for the phone's location in the same tap that opens the camera.
    l.addEventListener('click', () => {
      navigator.geolocation?.getCurrentPosition(
        (p) => { phone = { lng: p.coords.longitude, lat: p.coords.latitude, at: Date.now() }; },
        () => {}, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
      );
    });
  });
  panel.querySelectorAll<HTMLInputElement>('input[type=file]').forEach((input) => {
    input.onchange = async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      const last = document.getElementById('lastadded')!;
      last.textContent = 'Getting the photo ready…';
      try {
        const { bytes, meta: pm } = await preparePhoto(file, { dataSaver: !!meta.schema.data_saver, source: input.dataset.src as 'camera' | 'gallery' });
        // The camera's place first; the phone's (if fresh) next; the crosshair last.
        const fromPhoto = pm.lat !== undefined && pm.lng !== undefined && isInIndia(pm.lng, pm.lat);
        const fromPhone = !fromPhoto && phone && Date.now() - phone.at < 120_000 && isInIndia(phone.lng, phone.lat);
        const where: Coord = fromPhoto ? [pm.lng!, pm.lat!] : fromPhone ? [phone!.lng, phone!.lat] : crosshairLngLat();
        const geometry: GeoJSON.Point = { type: 'Point', coordinates: where };
        const contributor = who.value.trim();
        saveContributorName(contributor);
        const placed = fromPhoto ? 'where the photo was taken' : fromPhone ? 'at your location' : 'at the crosshair (no location in the photo or from the phone)';
        // A refused save keeps the photo made ready here, with a way to try again.
        const attempt = async (): Promise<void> => {
          const saved = await savePoint({
            collection_id: ctx.id, map_name: meta.name, token: ctx.token, geometry, properties: {}, contributor,
            label: 'Photo', noun: 'point', captured_at: earlierThanNow(pm.taken_at),
            photos: [{ client_id: newClientId(), field: field.key, bytes, meta: fromPhoto ? { ...pm, placed: true } : pm }],
          }).catch((e: Error | null): Saved => ({ state: 'refused', error: e?.message || "couldn't keep it on this phone" }));
          if (saved.state === 'refused') {
            last.innerHTML = `<span class="warn">Couldn't save: ${escapeHtml(saved.error)}.</span> <button type="button" class="ghost" id="photo-retry">Try again</button>`;
            const retry = last.querySelector<HTMLButtonElement>('#photo-retry')!;
            retry.onclick = () => { retry.disabled = true; last.textContent = 'Trying again…'; void attempt(); };
            return;
          }
          pin(geometry, saved.state === 'waiting' ? saved.client_id : undefined);
          lastAdded = saved.state === 'sent' ? `✓ Added ${placed}. <a href="${escapeHtml(saved.link)}">edit it</a>` : `✓ Saved on this phone ${placed}, waiting to send.`;
          if (saved.state === 'waiting') lastQueued = saved.client_id;
          last.innerHTML = lastAdded;
          toast(saved.state === 'sent' ? 'Photo added ✓' : "Saved on this phone ✓ It'll be sent when you're back online.");
        };
        await attempt();
      } catch (e) {
        last.textContent = (e as Error).message;
      }
    };
  });
}

/** A photo's time, kept as when the point was captured if it is in the past. */
function earlierThanNow(iso?: string): string | undefined {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t < Date.now() - 60_000 ? new Date(t).toISOString() : undefined;
}

function detailsSheet(geometry: GeoJSON.Geometry, modes: GeomMode[]): void {
  const fields = meta.schema.fields.filter((f) => !f.deleted);
  const noun = NOUN[drawMode];
  const panel = document.getElementById('panel')!;
  const aiNote = modeOf(meta.schema) === 'form_ai' && fields.some((f) => f.type === 'photo')
    ? `<p class="hint">After it's sent, a model describes the photo and suggests answers for the map's owner to check. It won't change your answers.</p>` : '';
  panel.innerHTML = sheetHtml(`
      <strong ${SHEET_TITLE}>${cap(noun)} details</strong>
      <p class="hint">Placed on the map. Add the details, then save. Public places and assets only, not people.</p>
      ${fieldsHtml(fields)}
      <div id="photo-place" aria-live="polite"></div>
      ${aiNote}
      <label for="contributor">Your name <span class="hint">(optional, published with the data, remembered on this device)</span></label>
      <input id="contributor" autocomplete="name" maxlength="120" />`,
  { form: 'capform', back: 'cancel', primary: ['save', `Save ${noun}`] });
  (document.getElementById('contributor') as HTMLInputElement).value = loadContributorName();
  focusSheet(panel);
  wireChips(panel);

  // A point can move to where its photo was taken (and take the photo's time).
  let place = geometry;
  let capturedAt: string | undefined;
  let placedFrom: string | undefined; // the photo the point was moved to (its GPS may stay in the file)
  const placeBox = document.getElementById('photo-place')!;
  const offerPhotoPlace = (item: PhotoItem): void => {
    if (geometry.type !== 'Point' || item.meta.lat === undefined || item.meta.lng === undefined || !isInIndia(item.meta.lng, item.meta.lat)) return;
    const at: Coord = [item.meta.lng, item.meta.lat];
    const d = metresBetween(geometry.coordinates as Coord, at);
    if (d < 10) return;
    placeBox.innerHTML = `<div class="notice notice--inline"><div>This photo has a location, ${formatLength(d)} from the crosshair.</div><button type="button" id="use-photo-place">Use it for the point</button></div>`;
    document.getElementById('use-photo-place')!.onclick = () => {
      place = { type: 'Point', coordinates: at };
      capturedAt = earlierThanNow(item.meta.taken_at);
      placedFrom = item.client_id;
      placeBox.innerHTML = '<p class="ok">✓ The point is where the photo was taken.</p>';
      map.easeTo({ center: at, offset: crosshairScreenOffset(), duration: 300 });
    };
  };
  const photos = mountPhotoFields(panel, fields, !!meta.schema.data_saver, () => ({ onAdded: offerPhotoPlace }));

  // Back keeps a line/area's vertices so drawing work isn't lost.
  (document.getElementById('cancel') as HTMLButtonElement).onclick = () => { photos.forEach((p) => p.dispose()); renderPlaceBar(modes, '#place'); };

  (document.getElementById('save') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const form = document.getElementById('capform') as HTMLFormElement;
    if (!form.reportValidity()) return;
    if (photos.some((p) => p.busy())) { toast('One moment: a photo is still being made ready'); return; }
    const raw = readAnswers(panel, fields);
    const valid = validateRecordProperties(fields.filter((f) => f.type !== 'photo'), raw);
    if (!valid.ok) { toast(valid.error, 'error'); return; }
    const missing = photos.find((p) => p.field.required && !p.items().length);
    if (missing) { toast(`${missing.field.label}: add a photo`, 'error'); return; }
    btn.disabled = true;
    const contributor = (document.getElementById('contributor') as HTMLInputElement).value.trim();
    saveContributorName(contributor);
    // Kept on this phone first (photos too), then sent (straight away when there's
    // signal). A sent point's edit link joins "Your additions" (send-queue.ts): it's
    // the contributor's only way back to edit, delete or de-identify it (no accounts).
    const saved = await savePoint({
      collection_id: ctx.id, map_name: meta.name, token: ctx.token, geometry: place, properties: valid.properties,
      contributor, label: recordLabel(valid.properties, noun), noun, captured_at: capturedAt,
      photos: photos.flatMap((p) => p.items().map((it) => ({
        client_id: it.client_id, field: p.field.key, bytes: it.bytes!,
        meta: it.client_id === placedFrom ? { ...it.meta, placed: true } : it.meta,
      }))),
    }).catch((e: Error | null): Saved => ({ state: 'refused', error: e?.message || "couldn't keep it on this phone" }));
    if (saved.state === 'refused') {
      toast(`Couldn't save: ${saved.error}. Your details are kept, tap Save to retry.`, 'error');
      btn.disabled = false;
      return;
    }
    // In admin the status-coloured review layer owns the on-map display; a plain
    // pin here would double it once they return to Review. Contributors get the pin.
    if (ctx.mode !== 'admin' || saved.state === 'waiting') pin(place, saved.state === 'waiting' ? saved.client_id : undefined);
    if (saved.state === 'sent') {
      toast(meta.moderation ? 'Added, pending review ✓' : 'Added ✓');
      lastAdded = `✓ Added. <a href="${escapeHtml(saved.link)}">edit this ${noun}</a>`;
    } else {
      toast("Saved on this phone ✓ It'll be sent when you're back online.");
      lastAdded = `✓ Saved on this phone, waiting to send.`;
      lastQueued = saved.client_id;
    }
    verts = []; redrawDraw();
    photos.forEach((p) => p.dispose()); // the bytes are kept with the point; the thumbnails go
    renderPlaceBar(modes); // back to the map, ready for the next one
  };
}

// The Photo questions on a form, each mounted into its placeholder.
function mountPhotoFields(root: HTMLElement, fields: Field[], dataSaver: boolean, per: (f: Field) => Partial<PhotoFieldOptions> = () => ({})): PhotoField[] {
  return fields.filter((f) => f.type === 'photo').map((f) =>
    mountPhotoField(root.querySelector<HTMLElement>(`[data-k="${f.key}"]`)!, f, { dataSaver, onError: (m) => toast(m, 'error'), ...per(f) }));
}

// Admin "Edit map settings" — fix the name/description/purpose/category/data
// year + map background/reference layer. Licence editable only with no records.
async function editSettings(): Promise<void> {
  const panel = document.getElementById('panel')!;
  const s = meta.schema;
  const locked = meta.counts.total > 0;
  const sel = (v: string, cur: string): string => (v === cur ? ' selected' : '');
  panel.innerHTML = sheetHtml(`
      <strong ${SHEET_TITLE}>Edit map settings</strong>
      <label for="e-name">Name</label><input id="e-name" maxlength="120" value="${escapeHtml(meta.name)}" required />
      <label for="e-purpose">What's it for?</label><textarea id="e-purpose" maxlength="2000">${escapeHtml(meta.purpose)}</textarea>
      <label for="e-desc">Description <span class="hint">(optional)</span></label><input id="e-desc" maxlength="2000" value="${escapeHtml(meta.description || '')}" />
      <label for="e-category">Category</label><select id="e-category">${CATEGORIES.map(([id, l]) => `<option value="${id}"${sel(id, s.category || 'other')}>${l}</option>`).join('')}</select>
      <label for="e-mode">How people collect</label>
      <select id="e-mode">${modeChoices(s.geometry).map((m) => `<option value="${m.id}"${sel(m.id, modeOf(s))}${m.disabled ? ' disabled' : ''}>${m.title}${m.disabled ? ' (places only)' : ''}</option>`).join('')}</select>
      <p class="hint">AI notes need a Photo question in the form (✎ Form). Points already added keep what they have.</p>
      <label class="toggle"><input type="checkbox" id="e-saver"${s.data_saver ? ' checked' : ''}> <span><strong>Data saver</strong><span class="hint">Smaller photos (about 150 KB instead of 300 KB), for paid or weak mobile data.</span></span></label>
      <label for="e-year">Data year <span class="hint">(optional)</span></label><input id="e-year" inputmode="numeric" value="${meta.data_year ?? ''}" />
      <label for="e-ref-search">Reference layer</label>
      <div id="e-refnow">${s.reference_layer ? `<div class="link-box"><code>${escapeHtml(s.reference_layer.id)}</code><button type="button" id="e-ref-remove">Remove</button></div>` : '<p class="hint">None.</p>'}</div>
      <input id="e-ref-search" placeholder="Browse layers, or type to filter…" autocomplete="off" />
      <div id="e-ref-results" class="ref-results"></div>
      <label${locked ? '' : ' for="e-license"'}>Licence</label>
      ${locked ? `<p class="hint">${escapeHtml(meta.license)}, locked now the map has points.</p>` : `<select id="e-license">${OPEN_LICENCES.map(([id, l]) => `<option value="${id}"${sel(id, meta.license)}>${l}</option>`).join('')}</select>`}`,
  { form: 'editform', back: 'e-cancel', primary: ['e-save', 'Save settings'] });

  focusSheet(panel);

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

  (document.getElementById('e-cancel') as HTMLButtonElement).onclick = () => void manageSheet('#edit-settings');
  (document.getElementById('e-save') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    if (!(document.getElementById('editform') as HTMLFormElement).reportValidity()) return;
    const year = readDataYear((document.getElementById('e-year') as HTMLInputElement).value);
    if (!year.ok) { toast(year.error, 'error'); document.getElementById('e-year')!.focus(); return; }
    const patch: Record<string, unknown> = {
      name: (document.getElementById('e-name') as HTMLInputElement).value,
      purpose: (document.getElementById('e-purpose') as HTMLTextAreaElement).value,
      description: (document.getElementById('e-desc') as HTMLInputElement).value,
      category: (document.getElementById('e-category') as HTMLSelectElement).value,
      data_year: year.value,
      mode: (document.getElementById('e-mode') as HTMLSelectElement).value,
      data_saver: (document.getElementById('e-saver') as HTMLInputElement).checked,
    };
    if (!locked) patch.license = (document.getElementById('e-license') as HTMLSelectElement).value;
    if (refChange !== undefined) patch.reference_layer = refChange ? { id: refChange.id, pmtiles_url: refChange.pmtiles_url } : null;
    // Only a reference-overlay change needs a reload to re-style the map; the
    // basemap is a per-viewer runtime switch, not an author setting.
    const mapChanged = refChange !== undefined;
    await busy(btn, async () => {
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
    });
  };
}

// Admin "Edit form": change the form of a map that already has points. The
// builder checks every change against all the saved points (the server checks
// again on save): options the points use stay, new options and fields can be
// added, and a field is hidden rather than removed so no collected data is lost.
async function editFormSheet(): Promise<void> {
  const { mountSchemaBuilder } = await import('./schema-builder'); // admin-only code, loaded on demand
  const panel = document.getElementById('panel')!;
  panel.innerHTML = sheetHtml('<p class="hint">Loading the points to check the form against…</p>');
  let points: Record<string, unknown>[];
  try {
    points = (await allRecords<{ properties: Record<string, unknown> }>()).map((f) => f.properties);
  } catch (e) { toast(loadErrorText(e), 'error'); void manageSheet(); return; }
  const n = points.length;
  const byKey = new Map<string, unknown[]>(); // each field's values, read once
  const valuesOf = (k: string): unknown[] => {
    let v = byKey.get(k);
    if (!v) byKey.set(k, (v = points.map((p) => p[k])));
    return v;
  };
  panel.innerHTML = sheetHtml(`
      <strong ${SHEET_TITLE}>Edit form</strong>
      <p class="hint">${n ? `Checked against the map's ${plural(n, 'point')}. You can add options and fields; options the points use stay, and a field can be hidden (its data is kept) but not removed.` : 'The map has no points yet, so the form can change freely.'}</p>
      <div id="ef-builder"></div>
      <div id="ef-result" aria-live="polite"></div>`,
  { back: 'ef-cancel', primary: ['ef-save', 'Save form'] });
  const builder = mountSchemaBuilder(document.getElementById('ef-builder')!, meta.schema.fields as BuilderField[], {
    data: { noun: 'point', values: (f) => valuesOf(f.key) },
    existing: n > 0,
  });
  focusSheet(panel);
  (document.getElementById('ef-cancel') as HTMLButtonElement).onclick = () => void manageSheet('#edit-form');
  (document.getElementById('ef-save') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const out = document.getElementById('ef-result')!;
    btn.disabled = true;
    try {
      await apiJson(`/collections/${ctx.id}/fields`, ctx.token, { method: 'PATCH', body: JSON.stringify({ fields: builder.getFields() }) });
      meta = await apiJson<Meta>(`/collections/${ctx.id}`, ctx.token);
      toast('Form saved ✓');
      void manageSheet();
    } catch (e) {
      const body = e instanceof ApiError ? e.body : {};
      const problems = (body.problems as { reason: string; count: number }[] | undefined) ?? [];
      out.innerHTML = `<div class="notice"><div><strong>Not saved: ${escapeHtml((e as Error).message)}.</strong>
        ${problems.length ? `<ul class="reasons">${problems.map((p) => `<li>${escapeHtml(p.reason)} (${p.count})</li>`).join('')}</ul>` : ''}
        ${body.attempt_id ? `<p class="hint">Reference: <code>${escapeHtml(String(body.attempt_id))}</code></p>` : ''}</div></div>`;
      btn.disabled = false;
    }
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

/** focus: false on page load (focus stays put), else what to focus once drawn:
 *  the title, a control (Back from a sheet opened here), or a point's row. */
async function manageSheet(focus: false | string | { row: string } = ''): Promise<void> {
  clearHighlight(); // leaving a review detail clears the map highlight
  releasePhotos(); // ...and lets go of its private photos
  // Leaving capture mid-walk or mid-corner: stop the GPS and let the screen sleep.
  stopRecording();
  trace = null;
  clearVertexMarkers();
  // meta was loaded at boot; counts are kept fresh from the record cache, so no
  // per-open refetch (this ran on every tab-in and every back-out of a review).
  const c = meta.counts;
  const panel = document.getElementById('panel')!;
  panel.innerHTML = sheetHtml(`
      <div class="row" style="justify-content:space-between;align-items:center">
        <strong ${SHEET_TITLE}>Manage map</strong>
        <span class="row" style="gap:6px">
          <button id="edit-form" class="btn-sm">✎ Form</button>
          <button id="edit-settings" class="btn-sm">✎ Settings</button>
        </span>
      </div>
      <div class="tabs" id="mtabs" role="group" aria-label="Manage sections">
        <button type="button" data-t="review">Review${c.pending ? ` · ${c.pending}` : ''}</button>
        <button type="button" data-t="share">Share</button>
        <button type="button" data-t="data">Data</button>
      </div>
      <div id="tabbody"></div>`,
  { back: ['back', '+ Add points'], primary: ['publish', 'Submit to bharatlas'] });
  (document.getElementById('back') as HTMLButtonElement).onclick = captureSheet;
  (document.getElementById('publish') as HTMLButtonElement).onclick = confirmPublish;
  (document.getElementById('edit-settings') as HTMLButtonElement).onclick = () => void editSettings();
  (document.getElementById('edit-form') as HTMLButtonElement).onclick = () => void editFormSheet();
  document.querySelectorAll<HTMLButtonElement>('#mtabs button').forEach((b) => {
    b.onclick = () => { manageTab = b.dataset.t as ManageTab; renderManageTab(); };
  });
  const row = typeof focus === 'object' ? focus.row : undefined;
  renderManageTab(row);
  if (focus !== false) focusSheet(panel, row ? `.point-row[data-id="${CSS.escape(row)}"]` : typeof focus === 'string' && focus ? focus : undefined);
}

function renderManageTab(revealRow?: string): void {
  document.querySelectorAll<HTMLElement>('#mtabs button').forEach((b) => setPressed(b, b.dataset.t === manageTab));
  const body = document.getElementById('tabbody');
  if (!body) return;
  if (manageTab !== 'review') clearSelection(); // don't leave a tooltip/highlight behind
  if (manageTab === 'share') return renderShareTab(body);
  if (manageTab === 'data') return renderDataTab(body);
  return renderReviewTab(body, revealRow);
}

// Review: moderate the points. The records are fetched ONCE (ensureReviewData);
// the filter chips slice that cache in memory, so a chip tap is instant.
function renderReviewTab(body: HTMLElement, revealRow?: string): void {
  const c = reviewLoaded ? countsOf(allFeats) : meta.counts;
  body.innerHTML = `
    <p class="hint" id="mcounts">${c.published} approved · ${c.pending} pending · ${c.rejected} rejected</p>
    ${c.pending ? `<div class="notice">
      <div><strong>${plural(c.pending, 'point')} awaiting your approval.</strong> People you share the map with can't see ${c.pending === 1 ? 'it' : 'them'}, and ${c.pending === 1 ? "it isn't" : "they aren't"} exported or published to bharatlas until you approve.</div>
      <button type="button" class="primary" id="approve-all">✓ Approve all ${c.pending}</button>
    </div>` : ''}
    <div class="row" id="pfilter" role="group" aria-label="Show points" style="margin:8px 0 4px">
      <button type="button" class="chip on" aria-pressed="true" data-s="">All ${c.total}</button>
      <button type="button" class="chip" aria-pressed="false" data-s="pending">Pending ${c.pending}</button>
      <button type="button" class="chip" aria-pressed="false" data-s="published">Approved ${c.published}</button>
      ${c.rejected ? `<button type="button" class="chip" aria-pressed="false" data-s="rejected">Rejected ${c.rejected}</button>` : ''}
    </div>
    <div id="points"><p class="hint">Loading points…</p></div>`;
  const approveAll = document.getElementById('approve-all') as HTMLButtonElement | null;
  if (approveAll) approveAll.onclick = () => busy(approveAll, async () => {
    const res = await apiJson<{ changed: number; skipped?: number }>(`/collections/${ctx.id}/moderate-all`, ctx.token, { method: 'POST', body: JSON.stringify({ to: 'published' }) });
    invalidateReview();
    await ensureReviewData(true);
    toast(res.skipped ? `Approved ${res.changed} ✓ ${res.skipped} still need their answers checked` : `Approved ${res.changed} ✓`);
    renderManageTab(); // rebuild: notice clears, points show approved, counts refresh
  });
  document.querySelectorAll<HTMLButtonElement>('#pfilter .chip').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#pfilter .chip').forEach((x) => setPressed(x, x === b));
      reviewShown = 0; // a new filter starts at its first page
      renderPoints(); // in-memory filter — instant, no network
    };
  });
  if (reviewLoaded) {
    renderPoints(revealRow); // instant from the cache
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
const REVALIDATE_MS = 30_000;
function revalidateReview(): void {
  if (Date.now() - lastReviewFetch < REVALIDATE_MS) return; // fetched recently: changes made here are already in the cache
  const before = reviewSignature(allFeats);
  void ensureReviewData(true).then(() => {
    if (reviewSignature(allFeats) !== before) { updateReviewCounts(meta.counts); renderPoints(); }
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
  return `<div class="notice notice--inline"><div><strong>${plural(c.pending, 'point')} pending.</strong> Held back from people you share with, and from exports, until approved in Review.</div></div>`;
}

function renderShareTab(body: HTMLElement): void {
  const title = meta.name || 'bharatlas collect map';
  let adminLink = location.href;
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
    <a class="btn wide" id="email-links" style="margin-top:12px">✉ Email these links to me</a>
    <button type="button" class="linklike" id="replace-admin">Replace admin link</button>
    <div id="ra-new"></div>
    <strong style="display:block;margin-top:18px">Collect and view links</strong>
    <p class="hint">Give a team or a person their own link. You'll see which points came through it, and can turn it off without changing anyone else's link.</p>
    <div class="row">
      <input id="nl-label" maxlength="60" placeholder="e.g. Ward 12 team" aria-label="Name for the new link" style="flex:1" />
      <button type="button" id="nl-make">Create</button>
    </div>
    <div id="nl-new"></div>
    <div id="nl-list"><p class="hint">Loading links…</p></div>`;

  const emailA = document.getElementById('email-links') as HTMLAnchorElement;
  const refreshEmail = (): void => { emailA.href = linksMailtoHref({ admin: adminLink, ...minted } as MapLinks, meta.name); };
  refreshEmail();

  // The URL for a row — admin is this page. Collect/view reuse the link this
  // device saved for the map while it is still on (else mint one and save it),
  // then cache for the session.
  const linkFor = async (r: LinkRow): Promise<string | null> => {
    if (r.role === 'admin') return adminLink;
    const perm = r.perm!;
    if (minted[perm]) return minted[perm]!;
    try {
      const reuse = heldToken(myMaps().find((m) => m.id === ctx.id)?.links[perm], perm);
      const res = await apiJson<{ link: string }>(`/collections/${ctx.id}/tokens`, ctx.token, { method: 'POST', body: JSON.stringify({ permission: perm, reuse }) });
      minted[perm] = res.link;
      rememberMap(ctx.id, meta.name, perm === 'edit' ? 'collect' : 'view', res.link);
      refreshEmail();
      return res.link;
    } catch (e) { toast((e as Error).message, 'error'); return null; }
  };

  void wireNamedLinks(body, title);

  // Replace the admin link (it leaked, or a device that had it is lost): two
  // taps, then the new link is shown once and this page carries on with it.
  const replaceBtn = body.querySelector<HTMLButtonElement>('#replace-admin')!;
  confirmTwice(replaceBtn, 'Tap again to replace. The current admin link stops working everywhere.', async (rearm) => {
    replaceBtn.disabled = true;
    try {
      const res = await apiJson<{ link: string; token: string }>(`/collections/${ctx.id}/admin-link`, ctx.token, { method: 'POST' });
      replaceAdminLink(ctx.id, meta.name, adminLink, res.link); // syncs to the other devices when sync is on
      ctx.token = res.token;
      history.replaceState(null, '', res.link);
      adminLink = res.link;
      refreshEmail();
      const adminBody = body.querySelector<HTMLElement>('.linkrow[data-role="admin"] .linkrow__body')!;
      delete adminBody.dataset.filled; // the row shows the new link next time it opens
      adminBody.setAttribute('hidden', '');
      adminBody.previousElementSibling?.setAttribute('aria-expanded', 'false');
      const out = body.querySelector<HTMLElement>('#ra-new')!;
      out.innerHTML = shareItemHtml('admin-new', '🔑 New admin link', res.link,
        'Save it now. The old admin link no longer works, on any device or tool that had it.');
      wireShareItems(out, title);
      replaceBtn.hidden = true;
    } catch (e) {
      toast((e as Error).message, 'error');
      rearm();
      replaceBtn.textContent = 'Replace admin link';
      replaceBtn.disabled = false;
    }
  });

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

// Named links: mint a labelled collect link, list every collect/view link
// (named, or plainly numbered when unnamed) with how many points each added,
// and turn one off (two taps). The token is shown once, at creation; the list
// only ever has names and counts.
async function wireNamedLinks(body: HTMLElement, title: string): Promise<void> {
  const list = body.querySelector<HTMLElement>('#nl-list')!;
  const render = async (): Promise<void> => {
    try {
      const { links } = await apiJson<{ links: LinkInfo[] }>(`/collections/${ctx.id}/tokens`, ctx.token);
      list.innerHTML = shareTabLinks(links).map((l) => `<div class="link-box${l.active ? '' : ' link-box--off'}">
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(l.name)}
            <span class="hint">· ${l.permission === 'view' ? 'view only' : plural(l.records, 'point')}${l.active ? '' : ' · turned off'}</span></span>
          ${l.active ? `<button type="button" data-revoke="${escapeHtml(l.id)}">Turn off</button>` : ''}
        </div>`).join('');
      list.querySelectorAll<HTMLButtonElement>('button[data-revoke]').forEach((b) => confirmTwice(b, 'Tap again to turn off', () => busy(b, async () => {
        await apiJson(`/collections/${ctx.id}/tokens/${b.dataset.revoke}`, ctx.token, { method: 'DELETE' });
        await render();
      })));
    } catch (e) {
      list.innerHTML = `<p class="warn">${escapeHtml((e as Error).message)}</p>`;
    }
  };

  const input = body.querySelector<HTMLInputElement>('#nl-label')!;
  const make = body.querySelector<HTMLButtonElement>('#nl-make')!;
  make.onclick = async () => {
    const label = input.value.trim();
    if (!label) { input.focus(); return; }
    await busy(make, async () => {
      const res = await apiJson<{ link: string; label: string }>(`/collections/${ctx.id}/tokens`, ctx.token, {
        method: 'POST', body: JSON.stringify({ permission: 'edit', label }),
      });
      const fresh = body.querySelector<HTMLElement>('#nl-new')!;
      fresh.innerHTML = shareItemHtml('named', `🔗 ${res.label}`, res.link, 'Shown once. Copy or share it now; the list below only keeps its name.');
      wireShareItems(fresh, title);
      input.value = '';
      await render();
    }, true);
  };
  await render();
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

// Every record of the map, optionally one status only (or just their shapes),
// page by page (the server
// returns at most 2000 a request), following its cursor so points that arrive
// meanwhile never repeat or push another off the end.
function allRecords<T>(status?: string, geometryOnly = false): Promise<T[]> {
  const q = (status ? `&status=${status}` : '') + (geometryOnly ? '&fields=geometry' : '');
  return fetchAllPages(async (limit, after) => {
    const r = await apiJson<{ features?: T[]; next?: string | null }>(
      `/collections/${ctx.id}/records?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}${q}`, ctx.token);
    return { items: r.features || [], next: r.next ?? null };
  }, 2000);
}

// Fetch every record and hand the author a file — no server round-trip.
async function downloadData(format: 'geojson' | 'csv' | 'kml'): Promise<void> {
  try {
    const { toGeoJSON, toCSV, toKML } = await import('./export/formats'); // admin-only, loaded on demand
    const features = await allRecords<ExportFeature>();
    if (!features.length) { toast('No points to download yet'); return; }
    // The owner's download keeps hidden fields too: hiding keeps the data.
    const keys = meta.schema.fields.map((f) => f.key);
    const [content, mime, ext] =
      format === 'geojson' ? [toGeoJSON(features, keys), 'application/geo+json', 'geojson']
      : format === 'csv' ? [toCSV(features, keys), 'text/csv', 'csv']
      : [toKML(features, keys, meta.name), 'application/vnd.google-earth.kml+xml', 'kml'];
    downloadText(content, `${slug(meta.name)}.${ext}`, mime);
    toast(`Downloaded ${plural(features.length, 'point')} as ${ext.toUpperCase()}`);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

// Import (Phase 5): parse a file → map columns to fields → validate → bulk POST.
async function importFlow(file: File): Promise<void> {
  const panel = document.getElementById('import-panel');
  if (!panel) return;
  // Admin-only import code, loaded on demand.
  const [{ detectFormat, parseImport }, { autoMapping, buildRecords, errorsToCSV }, { importReport, importReportHtml, importInChunks }, { summarizeErrors }] =
    await Promise.all([import('./import/parse'), import('./import/build'), import('./import/report'), import('./import/check')]);
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
    <p class="hint"><strong>${plural(n, 'row')}</strong> found in your ${format.toUpperCase()} file. Match each map field to a column from the file. This applies to <strong>all ${n}</strong> at once, not one point.</p>
    ${needsLngLat
      ? `<div class="maplabel">Location <span class="hint">(a CSV keeps coordinates in columns)</span></div>
         <div class="maprow"><span>Longitude</span><select data-map="lng" aria-label="Longitude column">${opts(guess.lng)}</select></div>
         <div class="maprow"><span>Latitude</span><select data-map="lat" aria-label="Latitude column">${opts(guess.lat)}</select></div>`
      : `<p class="hint">Locations come from the file's own geometry, so there's nothing to match for coordinates.</p>`}
    <div class="maplabel">Fields <span class="hint">(which column fills each)</span></div>
    ${fields.map((f) => `<div class="maprow"><span>${escapeHtml(f.label)}${f.required ? ' *' : ''}</span><select data-field="${f.key}" aria-label="Column for ${escapeHtml(f.label)}">${opts(guess.fields[f.key])}</select></div>`).join('')}
    <div id="map-preview" class="hint" style="margin:10px 0"></div>
    <div class="maplabel">Where's this data from? <span class="hint">(the source, shown in the published credit)</span></div>
    <input id="imp-source" placeholder="e.g. SOI Forest Atlas 2021, or a link" maxlength="200" aria-label="Where's this data from?" />
    <label class="chip" style="gap:8px;margin-top:10px;align-items:flex-start;border-radius:var(--radius-xl);padding:10px 12px"><input type="checkbox" id="imp-rights" style="width:auto;min-height:auto;margin-top:3px"><span style="white-space:normal;font-weight:400;font-size:var(--fs-sm)">I have the right to publish this under the map's licence (${escapeHtml(meta.license)}): it's my own data, or from a source whose terms allow it.</span></label>
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
    if (!rights) { toast('Tick the box: you can publish this under the map licence', 'error'); return; }
    if (!source) { toast('Name where this data comes from', 'error'); return; }
    const plan = buildRecords(parsed.features, readMapping(), fields, meta.schema.geometry);
    const result = document.getElementById('import-result')!;
    btn.disabled = true;
    // Every row is accounted for: added, skipped here, or refused by the server.
    const reply = await importInChunks(plan.records, (records) => apiJson<ImportReply>(`/collections/${ctx.id}/import`, ctx.token, {
      method: 'POST',
      body: JSON.stringify({ records, source, rights_confirmed: true, client_skipped: { count: plan.errors.length, reasons: summarizeErrors(plan.errors) } }),
    }));
    if ('failed' in reply) btn.disabled = false;
    const report = importReport(parsed.features, plan, reply);
    if (report.added) await refreshCounts(); // refetch the cache so Review shows the imported points
    result.innerHTML = importReportHtml(report);
    const dl = document.getElementById('dl-not-added') as HTMLButtonElement | null;
    if (dl) dl.onclick = () => downloadText(errorsToCSV(report.notAdded), 'rows-not-added.csv', 'text/csv');
  };
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
    const feats = await allRecords<Feature>();
    if (gen !== reviewGen) return; // invalidated mid-flight (e.g. a point was added) — discard this snapshot
    allFeats = feats;
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

// Queue card label: the record's `name`, else the first author field value
// (the author may have renamed/removed the seeded `name` field).
function cardTitle(props: Record<string, unknown>): string {
  const named = props.name;
  if (typeof named === 'string' && named.trim()) return named;
  for (const [k, v] of Object.entries(props)) {
    if (!k.startsWith('_') && typeof v === 'string' && v.trim()) return v;
  }
  // A "just photos" point before it's checked: what the model says the photo shows.
  const said = (props._ai as { description?: string } | null | undefined)?.description;
  return said ? said : (props._photos as unknown[] | undefined)?.length ? 'Photo' : '(no name)';
}

// The admin point manager: every marked point (filtered) with per-point CRUD —
// approve/reject (moderation), edit (opens the record editor with the admin
// token), delete. Read = list; Update = edit link; Delete = delete; Create =
// the "+ Add points" button (capture) or a contributor's own add.
// Compact, tappable list — scales to hundreds of points. Titles wrap (never
// truncate). Per-point actions live in the review detail, not the row.
// Render the current filter's rows from the in-memory cache (no network). The
// records are loaded once by ensureReviewData; chip taps just re-run this.
// A page of rows at a time: a map can hold 100k points, and one innerHTML of
// them all froze phones. revealRow (Back from a point) shows enough to include it.
let reviewShown = 0;
function renderPoints(revealRow?: string): void {
  const q = document.getElementById('points');
  if (!q) return;
  const status = activeFilter();
  reviewFeats = filterByStatus(allFeats, status);
  const at = revealRow ? reviewFeats.findIndex((f) => String(f.id) === revealRow) : -1;
  reviewShown = rowsToShow(reviewShown, reviewFeats.length, at);
  clearSelection();     // the previous selection points at stale indices
  syncReviewLayer();    // redraw the clickable markers for this filter
  fitToFeatures(reviewFeats);
  if (!reviewFeats.length) {
    q.innerHTML = (status && allFeats.length)
      ? `<p class="empty">No ${status === 'published' ? 'approved' : status} points.</p>`
      : '<p class="empty">No points here yet. Share the collect link and they will show up as people add them.</p>';
    return;
  }
  q.innerHTML = pointRowsHtml(0, reviewShown) + showMoreHtml();
  wirePointRows(q);
}

function pointRowsHtml(from: number, to: number): string {
  return reviewFeats.slice(from, to).map((f, k) => {
    const st = statusOf(f);
    const geom = f.geometry?.type && f.geometry.type !== 'Point' ? `${nounFor(f.geometry.type)} · ` : '';
    return `<button type="button" class="point-row" data-idx="${from + k}" data-id="${escapeHtml(String(f.id))}">
      <span class="point-row__title">${escapeHtml(geom)}${escapeHtml(cardTitle(f.properties))}</span>
      <span class="badge badge--${st}">${st}</span>
      <span class="point-row__chev" aria-hidden="true">›</span>
    </button>`;
  }).join('');
}

function showMoreHtml(): string {
  const left = reviewFeats.length - reviewShown;
  return left > 0 ? `<button type="button" class="wide" id="points-more">Show more (${left.toLocaleString('en-IN')} left)</button>` : '';
}

// Rows are wired once each; "Show more" appends the next page in place and
// moves focus to its first row (the button it was on goes away).
function wirePointRows(q: HTMLElement): void {
  q.querySelectorAll<HTMLButtonElement>('.point-row:not([data-wired])').forEach((b) => {
    b.dataset.wired = '';
    b.onclick = () => openReview(Number(b.dataset.idx));
  });
  const more = q.querySelector<HTMLButtonElement>('#points-more');
  if (more) more.onclick = () => {
    const from = reviewShown;
    reviewShown = rowsToShow(reviewShown + 1, reviewFeats.length, from);
    more.insertAdjacentHTML('beforebegin', pointRowsHtml(from, reviewShown));
    more.outerHTML = showMoreHtml();
    wirePointRows(q);
    q.querySelector<HTMLElement>(`.point-row[data-idx="${from}"]`)?.focus();
  };
}

const photoCount = (v: unknown): string => {
  const n = Array.isArray(v) ? v.length : 0;
  return n ? `${plural(n, 'photo')}` : 'No photos';
};
const fmtVal = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : v == null || v === '' ? 'n/a' : String(v));

// One attribute row per (non-deleted) field — shared by the review sheet
// (prefix "attr") and the map tooltip (prefix "pop-attr"). Empty-state per caller.
function attrRowsHtml(p: Record<string, unknown>, prefix: string): string {
  return meta.schema.fields
    .filter((x) => !x.deleted)
    .map((fl) => `<div class="${prefix}"><span class="${prefix}__k">${escapeHtml(fl.label)}</span><span class="${prefix}__v">${escapeHtml(fl.type === 'photo' ? photoCount(p[fl.key]) : fmtVal(p[fl.key]))}</span></div>`)
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
  const p = f.properties as {
    _status?: string; _contributor?: string; _admin_ctx?: { state?: string; district?: string } | null; _source?: string; _link_label?: string | null; _captured_at?: string | null; _created_at?: string;
    _photos?: Array<{ field: string; id: string; url: string }>; _ai?: Notes | null; [k: string]: unknown;
  };
  const st = p._status || 'published';

  const c = representativeCoord(f.geometry);
  clearHighlight();
  releasePhotos(); // the previous point's photos are no longer shown
  selectReviewFeature(idx); // emphasise the same feature on the map
  if (c) {
    reviewMarker = new maplibregl.Marker({ color: '#d97706' }).setLngLat(c).addTo(map);
    map.easeTo({ center: c, zoom: Math.max(map.getZoom(), 14), offset: sheetLiftOffset(), duration: 500 });
  }

  const attrs = attrRowsHtml(p, 'attr');
  // meta line: who (source or a named contributor; nothing for an unnamed capture) + place
  const meta = [recordWho(p._source, p._contributor), recordVia(p._link_label), recordWhen(p._captured_at, p._created_at), recordPlace(p._admin_ctx)]
    .filter(Boolean).map(escapeHtml).join(' · ');
  const panel = document.getElementById('panel')!;
  panel.innerHTML = sheetHtml(`
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px">
        <strong ${SHEET_TITLE} style="flex:1">${escapeHtml(cardTitle(p))}</strong>
        <span class="badge badge--${st}">${st}</span>
      </div>
      ${meta ? `<p class="hint">${meta}</p>` : ''}
      ${p._photos?.length ? '<div class="review-photos" id="rv-photos"></div>' : ''}
      <div class="attrs">${attrs || '<p class="hint">No fields on this map.</p>'}</div>
      ${aiNotesHtml(p._ai ?? null, mapFields(), p, modeOf(mapSchema()), st)}`, { foot: `
      ${st === 'pending'
        ? `<div class="row" style="margin-bottom:8px"><button class="danger" id="rv-reject" style="flex:1">✗ Reject</button><button class="primary" id="rv-approve" style="flex:1">✓ Approve</button></div>`
        : st === 'rejected'
          ? `<button class="primary" id="rv-approve" style="width:100%;margin-bottom:8px">✓ Approve</button>`
          : ''}
      <div class="row">
        <button id="rv-back" style="flex:1">← List</button>
        <button id="rv-edit" style="flex:1">✎ Edit</button>
        <button class="danger" id="rv-delete" style="flex:1">🗑 Delete</button>
      </div>` });

  focusSheet(panel);
  // Back to the list, focus on this point's row (the title, if it has gone).
  const back = () => { clearHighlight(); void manageSheet({ row: String(f.id) }); };
  (document.getElementById('rv-back') as HTMLButtonElement).onclick = back;
  if (p._photos?.length) showReviewPhotos(document.getElementById('rv-photos')!, p._photos.map((x) => x.url));
  // A point filled in from its photo is approved with its notes ("Looks right, approve").
  if (document.getElementById('ai-approve')) document.getElementById('rv-approve')?.remove();
  wireAiReview(String(f.id), back);
  (document.getElementById('rv-edit') as HTMLButtonElement).onclick = () => { location.href = recordUrl('', ctx.id, String(f.id), ctx.token); };
  const moderate = async (s: string) => {
    try { await apiJson(`/records/${f.id}/moderate`, ctx.token, { method: 'POST', body: JSON.stringify({ status: s }) }); patchReview(withStatus(allFeats, String(f.id), s)); back(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  document.getElementById('rv-approve')?.addEventListener('click', () => void moderate('published'));
  document.getElementById('rv-reject')?.addEventListener('click', () => void moderate('rejected'));
  confirmTwice(document.getElementById('rv-delete') as HTMLButtonElement, 'Tap to confirm', async () => {
    try { await apiJson(`/records/${f.id}`, ctx.token, { method: 'DELETE' }); patchReview(withoutRecord(allFeats, String(f.id))); back(); }
    catch (e) { toast((e as Error).message, 'error'); }
  });
}

// The point's photos in review: the first one large, the rest as thumbnails;
// any of them full screen on tap. Pending photos are private, so fetched with the token.
function showReviewPhotos(box: HTMLElement, urls: string[]): void {
  void Promise.all(urls.map((u) => authedSrc(u, ctx.token))).then((srcs) => {
    const ok = srcs.filter(Boolean);
    if (!ok.length) { box.innerHTML = '<p class="hint">Photos could not be loaded.</p>'; return; }
    box.innerHTML = ok.map((src, i) => `<button type="button" class="${i === 0 ? 'review-photo--main' : 'review-photo'}" data-i="${i}" aria-label="Photo ${i + 1} of ${ok.length}, open full screen"><img src="${escapeHtml(src)}" alt=""></button>`).join('');
    box.querySelectorAll<HTMLButtonElement>('button[data-i]').forEach((b) => { b.onclick = () => openViewer(ok, Number(b.dataset.i)); });
  });
  box.innerHTML = '<span class="spinner"></span>';
}

// Accept, discard, or (a "just photos" point) accept and approve, then go on
// to the next point waiting for a check.
function wireAiReview(id: string, back: () => void): void {
  const send = async (body: Record<string, unknown>): Promise<boolean> => {
    const desc = document.getElementById('ai-desc') as HTMLTextAreaElement | null;
    if (desc && body.action === 'accept') body.description = desc.value;
    try {
      const reply = await apiJson<{ review: string; status?: string; properties?: Record<string, unknown> }>(`/records/${id}/ai`, ctx.token, { method: 'POST', body: JSON.stringify(body) });
      patchReview(withAiReview(allFeats, id, reply, body.description as string | undefined));
      return true;
    } catch (e) { toast((e as Error).message, 'error'); return false; }
  };
  document.getElementById('ai-discard')?.addEventListener('click', async () => { if (await send({ action: 'discard' })) { toast('Notes discarded'); reopen(id, back); } });
  document.getElementById('ai-accept')?.addEventListener('click', async () => { if (await send({ action: 'accept' })) { toast('Notes accepted ✓'); reopen(id, back); } });
  document.getElementById('ai-approve')?.addEventListener('click', async () => {
    if (!(await send({ action: 'accept', approve: true }))) return;
    toast('Approved ✓');
    const next = allFeats.findIndex((x) => String(x.id) !== id && statusOf(x) === 'pending');
    if (next < 0) { back(); return; }
    reviewFeats = allFeats;
    syncReviewLayer();
    openReview(next);
  });
}

// The same point again, from the refreshed records (its notes have changed).
function reopen(id: string, back: () => void): void {
  reviewFeats = allFeats;
  syncReviewLayer();
  const i = allFeats.findIndex((x) => String(x.id) === id);
  if (i >= 0) openReview(i); else back();
}

const mapSchema = (): Meta['schema'] => meta.schema;
const mapFields = (): Field[] => meta.schema.fields;

// Publishing to the public catalog is a bigger step than "save" — the points are
// already on this map. Explain that first; it curbs accidental catalog submissions
// from people who think publishing is how they view or keep their data.
function confirmPublish(): void {
  const c = meta.counts;
  const panel = document.getElementById('panel')!;
  panel.innerHTML = sheetHtml(`
    <strong>Submit to bharatlas?</strong>
    <p class="hint">Your ${c.published} approved point${c.published === 1 ? '' : 's'} are already saved and shown on this map. Submitting sends them to <strong>bharatlas</strong> as an open layer. <strong>A bharatlas maintainer reviews and approves every submission before it goes live</strong> at bharatlas.com, so it won't be public until then. Do this once the map is ready to share widely.</p>
    ${c.pending ? `<p class="hint">${c.pending} pending point${c.pending === 1 ? '' : 's'} won't be included until you approve them in Review.</p>` : ''}`,
  { back: 'pub-cancel', primary: ['pub-go', c.published ? `Submit ${c.published} for review` : 'Submit'] });
  (document.getElementById('pub-cancel') as HTMLButtonElement).onclick = () => void manageSheet();
  (document.getElementById('pub-go') as HTMLButtonElement).onclick = (e) => void runPublish(e.currentTarget as HTMLButtonElement);
}

async function runPublish(btn: HTMLButtonElement): Promise<void> {
  await busy(btn, async () => {
    const res = await apiJson<{ version: number; feature_count: number; message?: string }>(
      `/collections/${ctx.id}/publish`, ctx.token, { method: 'POST' },
    );
    toast(`Submitted v${res.version} · ${res.feature_count} features`);
    const panel = document.getElementById('panel')!;
    panel.innerHTML = sheetHtml(`
      <strong>Submitted for review ✓</strong>
      <p class="hint">Version ${res.version} · ${res.feature_count} features. ${escapeHtml(res.message || 'A curator reviews it before it goes live on bharatlas.')}</p>`,
    { foot: '<button id="back">← Back to manage</button>' });
    (document.getElementById('back') as HTMLButtonElement).onclick = () => void manageSheet();
  });
}

// The contributor's own record: edit / delete / de-identify via the rec_ token
// (reached at /c/<id>/r/<record-id>#<rec_>).
async function recordEditor(): Promise<void> {
  const rec = await apiJson<{
    id: string; status: string; contributor: string | null;
    geometry: { type: string; coordinates: number[] };
    properties: Record<string, unknown>;
    photos?: Array<{ field: string; id: string; url: string }>;
    schema: Meta['schema']; collection_name: string;
  }>(`/records/${ctx.recordId}`, ctx.token);
  const fields = rec.schema.fields.filter((f) => !f.deleted);
  const isPoint = rec.geometry.type === 'Point';
  const noun = nounFor(rec.geometry.type);
  const center = representativeCoord(rec.geometry) ?? INDIA_CENTER;
  // Opened from an emailed/copied edit link: save it to "Your maps" too.
  rememberRecord(ctx.id, rec.collection_name, { id: rec.id, label: recordLabel(rec.properties, noun), link: location.href });

  app.innerHTML = `
    <div class="topbar"><a href="${escapeHtml(backLink(myMaps(), ctx.id))}" aria-label="Back">←</a><span>Your ${noun}</span>
      <span class="muted" style="margin-left:auto">${escapeHtml(rec.collection_name)}</span></div>
    <div class="map">
      <div id="map"></div>${isPoint ? '<div class="crosshair" aria-hidden="true"></div>' : ''}
      <div class="map-loading" id="maploading"><span class="spinner"></span> Loading map…</div>
      ${isPoint ? '<button class="locate" id="locate" aria-label="Use my location">◎</button>' : ''}
    </div>
    <div id="panel">${sheetHtml(`
        <strong>Edit your ${noun}</strong>
        <p class="hint">${isPoint ? 'Move the map to reposition; update the details.' : 'Update the details below.'} Status: ${escapeHtml(rec.status)}.</p>
        ${fieldsHtml(fields)}`, { form: 'recform', foot: `
        <button class="primary" id="save">Save changes</button>
        <div class="row" style="margin-top:8px">
          <button type="button" id="deid" style="flex:1"${rec.contributor ? '' : ' disabled'}>Remove my name</button>
          <button type="button" id="del" style="flex:1">Delete ${noun}</button>
        </div>` })}</div>`;
  installSheetMetrics();

  map = mountMap(buildBaseStyle(getStoredBasemap() ?? normalizeBasemap(rec.schema.basemap)), center, isPoint ? 16 : 14);
  // Only rewrite the point's location if the user actually repositioned it — a
  // plain "fix a typo and Save" must leave the point exactly where it was.
  let moved = false;
  map.on('dragstart', () => { moved = true; });
  map.on('load', () => {
    if (isPoint) {
      marker(center);
      // Sit the point UNDER the crosshair (which rides above map centre), so the
      // marker and the target line up and repositioning reads true.
      map.easeTo({ center, offset: crosshairScreenOffset(), duration: 0 });
      return;
    }
    map.addSource('rec', { type: 'geojson', data: { type: 'Feature', geometry: rec.geometry as GeoJSON.Geometry, properties: {} } });
    addShapeLayers('rec', { 'fill-color': ACCENT, 'fill-opacity': 0.15 }, { 'line-color': ACCENT, 'line-width': 2.5 });
  });

  const panel = document.getElementById('panel')!;
  // Photos: shown with this link's token; only the map's admin can add new ones here.
  const isAdmin = ctx.token.startsWith('adm_');
  const photoInputs = mountPhotoFields(panel, fields, !!rec.schema.data_saver, (f) => ({
    token: ctx.token, canAdd: isAdmin, initial: (rec.photos ?? []).filter((x) => x.field === f.key),
  }));
  wireChips(panel);
  fillAnswers(panel, fields, rec.properties);

  const locateBtn = document.getElementById('locate') as HTMLButtonElement | null;
  if (locateBtn) wireLocate(locateBtn, (lngLat) => { moved = true; easeToFix(lngLat); });

  (document.getElementById('save') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const form = document.getElementById('recform') as HTMLFormElement;
    if (!form.reportValidity()) return;
    if (photoInputs.some((p) => p.busy())) { toast('One moment: a photo is still being made ready'); return; }
    await busy(btn, async () => {
      const raw = readAnswers(panel, fields);
      for (const p of photoInputs) {
        const ids: string[] = [];
        for (const it of p.items()) {
          if (it.id) { ids.push(it.id); continue; }
          const up = await uploadPhoto(ctx.id, ctx.token, { client_id: it.client_id, bytes: it.bytes!, meta: it.meta });
          if (!up.ok) throw new Error(`Couldn't upload a photo: ${up.error}`);
          ids.push(up.id);
        }
        if (ids.length) raw[p.field.key] = ids;
      }
      const valid = validateRecordProperties(fields, raw, { photosOnly: !isAdmin && modeOf(rec.schema) === 'photos_ai' });
      if (!valid.ok) { toast(valid.error, 'error'); return; }
      // Points can be repositioned by panning; shapes edit properties only. Only
      // write geometry when the user actually moved the map (else leave it put).
      const body: Record<string, unknown> = { properties: valid.properties };
      if (isPoint && moved) body.geometry = { type: 'Point', coordinates: crosshairLngLat() };
      await apiJson(`/records/${ctx.recordId}`, ctx.token, { method: 'PATCH', body: JSON.stringify(body) });
      toast('Saved ✓');
    }, true);
  };

  const deid = document.getElementById('deid') as HTMLButtonElement;
  deid.onclick = () => busy(deid, async () => {
    await apiJson(`/records/${ctx.recordId}/deidentify`, ctx.token, { method: 'POST' });
    toast('Your name was removed ✓');
  });

  const del = document.getElementById('del') as HTMLButtonElement;
  confirmTwice(del, 'Tap again to delete', () => busy(del, async () => {
    await apiJson(`/records/${ctx.recordId}`, ctx.token, { method: 'DELETE' });
    forgetRecord(ctx.id, ctx.recordId!);
    app.innerHTML = `<div class="pad"><h1>${cap(noun)} deleted</h1><p class="hint">Your contribution was removed.</p><a class="btn" href="${escapeHtml(backLink(myMaps(), ctx.id))}">← Back to the map</a></div>`;
  }));
}

startAutoSync(); // if this device turned sync on, saved links follow it to the others
sendWhenOnline(); // points kept on this phone go as soon as there's signal
const initCtx = parseCtx();
if (!initCtx?.token) {
  app.innerHTML = linkProblemHtml();
} else {
  ctx = initCtx;
  app.innerHTML = `<div class="pad center"><span class="spinner"></span><p class="hint">Loading…</p></div>`;
  (initCtx.mode === 'record' ? recordEditor() : boot()).catch((e) => {
    app.innerHTML = isLinkProblem(e)
      ? linkProblemHtml()
      : `<div class="pad"><h1>Couldn't open this map</h1><p class="warn">${escapeHtml(loadErrorText(e))}</p></div>`;
  });
}
