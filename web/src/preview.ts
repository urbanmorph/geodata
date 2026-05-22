// /contribute — drop a file, see it on a map, fill metadata, publish.
//
// One page that combines what /verify and /submit used to do separately.
// Steps:
//   1. Drop / pick / handoff from home → file
//   2. Parse → validate locally → render on map → show report
//   3. If valid, reveal metadata form
//   4. Form + Turnstile → POST /api/submit → show admin token once
//
// URL state:
//   ?url=https://… → fetch remote and treat as a drop (verify-style preview)
//   ?category=…   → preselects the category dropdown

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { validate, INDIA_BBOX, type FC, type Report } from './validate';
import { fileToFC, type Format } from './parse-geo';
import { popHandoff, stashForSubmit } from './handoff';
import { overlayLoader, VERBS_VERIFY_RENDER, VERBS_VERIFY_FETCH, VERBS_ENGINE, inlineLoader } from './loading';
import { escapeHtml } from './util';
import {
  saveSubmission,
  listSubmissions,
  getSubmission,
  hydrateLegacyTokens,
  type StoredSubmission,
} from './my-submissions';
import { parseAdminUrl } from './paste-back';

type SuccessPayload = {
  id: string;
  share_url: string;
  admin_url: string;
  admin_token: string;
  expires_at: string | null;
  report: Record<string, { ok: boolean; warn?: boolean; reason?: string; info?: Record<string, unknown> }>;
};

// ---------- DOM refs ------------------------------------------------------
const drop = document.getElementById('drop') as HTMLLabelElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const workspace = document.getElementById('workspace')!;
const reportEl = document.getElementById('report')!;
const form = document.getElementById('meta') as HTMLFormElement;
const publishCta = document.getElementById('publish-cta')!;
const publishOpenBtn = document.getElementById('publish-open') as HTMLButtonElement;
const publishCancelBtn = document.getElementById('publish-cancel') as HTMLButtonElement;
const viewOnlyBanner = document.getElementById('view-only-banner')!;
const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement;
const statusEl = document.getElementById('submit-status')!;
const successEl = document.getElementById('success')!;
const captchaEl = document.getElementById('captcha') as HTMLDivElement;
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement;

let selectedFile: File | null = null;
let selectedFC: FC | null = null;
let selectedFormat: Format | null = null;
let turnstileToken: string | null = null;
let turnstileWidgetId: string | number | null = null;

// View-only mode: arrived via ?url= (i.e. clicking "view on map" on a
// listed submission). Hide the publish CTA — re-submitting an already-
// listed file is not a thing. User can still see the map + validation.
const viewOnly = new URLSearchParams(location.search).has('url');

// ---------- Map -----------------------------------------------------------
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

function renderOnMap(fc: FC, bbox: Report['bbox']) {
  for (const id of ['c-fill', 'c-line', 'c-pt']) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource('v')) map.removeSource('v');
  map.addSource('v', { type: 'geojson', data: fc as never });
  map.addLayer({
    id: 'c-fill',
    type: 'fill',
    source: 'v',
    paint: { 'fill-color': '#0a58ca', 'fill-opacity': 0.22 },
    filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
  });
  map.addLayer({
    id: 'c-line',
    type: 'line',
    source: 'v',
    paint: { 'line-color': '#0a58ca', 'line-width': 0.8 },
    filter: ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']]],
  });
  map.addLayer({
    id: 'c-pt',
    type: 'circle',
    source: 'v',
    paint: { 'circle-radius': 3, 'circle-color': '#0a58ca' },
    filter: ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]],
  });
  if (bbox) {
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 32, duration: 600 });
  }
}

// ---------- Drop / pick wiring -------------------------------------------
['dragenter', 'dragover'].forEach((evt) =>
  drop.addEventListener(evt, (e) => {
    e.preventDefault();
    drop.classList.add('dragover');
  }),
);
['dragleave', 'drop'].forEach((evt) =>
  drop.addEventListener(evt, (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
  }),
);
drop.addEventListener('drop', (e: DragEvent) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) handleFile(f);
});

