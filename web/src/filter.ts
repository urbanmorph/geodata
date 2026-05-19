// v2 filter panel: slice a remote parquet by attribute.
// Lazy-loaded on first "Filter & export" click. DuckDB-WASM only initialises
// when the user actually picks a state — the dropdown itself is instant
// because catalog.json carries the pre-baked state list.
import { exportFilteredParquet, exportFilteredGeoJSON, exportFilteredKML, getDb } from './db';
import { inlineLoader, VERBS_ENGINE, VERBS_EXPORT, VERBS_GEOJSON, VERBS_KML } from './loading';
import { getCatalog } from './catalog';
import { escapeHtml } from './util';

// All LGD parquets carry a state-code column. DuckDB folds unquoted identifiers
// to lowercase, so this matches both `state_lgd` and `State_LGD` without a
// separate schema probe (which would add a round-trip on the cold start).
const STATE_COL = 'state_lgd';

type Layer = {
  id: string;
  parquet?: { url: string } | null;
  level: string;
  source: string;
};

type FilterCallbacks = {
  onClose: () => void;
  onStateChange?: (
    code: number | null,
    bounds: [number, number, number, number] | null,
  ) => void;
};

function toTitleCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s|&|-)([a-z])/g, (_m, p, l) => p + l.toUpperCase());
}

