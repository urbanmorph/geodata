// The /c/<id>[/admin|/view] app: a full-bleed map with a fixed crosshair for
// pin-drop, an "Use my location" button (geolocation called synchronously in the
// tap handler), a bottom-sheet form generated from the collection's schema, and
// — for admin — a review queue + publish. Mobile-first.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BASEMAP, INDIA_CENTER } from './basemap';
import { parseCtx, apiJson, type Ctx } from './api';

interface Field {
  key: string; label: string; type: string; required?: boolean; options?: string[]; deleted?: boolean;
}
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

function toast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2400);
}

function marker(coords: number[], color = '#1a7f5a'): void {
  if (coords.length >= 2) new maplibregl.Marker({ color }).setLngLat([coords[0], coords[1]]).addTo(map);
}

async function boot(): Promise<void> {
  ctx = parseCtx()!;
  meta = await apiJson<Meta>(`/collections/${ctx.id}`, ctx.token);
  const isView = ctx.mode === 'view';
  const isAdmin = ctx.mode === 'admin';

  app.innerHTML = `
    <div class="topbar">
      <a href="/">←</a><span>${meta.name}</span>
      <span class="muted" style="margin-left:auto">${isAdmin ? 'admin' : isView ? 'view' : ''}</span>
    </div>
    <div class="map">
      <div id="map"></div>
      <div class="crosshair" ${isView ? 'style="display:none"' : ''}></div>
      ${isView ? '' : '<button class="locate" id="locate" title="Use my location">◎</button>'}
      ${isAdmin ? '<button class="locate" id="manage" style="left:12px;right:auto;bottom:76px">⚙</button>' : ''}
    </div>
    <div id="panel"></div>`;

  map = new maplibregl.Map({
    container: 'map', style: BASEMAP, center: INDIA_CENTER, zoom: 4,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('load', loadRecords);

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
}

async function loadRecords(): Promise<void> {
  try {
    const fc = await apiJson<{ features: Feature[] }>(`/collections/${ctx.id}/records`, ctx.token);
    for (const f of fc.features || []) if (f.geometry?.type === 'Point') marker(f.geometry.coordinates);
  } catch { /* map still usable */ }
}

function fieldInput(f: Field): string {
  switch (f.type) {
    case 'paragraph': return `<textarea data-k="${f.key}"></textarea>`;
    case 'number': return `<input data-k="${f.key}" inputmode="decimal" />`;
    case 'date': return `<input data-k="${f.key}" type="date" />`;
    case 'url': return `<input data-k="${f.key}" inputmode="url" placeholder="https://" />`;
    case 'select':
      return `<select data-k="${f.key}"><option value=""></option>${(f.options || []).map((o) => `<option>${o}</option>`).join('')}</select>`;
    case 'multiselect':
      return `<div class="row" data-k="${f.key}" data-multi>${(f.options || []).map((o) => `<button type="button" class="chip" data-v="${o}">${o}</button>`).join('')}</div>`;
    default: return `<input data-k="${f.key}" />`;
  }
}

function captureSheet(): void {
  const fields = meta.schema.fields.filter((f) => !f.deleted);
  const panel = document.getElementById('panel')!;
  panel.innerHTML = `<div class="sheet">
    <div class="body">
      <strong>Add a point</strong>
      <p class="hint">Move the map so the crosshair sits on the spot.</p>
      ${fields.map((f) => `<label>${f.label}${f.required ? ' *' : ''}</label>${fieldInput(f)}`).join('')}
      <label>Your name <span class="hint">(optional — published with the data)</span></label>
      <input id="contributor" />
    </div>
    <div class="foot"><button class="primary" id="add">Add point</button></div>
  </div>`;
  panel.querySelectorAll<HTMLElement>('[data-multi] .chip').forEach((c) => { c.onclick = () => c.classList.toggle('on'); });

  (document.getElementById('add') as HTMLButtonElement).onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      const props: Record<string, unknown> = {};
      for (const f of fields) {
        const el = panel.querySelector(`[data-k="${f.key}"]`);
        if (!el) continue;
        if (f.type === 'multiselect') {
          const on = [...el.querySelectorAll('.chip.on')].map((c) => (c as HTMLElement).dataset.v);
          if (on.length) props[f.key] = on;
        } else if (f.type === 'number') {
          const v = (el as HTMLInputElement).value; if (v) props[f.key] = Number(v);
        } else {
          const v = (el as HTMLInputElement).value; if (v) props[f.key] = v;
        }
      }
      const c = map.getCenter();
      const contributor = (document.getElementById('contributor') as HTMLInputElement).value;
      await apiJson(`/collections/${ctx.id}/records`, ctx.token, {
        method: 'POST',
        body: JSON.stringify({ geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: props, contributor }),
      });
      marker([c.lng, c.lat]);
      toast(meta.moderation ? 'Added — pending review ✓' : 'Added ✓');
      panel.querySelectorAll('input,textarea,select').forEach((el) => { (el as HTMLInputElement).value = ''; });
      panel.querySelectorAll('.chip.on').forEach((c) => c.classList.remove('on'));
    } catch (e) {
      toast((e as Error).message);
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
    </div>
    <div class="foot row">
      <button id="back">← Capture</button>
      <button class="primary" id="publish" style="flex:1">Publish v${'?'} → atlas</button>
    </div>
  </div>`;
  (document.getElementById('back') as HTMLButtonElement).onclick = captureSheet;
  (document.getElementById('publish') as HTMLButtonElement).onclick = doPublish;
  renderQueue();
}

async function renderQueue(): Promise<void> {
  const q = document.getElementById('queue');
  if (!q) return;
  try {
    const fc = await apiJson<{ features: Feature[] }>(`/collections/${ctx.id}/records?status=pending&limit=25`, ctx.token);
    const feats = fc.features || [];
    if (!feats.length) { q.innerHTML = '<p class="hint">Nothing pending.</p>'; return; }
    q.innerHTML = feats.map((f) => `<div class="card" data-id="${f.id}">
        <div>${String((f.properties as { name?: string }).name ?? '(no name)')}</div>
        <div class="hint">${(f.properties as { _contributor?: string })._contributor || 'anonymous'}</div>
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

if (!parseCtx()?.token) {
  app.innerHTML = `<div class="pad"><h1>Invalid link</h1><p class="hint">Open a collect link (with its token in the URL) to continue.</p></div>`;
} else {
  boot().catch((e) => {
    app.innerHTML = `<div class="pad"><h1>Couldn't load</h1><p class="warn">${(e as Error).message}</p></div>`;
  });
}
