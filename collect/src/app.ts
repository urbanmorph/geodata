// The /c/<id>[/admin|/view] app: a full-bleed map with a fixed crosshair for
// pin-drop, an "Use my location" button (geolocation called synchronously in the
// tap handler), a bottom-sheet form generated from the collection's schema, and
// — for admin — a review queue + publish. Mobile-first.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BASEMAP, INDIA_CENTER } from './basemap';
import { parseCtx, apiJson, type Ctx } from './api';
import { turnstileToken } from './turnstile';
import { validateRecordProperties, type Field } from './schema/validate-record';
import { orderedModes, drawGeometry, type GeomMode, type Coord } from './geo/draw';
import { representativeCoord } from './geo/admin-ctx';
import { escapeHtml } from './util';
interface Counts { pending: number; published: number; total: number; rejected: number; }
interface Meta {
  id: string; name: string; purpose: string; status: string; moderation: number;
  schema: { geometry: string[]; fields: Field[] }; counts: Counts;
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
      ${isAdmin ? `<button class="locate" id="manage" aria-label="Manage map${meta.counts.pending ? `, ${meta.counts.pending} pending review` : ''}" style="left:12px;right:auto;bottom:76px;width:auto;padding:0 14px">⚙${meta.counts.pending ? ` ${meta.counts.pending}` : ''}</button>` : ''}
    </div>
    <div id="panel"></div>`;

  map = new maplibregl.Map({
    container: 'map', style: BASEMAP, center: INDIA_CENTER, zoom: 4,
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
    void loadRecords();
  });

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
    captureSheet();
  }
  if (isAdmin) {
    (document.getElementById('manage') as HTMLButtonElement).onclick = manageSheet;
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
  line: 'Pan so the crosshair is on each point, then tap + vertex. Need 2 or more.',
  polygon: 'Pan the crosshair to each corner, then tap + vertex. Need 3 or more.',
};

function captureSheet(): void {
  const fields = meta.schema.fields.filter((f) => !f.deleted);
  const modes = orderedModes(meta.schema.geometry);
  drawMode = modes[0];
  verts = [];
  redrawDraw();
  const panel = document.getElementById('panel')!;
  const seg = modes.length > 1
    ? `<div class="seg" id="modesw">${modes.map((m) => `<button type="button" data-m="${m}"${m === drawMode ? ' class="on"' : ''}>${NOUN[m][0].toUpperCase()}${NOUN[m].slice(1)}</button>`).join('')}</div>`
    : '';
  panel.innerHTML = `<div class="sheet">
    <form class="body" id="capform">
      <strong>Add a <span id="cap-noun">${NOUN[drawMode]}</span></strong>
      ${seg}
      <p class="hint" id="cap-help">${CAP_HELP[drawMode]}</p>
      <div class="row" id="drawctl" style="display:none;align-items:center">
        <button type="button" id="vadd">+ vertex</button>
        <button type="button" id="vundo">Undo</button>
        <span class="hint" id="vcount"></span>
      </div>
      ${fields.map((f) => `<label>${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>${f.hint ? `<p class="hint" style="margin:-2px 0 4px">${escapeHtml(f.hint)}</p>` : ''}${fieldInput(f)}`).join('')}
      <label>Your name <span class="hint">(optional, published with the data)</span></label>
      <input id="contributor" />
    </form>
    <div class="foot"><button class="primary" id="add">Add ${NOUN[drawMode]}</button></div>
    <div id="lastadded" class="hint" style="padding:0 16px 10px"></div>
  </div>`;
  panel.querySelectorAll<HTMLElement>('[data-multi] .chip').forEach((c) => { c.onclick = () => c.classList.toggle('on'); });

  const syncDrawUI = (): void => {
    document.getElementById('cap-noun')!.textContent = NOUN[drawMode];
    document.getElementById('cap-help')!.textContent = CAP_HELP[drawMode];
    (document.getElementById('add') as HTMLButtonElement).textContent = `Add ${NOUN[drawMode]}`;
    document.getElementById('drawctl')!.style.display = drawMode === 'point' ? 'none' : 'flex';
    document.getElementById('vcount')!.textContent = `${verts.length} point${verts.length === 1 ? '' : 's'}`;
    document.querySelectorAll('#modesw button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.m === drawMode));
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

  (document.getElementById('add') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const form = document.getElementById('capform') as HTMLFormElement;
    if (!form.reportValidity()) return; // native: required, URL format, number min/max
    const c = map.getCenter();
    const geometry = drawGeometry(drawMode, verts, [c.lng, c.lat]);
    if (!geometry) { toast(`A ${NOUN[drawMode]} needs ${drawMode === 'line' ? '2' : '3'} points or more`); return; }
    btn.disabled = true;
    try {
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
      // Same validator the server uses — immediate feedback, no wasted round-trip.
      const valid = validateRecordProperties(fields, raw);
      if (!valid.ok) { toast(valid.error); btn.disabled = false; return; }
      const contributor = (document.getElementById('contributor') as HTMLInputElement).value;
      const turnstile_token = await turnstileToken();
      const res = await apiJson<{ id: string; edit_token: string }>(`/collections/${ctx.id}/records`, ctx.token, {
        method: 'POST',
        body: JSON.stringify({ geometry, properties: valid.properties, contributor, turnstile_token }),
      });
      if (geometry.type === 'Point') marker(geometry.coordinates);
      else addRecordShape(geometry);
      verts = []; redrawDraw(); syncDrawUI();
      toast(meta.moderation ? `Added, pending review ✓` : 'Added ✓');
      const editUrl = `${location.origin}/c/${ctx.id}/r/${res.id}#${res.edit_token}`;
      const la = document.getElementById('lastadded');
      if (la) la.innerHTML = `✓ Added. <a href="${editUrl}">edit this ${NOUN[drawMode]}</a>`;
      // Keep #contributor — one surveyor adds many points and shouldn't re-type their name.
      panel.querySelectorAll('input:not(#contributor),textarea,select').forEach((el) => { (el as HTMLInputElement).value = ''; });
      panel.querySelectorAll('.chip.on').forEach((c2) => c2.classList.remove('on'));
      btn.textContent = `Add ${NOUN[drawMode]}`;
    } catch (e) {
      // Field resilience (spec): keep the entry on failure, offer a retry.
      toast(`Couldn't save: ${(e as Error).message}. Your entry is kept, tap Retry.`);
      btn.textContent = 'Retry';
    }
    btn.disabled = false;
  };
}