export function mountFilterPanel(
  layer: Layer,
  container: HTMLElement,
  callbacks: FilterCallbacks | (() => void),
): void {
  // Back-compat: a bare function still works as { onClose }.
  const cb: FilterCallbacks =
    typeof callbacks === 'function' ? { onClose: callbacks } : callbacks;
  const panel = document.createElement('aside');
  panel.className = 'filter-panel';
  panel.innerHTML = `
    <header class="filter-panel__head">
      <span class="filter-panel__title">Filter &amp; export</span>
      <button class="filter-panel__close" aria-label="Close filter">×</button>
    </header>
    <div class="filter-panel__body">
      <label class="filter-panel__field">
        <span class="filter-panel__label">State</span>
        <select class="filter-panel__select" id="filter-state">
          <option value="">— loading states… —</option>
        </select>
      </label>
      <div class="filter-panel__row" id="filter-summary">
        <span class="filter-panel__muted">Pick a state to enable export.</span>
      </div>
      <div class="filter-panel__actions">
        <button class="filter-panel__btn filter-panel__btn--primary" data-fmt="parquet" disabled>
          <span class="fmt">Parquet</span><span class="muted">analytics · smallest</span>
        </button>
        <button class="filter-panel__btn" data-fmt="geojson" disabled>
          <span class="fmt">GeoJSON</span><span class="muted">QGIS, web</span>
        </button>
        <button class="filter-panel__btn" data-fmt="kml" disabled>
          <span class="fmt">KML</span><span class="muted">Google Earth & Maps</span>
        </button>
      </div>
      <p class="filter-panel__hint">
        Filtering runs in your browser. Only parquet pages matching your filter are streamed from R2.
        GeoJSON and KML are reconstructed locally, so they may be larger and slower than the parquet.
      </p>
      <div class="filter-panel__status" id="filter-status" aria-live="polite"></div>
    </div>
  `;
  container.appendChild(panel);

  const stateSelect = panel.querySelector('#filter-state') as HTMLSelectElement;
  const summary = panel.querySelector('#filter-summary') as HTMLElement;
  const exportBtns = Array.from(panel.querySelectorAll<HTMLButtonElement>('.filter-panel__btn'));
  const status = panel.querySelector('#filter-status') as HTMLElement;
  const closeBtn = panel.querySelector('.filter-panel__close') as HTMLButtonElement;
  const setExportEnabled = (on: boolean) => exportBtns.forEach((b) => (b.disabled = !on));

  closeBtn.addEventListener('click', () => {
    cb.onStateChange?.(null, null);
    panel.remove();
    cb.onClose();
  });

  const parquetUrl = layer.parquet!.url;
  let counts: Record<string, number> = {};
  let bounds: Record<string, [number, number, number, number]> = {};

  // B1: warm DuckDB-WASM in the background while the user reads the dropdown.
  // The cold start (~5-10 s) overlaps with reading time so the Download click
  // is closer to instant. Errors here surface on the first real query.
  getDb().catch(() => {});

  // Populate the dropdown + load prebaked counts from catalog.json. Both are
  // instant: no DuckDB needed for either the list or the row counts. DuckDB
  // is deferred to the Download click, when the user has committed to wait.
  getCatalog()
    .then((c) => {
      counts = c.state_counts?.[layer.id] || {};
      bounds = (c.state_bounds || {}) as Record<string, [number, number, number, number]>;
      const states = c.states || [];
      stateSelect.innerHTML =
        `<option value="">— pick a state —</option>` +
        states
          .map((s) => `<option value="${s.code}">${escapeHtml(toTitleCase(s.name))}</option>`)
          .join('');
    })
    .catch((e) => {
      summary.innerHTML = `<span class="filter-panel__err">Failed to load states: ${escapeHtml(String(e.message || e))}</span>`;
    });

  stateSelect.addEventListener('change', () => {
    const code = stateSelect.value;
    if (!code) {
      summary.innerHTML = `<span class="filter-panel__muted">Pick a state to enable export.</span>`;
      setExportEnabled(false);
      cb.onStateChange?.(null, null);
      return;
    }
    const n = counts[code] ?? 0;
    const codeN = Number(code);
    if (n === 0) {
      summary.innerHTML = `<span class="filter-panel__muted">No rows for this state in this layer.</span>`;
      setExportEnabled(false);
      cb.onStateChange?.(codeN, bounds[code] ?? null);
      return;
    }
    summary.innerHTML = `<span><strong>${n.toLocaleString('en-IN')}</strong> rows match.</span>`;
    setExportEnabled(true);
    cb.onStateChange?.(codeN, bounds[code] ?? null);
  });

  let engineWarm = false;

  exportBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = stateSelect.value;
      if (!code) return;
      const fmt = btn.dataset.fmt as 'parquet' | 'geojson' | 'kml';
      const stateName =
        (stateSelect.options[stateSelect.selectedIndex]?.text || '').toLowerCase().replace(/\s+/g, '_') ||
        `s${code}`;
      const filename = `${layer.id}__${stateName}.${fmt}`;
      const where = `${STATE_COL} = ${Number(code)}`;
      const select = `SELECT * FROM '${parquetUrl}' WHERE ${where}`;
      const formatVerbs = fmt === 'geojson' ? VERBS_GEOJSON : fmt === 'kml' ? VERBS_KML : VERBS_EXPORT;

      setExportEnabled(false);
      // First export bears the DuckDB cold start; switch verbs after engine warms.
      const loader = inlineLoader(status, engineWarm ? formatVerbs : VERBS_ENGINE);
      const warmTimer = !engineWarm
        ? window.setTimeout(() => loader.setVerbs(formatVerbs), 8000)
        : undefined;
      try {
        let blob: Blob;
        if (fmt === 'parquet') {
          blob = await exportFilteredParquet(select, filename.replace('.parquet', ''));
        } else if (fmt === 'geojson') {
          blob = await exportFilteredGeoJSON(parquetUrl, where);
        } else {
          blob = await exportFilteredKML(parquetUrl, where, filename);
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        clearTimeout(warmTimer);
        loader.dismiss();
        engineWarm = true;
        status.innerHTML = `<span class="filter-panel__ok">Downloaded ${escapeHtml(filename)} (${formatSize(blob.size)}).</span>`;
      } catch (e) {
        clearTimeout(warmTimer);
        loader.dismiss();
        status.innerHTML = `<span class="filter-panel__err">Export failed: ${escapeHtml(String((e as Error).message))}</span>`;
      } finally {
        setExportEnabled(true);
      }
    });
  });
}

function formatSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