// Drag-anywhere on the page (once a file is loaded the dropzone is hidden;
// we still want a global drop affordance to replace it).
window.addEventListener('dragover', (e) => {
  if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (workspace.classList.contains('show') || successEl.classList.contains('show')) {
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      e.preventDefault();
      handleFile(f);
    }
  }
});

resetBtn.addEventListener('click', () => resetState());

// ---------- Handoff from home page ---------------------------------------
//
// Three race-resistant paths to popAndRender so we don't miss the file dropped
// on /. See the comment in src/verify.ts for the long story.
console.log(
  '[contribute] init · styleLoaded:', map.isStyleLoaded(),
  '· mapLoaded:', map.loaded(),
  '· sessionStorage:', sessionStorage.getItem('geodata:handoff'),
);
let popTriggered = false;
const popAndConsume = async (src: string) => {
  if (popTriggered) return;
  popTriggered = true;
  console.log('[contribute] popAndConsume via:', src);
  try {
    const f = await popHandoff();
    console.log('[contribute] popHandoff →', f && { name: f.name, size: f.size, type: f.type });
    if (f) {
      drop.style.display = 'none';
      handleFile(f);
    } else {
      // No handoff; allow URL-param flow to kick in if present.
      void maybeFetchUrlParam();
    }
  } catch (err) {
    console.error('[contribute] handoff pop failed', err);
  }
};
if (map.isStyleLoaded()) {
  popAndConsume('isStyleLoaded');
} else {
  map.once('load', () => popAndConsume('load-event'));
}
setTimeout(() => popAndConsume('200ms-fallback'), 200);

// ---------- ?url=… preview (back-compat with /verify?url=) ----------------
async function maybeFetchUrlParam(): Promise<void> {
  const urlParam = new URLSearchParams(location.search).get('url');
  if (!urlParam) return;
  drop.style.display = 'none';
  workspace.classList.add('show');
  const fetchLoader = inlineLoader(reportEl, VERBS_VERIFY_FETCH);
  try {
    const resp = await fetch(urlParam);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const name = urlParam.split('/').pop() || 'remote.geojson';
    fetchLoader.dismiss();
    await handleFile(new File([blob], name));
  } catch (e) {
    fetchLoader.dismiss();
    renderReport([{ k: `fetch failed: ${(e as Error).message}`, level: 'err' }]);
  }
}

// ---------- Pre-fill category from ?category= ----------------------------
{
  const cat = new URLSearchParams(location.search).get('category');
  if (cat) {
    const select = document.getElementById('f-cat') as HTMLSelectElement;
    if (select && [...select.options].some((o) => o.value === cat)) select.value = cat;
  }
}