async function manageSheet(): Promise<void> {
  const fresh = await apiJson<Meta>(`/collections/${ctx.id}`, ctx.token).catch(() => meta);
  const counts = fresh.counts;
  const panel = document.getElementById('panel')!;
  panel.innerHTML = `<div class="sheet">
    <div class="body">
      <strong>Manage map</strong>
      <p class="hint">${counts.published} approved · ${counts.pending} pending · ${counts.total} total</p>
      <div id="queue"><p class="hint">Loading pending…</p></div>
      <strong style="display:block;margin-top:14px">Share links</strong>
      <p class="hint">Mint a fresh link to share. The original links can't be shown again.</p>
      <div class="row">
        <button id="mint-edit">+ Collect link</button>
        <button id="mint-view">+ View-only link</button>
      </div>
      <div id="minted"></div>
    </div>
    <div class="foot row">
      <button id="back">← Capture</button>
      <button class="primary" id="publish" style="flex:1">Publish → atlas</button>
    </div>
  </div>`;
  (document.getElementById('back') as HTMLButtonElement).onclick = captureSheet;
  (document.getElementById('publish') as HTMLButtonElement).onclick = doPublish;

  const mint = async (permission: 'edit' | 'view') => {
    try {
      const res = await apiJson<{ link: string }>(`/collections/${ctx.id}/tokens`, ctx.token, {
        method: 'POST', body: JSON.stringify({ permission }),
      });
      const box = document.getElementById('minted')!;
      const row = document.createElement('div');
      row.className = 'link-box';
      row.innerHTML = `<code>${res.link}</code><button>Copy</button>`;
      const btn = row.querySelector('button')!;
      btn.onclick = () => { navigator.clipboard?.writeText(res.link); btn.textContent = '✓'; };
      box.prepend(row);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  (document.getElementById('mint-edit') as HTMLButtonElement).onclick = () => mint('edit');
  (document.getElementById('mint-view') as HTMLButtonElement).onclick = () => mint('view');

  renderQueue();
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

async function renderQueue(): Promise<void> {
  const q = document.getElementById('queue');
  if (!q) return;
  try {
    const fc = await apiJson<{ features: Feature[] }>(`/collections/${ctx.id}/records?status=pending&limit=25`, ctx.token);
    const feats = fc.features || [];
    if (!feats.length) { q.innerHTML = '<p class="hint">Nothing pending.</p>'; return; }
    q.innerHTML = feats.map((f) => `<div class="card" data-id="${f.id}">
        <div>${escapeHtml(cardTitle(f.properties))}</div>
        <div class="hint">${escapeHtml((f.properties as { _contributor?: string })._contributor || 'anonymous')}${fmtAdminCtx((f.properties as { _admin_ctx?: AdminCtx })._admin_ctx ?? null)}</div>
        <div class="row" style="margin-top:8px">
          <button data-act="rejected" style="flex:1">✗ Reject</button>
          <button class="primary" data-act="published" style="flex:1">✓ Approve</button>
        </div></div>`).join('');
    q.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
      b.onclick = async () => {
        const card = b.closest('.card') as HTMLElement;
        try {
          await apiJson(`/records/${card.dataset.id}/moderate`, ctx.token, {
            method: 'POST', body: JSON.stringify({ status: b.dataset.act }),
          });
          card.remove();
        } catch (e) { toast((e as Error).message); }
      };
    });
  } catch (e) {
    q.innerHTML = `<p class="warn">${(e as Error).message}</p>`;
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
    schema: { geometry: string[]; fields: Field[] }; collection_name: string;
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

  map = new maplibregl.Map({ container: 'map', style: BASEMAP, center, zoom: isPoint ? 16 : 14, attributionControl: false });
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
