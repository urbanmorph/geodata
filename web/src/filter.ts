// v2 filter panel: slice a remote parquet by attribute (state today; district next).
// Lazy-loaded on first "Filter & export" click — DuckDB-WASM only initialises here.
import { query, exportFilteredParquet, schemaOf } from './db';

type Layer = {
  id: string;
  parquet?: { url: string } | null;
  level: string;
  source: string;
};

type State = { code: number; name: string };

// The states parquet URL — fixed reference, populates the dropdown for every filterable layer.
const STATES_PARQUET = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/admin/states/LGD_States.parquet';

let stateListCache: Promise<State[]> | null = null;
function getStates(): Promise<State[]> {
  if (stateListCache) return stateListCache;
  stateListCache = query<{ State_LGD: number; stname: string }>(
    `SELECT State_LGD, stname FROM '${STATES_PARQUET}' WHERE State_LGD IS NOT NULL ORDER BY stname`,
  ).then((rows) => rows.map((r) => ({ code: r.State_LGD, name: r.stname })));
  return stateListCache;
}

/** Whether a layer can be filtered. Only LGD parquet layers carry the code chain. */
export function isFilterable(layer: Layer): boolean {
  return !!layer.parquet?.url && layer.source === 'LGD';
}

/** Detect the state column name (parquets use both `State_LGD` and `state_lgd`). */
function pickColumn(cols: Array<{ name: string }>, candidates: string[]): string | null {
  for (const c of cols) {
    if (candidates.some((cand) => cand.toLowerCase() === c.name.toLowerCase())) return c.name;
  }
  return null;
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

  let stateColumn: string | null = null;
  let stateCount = 0;
  const parquetUrl = layer.parquet!.url;

  // Probe schema + populate states in parallel.
  Promise.all([schemaOf(parquetUrl), getStates()])
    .then(([cols, states]) => {
      stateColumn = pickColumn(cols, ['state_lgd', 'State_LGD']);
      if (!stateColumn) {
        summary.innerHTML = `<span class="filter-panel__err">This layer has no state code column — filtering not available.</span>`;
        return;
      }
      stateSelect.innerHTML =
        `<option value="">All states (${states.length})</option>` +
        states.map((s) => `<option value="${s.code}">${escapeHtml(s.name)}</option>`).join('');
    })
    .catch((e) => {
      summary.innerHTML = `<span class="filter-panel__err">Failed to load: ${escapeHtml(String(e.message || e))}</span>`;
    });

  stateSelect.addEventListener('change', async () => {
    const code = stateSelect.value;
    if (!code) {
      summary.innerHTML = `<span class="filter-panel__muted">Pick a state to enable export.</span>`;
      exportBtn.disabled = true;
      return;
    }
    summary.innerHTML = `<span class="filter-panel__muted">Counting rows…</span>`;
    exportBtn.disabled = true;
    try {
      const rows = await query<{ n: number }>(
        `SELECT COUNT(*)::INTEGER AS n FROM '${parquetUrl}' WHERE ${stateColumn} = ${Number(code)}`,
      );
      stateCount = Number(rows[0]?.n ?? 0);
      summary.innerHTML = `<span><strong>${stateCount.toLocaleString('en-IN')}</strong> rows match.</span>`;
      exportBtn.disabled = stateCount === 0;
    } catch (e) {
      summary.innerHTML = `<span class="filter-panel__err">Query failed: ${escapeHtml(String((e as Error).message))}</span>`;
    }
  });

  exportBtn.addEventListener('click', async () => {
    const code = stateSelect.value;
    if (!code) return;
    const stateName =
      (stateSelect.options[stateSelect.selectedIndex]?.text || '').toLowerCase().replace(/\s+/g, '_') || `s${code}`;
    const filename = `${layer.id}__${stateName}.parquet`;
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting…';
    status.textContent = 'Streaming parquet pages from R2…';
    try {
      const blob = await exportFilteredParquet(
        `SELECT * FROM '${parquetUrl}' WHERE ${stateColumn} = ${Number(code)}`,
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
      status.innerHTML = `<span class="filter-panel__ok">Downloaded ${filename} (${formatSize(blob.size)}).</span>`;
      exportBtn.textContent = 'Download filtered parquet';
      exportBtn.disabled = false;
    } catch (e) {
      status.innerHTML = `<span class="filter-panel__err">Export failed: ${escapeHtml(String((e as Error).message))}</span>`;
      exportBtn.textContent = 'Download filtered parquet';
      exportBtn.disabled = false;
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function formatSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