// ---------- Validate + render --------------------------------------------
async function handleFile(file: File): Promise<void> {
  selectedFile = file;
  selectedFC = null;
  selectedFormat = null;
  hideForm();
  hideSuccess();
  workspace.classList.add('show');
  drop.style.display = 'none';

  if (file.size > 500 * 1024 * 1024) {
    renderReport([{ k: `file is ${fmtBytes(file.size)} — max 500 MB`, level: 'err' }]);
    return;
  }

  renderReport([{ k: 'parsing…', level: 'ok' }]);

  let fc: FC;
  let format: Format;
  let rawJson: unknown;
  // The DuckDB cold start fetches ~40 MB of WASM from JsDelivr and can take
  // 10-30s on slower connections. A static blue tick reads as "frozen", so
  // we drop in the animated inlineLoader (rotating verb + spinning ring)
  // for that phase, falling back to the plain row for other phases.
  let phaseLoader: { dismiss: () => void } | undefined;
  try {
    const parsed = await fileToFC(file, {
      onPhase: (p) => {
        phaseLoader?.dismiss();
        phaseLoader = undefined;
        if (p === 'duckdb') {
          phaseLoader = inlineLoader(reportEl, VERBS_ENGINE);
        } else if (p === 'unzipping') {
          renderReport([{ k: 'unzipping…', level: 'ok' }]);
        } else {
          renderReport([{ k: 'parsing…', level: 'ok' }]);
        }
      },
    });
    phaseLoader?.dismiss();
    fc = parsed.fc;
    format = parsed.format;
    if (format === 'geojson' || format === 'json') {
      try {
        rawJson = JSON.parse(await file.text());
      } catch {
        rawJson = undefined;
      }
    }
  } catch (e) {
    phaseLoader?.dismiss();
    renderReport([{ k: (e as Error).message, level: 'err' }]);
    return;
  }

  const r = validate(fc, rawJson);
  selectedFC = fc;
  selectedFormat = format;

  const rows = buildReport(file, r);
  renderReport(rows);

  // Render on the map regardless (even with warnings — useful to preview).
  const mapLoader = overlayLoader(document.getElementById('map')!, VERBS_VERIFY_RENDER);
  let mapDismissed = false;
  const dismissMap = () => {
    if (mapDismissed) return;
    mapDismissed = true;
    map.off('sourcedata', onSourceData);
    mapLoader.dismiss();
  };
  const onSourceData = (e: maplibregl.MapSourceDataEvent) => {
    if (e.sourceId === 'v' && e.isSourceLoaded) dismissMap();
  };
  map.on('sourcedata', onSourceData);
  setTimeout(dismissMap, 4000);
  renderOnMap(fc, r.bbox);

  if (rows.some((row) => row.level === 'err')) return;
  // Default: view-by-default. Form is gated behind the explicit Publish CTA.
  showPublishCTA();
}

// ---------- Reset back to dropzone ---------------------------------------
function resetState(): void {
  selectedFile = null;
  selectedFC = null;
  selectedFormat = null;
  turnstileToken = null;
  reportEl.innerHTML = '';
  hideForm();
  hidePublishCTA();
  viewOnlyBanner.hidden = true;
  hideSuccess();
  workspace.classList.remove('show');
  drop.style.display = '';
  fileInput.value = '';
  for (const id of ['c-fill', 'c-line', 'c-pt']) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource('v')) map.removeSource('v');
  if (turnstileWidgetId != null) {
    // @ts-expect-error global turnstile from CF script
    window.turnstile?.reset?.(turnstileWidgetId);
    turnstileToken = null;
  }
  map.fitBounds(INDIA_BBOX, { padding: 24, duration: 0 });
}

// ---------- Validation report rendering ----------------------------------
type Row = { k: string; v?: string; level: 'ok' | 'warn' | 'err' };

function buildReport(file: File, r: Report): Row[] {
  const rows: Row[] = [];
  const totalValid = r.count - r.invalid;
  const ratio = r.count > 0 ? totalValid / r.count : 0;

  rows.push({ k: file.name, v: fmtBytes(file.size), level: 'ok' });
  rows.push({
    k: `${r.count.toLocaleString()} features`,
    v: Object.entries(r.byType).map(([t, n]) => `${t} ${n}`).join(', '),
    level: 'ok',
  });

  if (r.crs && !okCRS(r.crs)) {
    rows.push({ k: `CRS ${r.crs} — must be EPSG:4326`, level: 'err' });
  } else {
    rows.push({ k: `CRS EPSG:4326`, level: 'ok' });
  }

  if (r.invalid === 0) {
    rows.push({ k: `all geometries valid`, level: 'ok' });
  } else if (ratio < 0.95) {
    rows.push({ k: `${r.invalid} / ${r.count} invalid — must be < 5%`, level: 'err' });
  } else {
    rows.push({ k: `${r.invalid} / ${r.count} invalid geometries`, level: 'warn' });
  }

  if (r.outsideIndia > 0) {
    rows.push({ k: `${r.outsideIndia} coords outside India bbox`, level: 'warn' });
  } else if (r.bbox) {
    rows.push({ k: `extent within India`, v: bboxStr(r.bbox), level: 'ok' });
  }

  return rows;
}

