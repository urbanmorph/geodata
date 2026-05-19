// v2 filter panel: slice a remote parquet by attribute.
// Lazy-loaded on first "Filter & export" click. DuckDB-WASM only initialises
// when the user actually picks a state — the dropdown itself is instant
// because catalog.json carries the pre-baked state list.
import { exportFilteredParquet } from './db';
import { inlineLoader, VERBS_ENGINE, VERBS_EXPORT } from './loading';
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

function toTitleCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s|&|-)([a-z])/g, (_m, p, l) => p + l.toUpperCase());
}

export function mountFilterPanel(layer: Layer, container: HTMLElement, onClose: () => void): void {
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
        <button class="filter-panel__btn" id="filter-export" disabled>Download filtered parquet</button>
      </div>
      <p class="filter-panel__hint">
        Filtering runs in your browser. Only the parquet pages matching your filter are downloaded.
      </p>
      <div class="filter-panel__status" id="filter-status" aria-live="polite"></div>
    </div>
  `;
  container.appendChild(panel);

  const stateSelect = panel.querySelector('#filter-state') as HTMLSelectElement;
  const summary = panel.querySelector('#filter-summary') as HTMLElement;
  const exportBtn = panel.querySelector('#filter-export') as HTMLButtonElement;
  const status = panel.querySelector('#filter-status') as HTMLElement;
  const closeBtn = panel.querySelector('.filter-panel__close') as HTMLButtonElement;

  closeBtn.addEventListener('click', () => {
    panel.remove();
    onClose();
  });

  const parquetUrl = layer.parquet!.url;
  let counts: Record<string, number> = {};

  // Populate the dropdown + load prebaked counts from catalog.json. Both are
  // instant: no DuckDB needed for either the list or the row counts. DuckDB
  // is deferred to the Download click, when the user has committed to wait.
  getCatalog()
    .then((c) => {
      counts = c.state_counts?.[layer.id] || {};
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
      exportBtn.disabled = true;
      return;
    }
    const n = counts[code] ?? 0;
    if (n === 0) {
      summary.innerHTML = `<span class="filter-panel__muted">No rows for this state in this layer.</span>`;
      exportBtn.disabled = true;
      return;
    }
    summary.innerHTML = `<span><strong>${n.toLocaleString('en-IN')}</strong> rows match.</span>`;
    exportBtn.disabled = false;
  });

  let engineWarm = false;

  exportBtn.addEventListener('click', async () => {
    const code = stateSelect.value;
    if (!code) return;
    const stateName =
      (stateSelect.options[stateSelect.selectedIndex]?.text || '').toLowerCase().replace(/\s+/g, '_') || `s${code}`;
    const filename = `${layer.id}__${stateName}.parquet`;
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting…';
    // First export bears the DuckDB cold start; switch verbs after engine warms.
    const exportLoader = inlineLoader(status, engineWarm ? VERBS_EXPORT : VERBS_ENGINE);
    const engineWarmTimer = !engineWarm
      ? window.setTimeout(() => exportLoader.setVerbs(VERBS_EXPORT), 8000)
      : undefined;
    try {
      const blob = await exportFilteredParquet(
        `SELECT * FROM '${parquetUrl}' WHERE ${STATE_COL} = ${Number(code)}`,
        filename.replace('.parquet', ''),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      clearTimeout(engineWarmTimer);
      exportLoader.dismiss();
      engineWarm = true;
      status.innerHTML = `<span class="filter-panel__ok">Downloaded ${escapeHtml(filename)} (${formatSize(blob.size)}).</span>`;
    } catch (e) {
      clearTimeout(engineWarmTimer);
      exportLoader.dismiss();
      status.innerHTML = `<span class="filter-panel__err">Export failed: ${escapeHtml(String((e as Error).message))}</span>`;
    } finally {
      exportBtn.textContent = 'Download filtered parquet';
      exportBtn.disabled = false;
    }
  });
}

function formatSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
