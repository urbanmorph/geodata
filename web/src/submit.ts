// /submit — drag-drop a GeoJSON, validate in-browser, fill metadata,
// solve Turnstile, POST multipart to /api/submit, show admin token once.

import { validate, type FC, type Report } from './validate';
import { fileToFC, type Format } from './parse-geo';

type SuccessPayload = {
  id: string;
  share_url: string;
  admin_url: string;
  admin_token: string;
  expires_at: string | null;
  report: Record<string, { ok: boolean; warn?: boolean; reason?: string; info?: Record<string, unknown> }>;
};

const drop = document.getElementById('drop') as HTMLLabelElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const reportEl = document.getElementById('report')!;
const form = document.getElementById('meta') as HTMLFormElement;
const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement;
const statusEl = document.getElementById('submit-status')!;
const successEl = document.getElementById('success')!;
const captchaEl = document.getElementById('captcha') as HTMLDivElement;

let selectedFile: File | null = null;
let selectedFC: FC | null = null;
let selectedFormat: Format | null = null;
let turnstileToken: string | null = null;
let turnstileWidgetId: string | number | null = null;

// ---------- drop / pick ----------
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

// ---------- validate locally ----------
async function handleFile(file: File): Promise<void> {
  selectedFile = file;
  selectedFC = null;
  selectedFormat = null;
  hideForm();
  hideSuccess();

  if (file.size > 500 * 1024 * 1024) {
    renderReport([{ k: `file is ${fmtBytes(file.size)} — max 500 MB`, level: 'err' }]);
    return;
  }

  renderReport([{ k: 'parsing…', level: 'ok' }]);

  let fc: FC;
  let format: Format;
  let rawJson: unknown;
  try {
    const parsed = await fileToFC(file, {
      onPhase: (p) => {
        const label = p === 'unzipping' ? 'unzipping…' : p === 'duckdb' ? 'loading DuckDB…' : 'parsing…';
        renderReport([{ k: label, level: 'ok' }]);
      },
    });
    fc = parsed.fc;
    format = parsed.format;
    // Capture raw JSON for CRS detection — only meaningful for GeoJSON.
    if (format === 'geojson' || format === 'json') {
      try {
        rawJson = JSON.parse(await file.text());
      } catch {
        rawJson = undefined;
      }
    }
  } catch (e) {
    renderReport([{ k: (e as Error).message, level: 'err' }]);
    return;
  }

  const r = validate(fc, rawJson);
  selectedFC = fc;
  selectedFormat = format;

  const rows = buildReport(file, r);
  renderReport(rows);

  if (rows.some((row) => row.level === 'err')) return;

  showForm();
  ensureTurnstile();
}

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
  reportEl.classList.add('show');
  reportEl.innerHTML = rows
    .map((r) => `<div class="row ${r.level}"><span class="k">${esc(r.k)}</span><span class="v">${esc(r.v || '')}</span></div>`)
    .join('');
}

function showForm(): void {
  form.classList.add('show');
}
function hideForm(): void {
  form.classList.remove('show');
}
function hideSuccess(): void {
  successEl.classList.remove('show');
}

// ---------- Turnstile (lazy) ----------
function ensureTurnstile(): void {
  if (turnstileWidgetId != null) return;
  const sitekey = captchaEl.dataset.sitekey || '1x00000000000000000000AA';

  const renderWidget = () => {
    // @ts-expect-error global turnstile from CF script
    turnstileWidgetId = window.turnstile?.render(captchaEl, {
      sitekey,
      callback: (token: string) => {
        turnstileToken = token;
        updateSubmitEnabled();
      },
      'expired-callback': () => {
        turnstileToken = null;
        updateSubmitEnabled();
      },
      'error-callback': () => {
        turnstileToken = null;
        updateSubmitEnabled();
      },
    }) ?? null;
  };

  // @ts-expect-error
  if (window.turnstile) {
    renderWidget();
    return;
  }

  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.defer = true;
  script.onload = renderWidget;
  document.head.appendChild(script);
}

function updateSubmitEnabled(): void {
  const fileOk = !!(selectedFile && selectedFC && selectedFormat);
  const captchaOk = !!turnstileToken;
  const formOk = form.checkValidity();
  submitBtn.disabled = !(fileOk && captchaOk && formOk);
  // Surface the reason inline so users aren't guessing why submit is grey.
  if (submitBtn.disabled) {
    statusEl.classList.remove('err');
    if (!fileOk) statusEl.textContent = 'drop a file above first';
    else if (!formOk) statusEl.textContent = 'fill in the required fields (marked *)';
    else if (!captchaOk) statusEl.textContent = 'waiting on captcha…';
  } else {
    statusEl.textContent = '';
  }
}

form.addEventListener('input', updateSubmitEnabled);
form.addEventListener('change', updateSubmitEnabled);

// Normalize the source URL: people type "example.com" or "www.example.com";
// HTML5 type=url demands a protocol. Prepend https:// on blur so the form
// becomes valid without lecturing the user.
const sourceUrlEl = document.getElementById('f-src') as HTMLInputElement;
sourceUrlEl.addEventListener('blur', () => {
  const v = sourceUrlEl.value.trim();
  if (v && !/^https?:\/\//i.test(v) && /\./.test(v)) {
    sourceUrlEl.value = `https://${v}`;
    updateSubmitEnabled();
  }
});

// ---------- submit ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedFile || !turnstileToken) return;

  submitBtn.disabled = true;
  statusEl.classList.remove('err');
  statusEl.textContent = 'submitting…';

  const fd = new FormData(form);
  fd.set('file', selectedFile, selectedFile.name);
  fd.set('turnstile_token', turnstileToken);
  // For non-GeoJSON formats (KML / KMZ / Parquet) the server can't easily
  // re-parse, so we ship the client-parsed FeatureCollection alongside.
  // Server still hashes the raw bytes for storage + dedupe.
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
    // reset captcha so user can re-attempt
    // @ts-expect-error
    window.turnstile?.reset?.(turnstileWidgetId);
    turnstileToken = null;
    return;
  }

  renderSuccess(body as SuccessPayload);
});

function renderSuccess(payload: SuccessPayload): void {
  hideForm();
  reportEl.classList.remove('show');
  drop.style.display = 'none';
  statusEl.textContent = '';

  // Persist admin token to localStorage (so /c/[id] shows edit controls).
  try {
    localStorage.setItem(`geodata:tokens:${payload.id}`, payload.admin_token);
  } catch {
    // private mode / quota — non-fatal
  }

  (document.getElementById('success-url') as HTMLElement).innerHTML =
    `at <a href="${esc(payload.share_url)}">${esc(payload.share_url)}</a>`;
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
      `geodata · submission backup\n` +
      `\n` +
      `id:         ${payload.id}\n` +
      `share url:  ${payload.share_url}\n` +
      `admin url:  ${payload.admin_url}\n` +
      `admin token:${payload.admin_token}\n` +
      `\n` +
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

  (document.getElementById('goto-submission') as HTMLAnchorElement).href = payload.share_url;

  successEl.classList.add('show');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- utils ----------
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function bboxStr(b: [number, number, number, number]): string {
  return b.map((v) => v.toFixed(2)).join(', ');
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