function okCRS(s: string): boolean {
  return /CRS84|EPSG::?4326|EPSG:4326/i.test(s);
}

function renderReport(rows: Row[]): void {
  reportEl.innerHTML = rows
    .map((r) => `<div class="row ${r.level}"><span class="k">${escapeHtml(r.k)}</span><span class="v">${escapeHtml(r.v || '')}</span></div>`)
    .join('');
}

function showForm(): void {
  form.classList.add('show');
  publishCta.classList.remove('show');
}
function hideForm(): void {
  form.classList.remove('show');
}
function showPublishCTA(): void {
  if (viewOnly) {
    // Listed file — show the "you're viewing" banner instead of the publish CTA.
    viewOnlyBanner.hidden = false;
    publishCta.classList.remove('show');
    return;
  }
  publishCta.classList.add('show');
  form.classList.remove('show');
}
function hidePublishCTA(): void { publishCta.classList.remove('show'); }
function hideSuccess(): void { successEl.classList.remove('show'); }

// Click "Publish to catalog →" → expand the form + lazy-init Turnstile.
publishOpenBtn?.addEventListener('click', () => {
  showForm();
  ensureTurnstile();
  // Surface a sensible default in the status line so users know what's gating submit.
  updateSubmitEnabled();
});

// "Cancel" in the form header → collapse back to the CTA without losing the file.
publishCancelBtn?.addEventListener('click', () => {
  hideForm();
  if (!viewOnly) publishCta.classList.add('show');
});

// ---------- Turnstile (lazy) ---------------------------------------------
function ensureTurnstile(): void {
  if (turnstileWidgetId != null) return;
  const sitekey = captchaEl.dataset.sitekey || '1x00000000000000000000AA';

  const renderWidget = () => {
    // @ts-expect-error global turnstile from CF script
    turnstileWidgetId = window.turnstile?.render(captchaEl, {
      sitekey,
      callback: (token: string) => { turnstileToken = token; updateSubmitEnabled(); },
      'expired-callback': () => { turnstileToken = null; updateSubmitEnabled(); },
      'error-callback':    () => { turnstileToken = null; updateSubmitEnabled(); },
    }) ?? null;
  };

  // @ts-expect-error
  if (window.turnstile) { renderWidget(); return; }
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.defer = true;
  script.onload = renderWidget;
  document.head.appendChild(script);
}

function updateSubmitEnabled(): void {
  // Disable strictly on the things our UI controls — the file pipeline and
  // captcha. Native HTML5 validation handles the form fields on submit
  // attempt; the previous form.checkValidity() check was unreliable in
  // some browsers (visually grey button even when fields were filled).
  const fileOk = !!(selectedFile && selectedFC && selectedFormat);
  const captchaOk = !!turnstileToken;
  submitBtn.disabled = !(fileOk && captchaOk);
  if (submitBtn.disabled) {
    statusEl.classList.remove('err');
    if (!fileOk) statusEl.textContent = 'drop a file first';
    else if (!captchaOk) statusEl.textContent = 'waiting on captcha…';
  } else {
    statusEl.textContent = '';
  }
}

form.addEventListener('input', updateSubmitEnabled);
form.addEventListener('change', updateSubmitEnabled);

// Provenance toggle — Source URL field flips between strict URL and free text.
const srcInput = document.getElementById('f-src') as HTMLInputElement;
const srcLabel = document.getElementById('src-label')!;
const srcHint = document.getElementById('src-hint')!;
const srcReq = document.getElementById('src-req')!;
function applyProvenanceMode(): void {
  const original = (form.querySelector('input[name="is_original"]:checked') as HTMLInputElement)?.value === '1';
  if (original) {
    srcLabel.textContent = 'Method';
    srcHint.textContent = 'How was this created? e.g. "Hand-digitized in QGIS, Aug 2025" — optional.';
    srcInput.type = 'text';
    srcInput.required = false;
    srcInput.placeholder = 'Hand-digitized in QGIS, GPS traces, …';
    srcReq.style.display = 'none';
  } else {
    srcLabel.textContent = 'Source URL';
    srcHint.textContent = 'The page where this data was originally published.';
    srcInput.type = 'url';
    srcInput.required = true;
    srcInput.placeholder = 'https://example.gov.in/dataset';
    srcReq.style.display = '';
  }
  updateSubmitEnabled();
}
form.querySelectorAll('input[name="is_original"]').forEach((el) =>
  el.addEventListener('change', applyProvenanceMode),
);
srcInput.addEventListener('blur', () => {
  if (srcInput.type !== 'url') return;
  const v = srcInput.value.trim();
  if (v && !/^https?:\/\//i.test(v) && /\./.test(v)) {
    srcInput.value = `https://${v}`;
    updateSubmitEnabled();
  }
});

// ---------- Submit -------------------------------------------------------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedFile || !turnstileToken) return;

  submitBtn.disabled = true;
  statusEl.classList.remove('err');
  statusEl.textContent = 'submitting…';

  const fd = new FormData(form);
  fd.set('file', selectedFile, selectedFile.name);
  fd.set('turnstile_token', turnstileToken);
  if (selectedFC && selectedFormat && selectedFormat !== 'geojson' && selectedFormat !== 'json') {
    fd.set('fc_json', new Blob([JSON.stringify(selectedFC)], { type: 'application/json' }));
    fd.set('format', selectedFormat);
  }

  let resp: Response;
  try {
    resp = await fetch('/api/submit', { method: 'POST', body: fd });
  } catch (err) {
    statusEl.classList.add('err');
    statusEl.textContent = `network error: ${(err as Error).message}`;
    submitBtn.disabled = false;
    return;
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    statusEl.classList.add('err');
    statusEl.textContent = `server returned non-JSON (${resp.status})`;
    submitBtn.disabled = false;
    return;
  }

  if (!resp.ok) {
    const err = (body as { error?: string }).error || `HTTP ${resp.status}`;
    statusEl.classList.add('err');
    statusEl.textContent = err;
    submitBtn.disabled = false;
    // @ts-expect-error reset captcha so user can re-attempt
    window.turnstile?.reset?.(turnstileWidgetId);
    turnstileToken = null;
    return;
  }

  renderSuccess(body as SuccessPayload);
});

function renderSuccess(payload: SuccessPayload): void {
  hideForm();
  workspace.classList.remove('show');
  drop.style.display = 'none';
  statusEl.textContent = '';

  const submittedName = (form.elements.namedItem('name') as HTMLInputElement | null)?.value?.trim() || payload.id;
  saveSubmission({
    id: payload.id,
    name: submittedName,
    token: payload.admin_token,
    created_at: Date.now(),
    permission: 'admin',
  });

  // Always navigate via the current origin — in dev the server returns an
  // 8788 (wrangler) URL, but the user is on 5173 (vite). location.origin
  // keeps everything on one host so the back button works.
  const shareUrl = `${location.origin}/c/${payload.id}`;
  (document.getElementById('success-url') as HTMLElement).innerHTML =
    `at <a href="${escapeHtml(shareUrl)}">${escapeHtml(shareUrl)}</a>`;
  (document.getElementById('success-token') as HTMLElement).textContent = payload.admin_token;

  const copyBtn = document.getElementById('copy-token')!;
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(payload.admin_token);
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => (copyBtn.textContent = 'Copy token'), 1800);
    } catch {
      copyBtn.textContent = 'Copy failed';
    }
  });

  document.getElementById('download-token')!.addEventListener('click', () => {
    const content =
      `geodata · submission backup\n\n` +
      `id:         ${payload.id}\n` +
      `share url:  ${payload.share_url}\n` +
      `admin url:  ${payload.admin_url}\n` +
      `admin token:${payload.admin_token}\n\n` +
      `KEEP THIS SAFE. Lose this file and you cannot edit or delete this submission.\n`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `geodata-${payload.id}-token.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  (document.getElementById('goto-submission') as HTMLAnchorElement).href = shareUrl;

  successEl.classList.add('show');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderMySubmissions();
}

// ---------- Your submissions panel ---------------------------------------
function relativeTime(then: number, now: number = Date.now()): string {
  const d = Math.max(0, now - then);
  const day = 86_400_000;
  if (d < day) return 'today';
  const days = Math.floor(d / day);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function renderMySubmissions(): void {
  const panel = document.getElementById('my-subs');
  const listEl = document.getElementById('my-subs-list');
  if (!panel || !listEl) return;
  const rows = listSubmissions();
  if (rows.length === 0) { panel.hidden = true; return; }
  panel.hidden = false;
  const now = Date.now();
  listEl.innerHTML = rows
    .map((r: StoredSubmission) =>
      `<a class="my-subs-row" href="/c/${encodeURIComponent(r.id)}">` +
        `<span class="my-subs-name">${escapeHtml(r.name)}</span>` +
        `<span class="my-subs-pill">ADMIN</span>` +
        `<span class="my-subs-when">${escapeHtml(relativeTime(r.created_at, now))}</span>` +
      `</a>`,
    )
    .join('');
}

function wirePasteBack(): void {
  const toggle = document.getElementById('paste-back-toggle');
  const form = document.getElementById('paste-back-form') as HTMLFormElement | null;
  const input = document.getElementById('paste-back-url') as HTMLInputElement | null;
  const status = document.getElementById('paste-back-status');
  if (!toggle || !form || !input || !status) return;

  toggle.addEventListener('click', () => {
    const open = form.hidden;
    form.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) input.focus();
  });

  const fail = (msg: string) => {
    status.textContent = msg;
    status.classList.add('err');
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = '';
    status.className = 'paste-back-status';
    const parsed = parseAdminUrl(input.value);
    if (!parsed.ok) return fail(parsed.reason);
    if (getSubmission(parsed.id)) return fail('this device already has this submission');

    status.textContent = 'verifying…';
    let resp: Response;
    try {
      resp = await fetch(`/api/c/${encodeURIComponent(parsed.id)}/summary`);
    } catch {
      return fail('network error — try again');
    }
    if (resp.status === 404) return fail('submission not found');
    if (!resp.ok) return fail(`server returned ${resp.status}`);

    let body: { id: string; name: string; created_at: string };
    try {
      body = await resp.json();
    } catch {
      return fail('server returned non-JSON');
    }
    saveSubmission({
      id: body.id,
      name: body.name,
      token: parsed.key,
      created_at: Date.parse(body.created_at) || Date.now(),
      permission: 'admin',
    });
    input.value = '';
    form.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    status.textContent = '';
    renderMySubmissions();
  });
}

// Best-effort: refresh stale names for the top few rows in the background.
// 404s leave the local row untouched (handled separately at /c/<id> visit time).
async function refreshSummaries(): Promise<void> {
  const rows = listSubmissions().slice(0, 10);
  if (rows.length === 0) return;
  const results = await Promise.all(rows.map(async (r) => {
    try {
      const resp = await fetch(`/api/c/${encodeURIComponent(r.id)}/summary`);
      if (!resp.ok) return false;
      const body = await resp.json() as { name?: string };
      if (body.name && body.name !== r.name) {
        saveSubmission({ ...r, name: body.name });
        return true;
      }
    } catch { /* swallow */ }
    return false;
  }));
  if (results.some(Boolean)) renderMySubmissions();
}

hydrateLegacyTokens();
renderMySubmissions();
wirePasteBack();
void refreshSummaries();

// ---------- Utils --------------------------------------------------------
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function bboxStr(b: [number, number, number, number]): string {
  return b.map((v) => v.toFixed(2)).join(', ');
}

// Re-export so future code can stash from this page too if needed.
export { stashForSubmit };
