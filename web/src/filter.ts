// Generic FilterPanel: renders one affordance per ranked column (facet chips,
// range inputs, debounced search box, boolean toggle) and maintains an
// ActiveFilter[] that drives both the in-tile MapLibre repaint and the
// DuckDB-WASM count/export queries. Single-state filters short-circuit to a
// pre-baked R2 extract when one exists.

import {
  exportFilteredParquet,
  exportFilteredGeoJSON,
  exportFilteredKML,
  getDb,
  query,
} from './db';
import { inlineLoader, VERBS_ENGINE, VERBS_EXPORT, VERBS_GEOJSON, VERBS_KML, VERBS_COUNT } from './loading';
import { getFullCatalog } from './catalog';
import { escapeHtml } from './util';
import { fmtBytes } from './format-hints';
import { pickAffordance, type Affordance, type ColumnStats } from './filter-schema';
import {
  buildMaplibreFilter,
  buildWhereSQL,
  resolveStateCodes,
  type ActiveFilter,
  type MaplibreFilter,
} from './filter-where';

type Layer = {
  id: string;
  parquet?: { url: string } | null;
  level: string;
  source: string;
};

export type FilterCallbacks = {
  onClose: () => void;
  onActiveFiltersChange?: (filters: ActiveFilter[], mapFilter: MaplibreFilter) => void;
};

export function mountFilterPanel(
  layer: Layer,
  container: HTMLElement,
  ranked: ColumnStats[],
  rowCount: number,
  callbacks: FilterCallbacks,
): void {
  const panel = document.createElement('aside');
  panel.className = 'filter-panel';
  panel.innerHTML = `
    <header class="filter-panel__head">
      <span class="filter-panel__title">Filter &amp; export</span>
      <button class="filter-panel__close" aria-label="Close filter">×</button>
    </header>
    <div class="filter-panel__body">
      <div class="filter-panel__cols" id="filter-cols"></div>
      <div class="filter-panel__row" id="filter-summary">
        <span class="filter-panel__muted">Pick a value above to enable export.</span>
      </div>
      <div class="filter-panel__actions">
        <button class="filter-panel__btn filter-panel__btn--primary" data-fmt="parquet" disabled>
          <span class="fmt">Parquet</span><span class="muted">analytics · smallest</span>
        </button>
        <button class="filter-panel__btn" data-fmt="geojson" disabled>
          <span class="fmt">GeoJSON</span><span class="muted">QGIS, web</span>
        </button>
        <button class="filter-panel__btn" data-fmt="kml" disabled>
          <span class="fmt">KML</span><span class="muted">Google Earth &amp; Maps</span>
        </button>
      </div>
      <p class="filter-panel__hint">
        Filtering runs in your browser. Only parquet pages matching your filter are streamed from R2.
      </p>
      <div class="filter-panel__status" id="filter-status" aria-live="polite"></div>
    </div>
  `;
  container.appendChild(panel);

  const colsEl = panel.querySelector('#filter-cols') as HTMLElement;
  const summary = panel.querySelector('#filter-summary') as HTMLElement;
  const status = panel.querySelector('#filter-status') as HTMLElement;
  const exportBtns = Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-fmt]'));
  const closeBtn = panel.querySelector('.filter-panel__close') as HTMLButtonElement;
  const setExportEnabled = (on: boolean) => exportBtns.forEach((b) => (b.disabled = !on));

  // Per-column filter state; null = no filter on that column.
  const filterState = new Map<string, ActiveFilter | null>();

  function getActiveFilters(): ActiveFilter[] {
    return [...filterState.values()].filter((f): f is ActiveFilter => f != null);
  }

  // ───── Live row count (debounced) ─────
  // Tracks the latest filter state so we can ignore stale COUNT results when
  // the user clicks chips faster than DuckDB can answer. engineWarm is also
  // used by the export buttons below — first DuckDB call (count or export)
  // bears the cold start; subsequent ones reuse the warmed runtime.
  let countSeq = 0;
  let countTimer: number | undefined;
  let countLoader: ReturnType<typeof inlineLoader> | undefined;
  let engineWarm = false;

  function notifyChange() {
    const active = getActiveFilters();
    const mapFilter = buildMaplibreFilter(active);
    callbacks.onActiveFiltersChange?.(active, mapFilter);
    setExportEnabled(active.length > 0);
    window.clearTimeout(countTimer);
    countLoader?.dismiss();
    countLoader = undefined;
    if (!active.length) {
      summary.innerHTML = `<span class="filter-panel__muted">Pick a value above to enable export.</span>`;
      return;
    }
    summary.innerHTML = `<span class="filter-panel__muted">Counting…</span>`;
    countTimer = window.setTimeout(() => runRowCount(active), 300);
  }

  async function runRowCount(active: ActiveFilter[]) {
    if (!layer.parquet?.url) return;
    const mySeq = ++countSeq;
    const where = buildWhereSQL(active).replace(/^WHERE\s+/i, '');
    const sql = `SELECT COUNT(*) AS n FROM '${layer.parquet.url}' WHERE ${where}`;
    countLoader = inlineLoader(summary, engineWarm ? VERBS_COUNT : VERBS_ENGINE);
    const warmTimer = !engineWarm
      ? window.setTimeout(() => countLoader?.setVerbs(VERBS_COUNT), 8000)
      : undefined;
    try {
      const rows = await query<{ n: bigint | number }>(sql);
      window.clearTimeout(warmTimer);
      if (mySeq !== countSeq) return;
      countLoader?.dismiss();
      countLoader = undefined;
      engineWarm = true;
      const n = Number(rows[0]?.n ?? 0);
      summary.innerHTML = `<span><strong>${n.toLocaleString('en-IN')}</strong> rows match.</span>`;
    } catch (e) {
      window.clearTimeout(warmTimer);
      if (mySeq !== countSeq) return;
      countLoader?.dismiss();
      countLoader = undefined;
      summary.innerHTML = `<span class="filter-panel__muted">Filter active. (count unavailable)</span>`;
    }
  }

  for (const col of ranked) {
    const aff = pickAffordance(col, rowCount);
    if (aff.kind === 'drop') continue;
    const field = renderField(col, aff, (filter) => {
      filterState.set(col.name, filter);
      notifyChange();
    });
    colsEl.appendChild(field);
  }

  closeBtn.addEventListener('click', () => {
    callbacks.onActiveFiltersChange?.([], null);
    panel.remove();
    callbacks.onClose();
  });

  // Pre-baked R2 extracts manifest — used only for the state-filter fast
  // path (one IN on a state column with one value). Lazy-fetched.
  let extracts: Record<string, Record<string, { url: string; bytes: number }>> = {};
  let stateNameToCode = new Map<string, number>();
  getFullCatalog()
    .then((c) => {
      extracts = c.extracts?.[layer.level] || {};
      if (c.states) {
        stateNameToCode = new Map(c.states.map((s) => [s.name.toLowerCase(), s.code]));
      }
    })
    .catch(() => {});

  // Warm DuckDB-WASM in the background — masks the cold start when the
  // user clicks an export button.
  getDb().catch(() => {});

  exportBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const active = getActiveFilters();
      if (!active.length) return;
      const fmt = btn.dataset.fmt as 'parquet' | 'geojson' | 'kml';

      // Pre-baked R2 fast path: skip DuckDB entirely when the user picked
      // exactly one state (single value on a known state column) and a
      // matching bake exists.
      const stateCodes = resolveStateCodes(active, stateNameToCode);
      if (stateCodes.length === 1) {
        const code = stateCodes[0];
        const bake = extracts[String(code)]?.[fmt];
        if (bake?.url) {
          const fn = `${layer.id}__state${code}.${fmt}`;
          downloadUrl(bake.url, fn);
          status.innerHTML = `<span class="filter-panel__ok">Downloaded ${escapeHtml(fn)} (${fmtBytes(bake.bytes)}, pre-baked).</span>`;
          return;
        }
      }

      // Generic path: build WHERE via filter-where.ts and run DuckDB export.
      const parquetUrl = layer.parquet!.url;
      const whereStmt = buildWhereSQL(active);
      const where = whereStmt.replace(/^WHERE\s+/i, '');
      const filename = `${layer.id}.${fmt}`;
      const verbs = fmt === 'geojson' ? VERBS_GEOJSON : fmt === 'kml' ? VERBS_KML : VERBS_EXPORT;
      setExportEnabled(false);
      const loader = inlineLoader(status, engineWarm ? verbs : VERBS_ENGINE);
      const warmTimer = !engineWarm
        ? window.setTimeout(() => loader.setVerbs(verbs), 8000)
        : undefined;
      try {
        let blob: Blob;
        if (fmt === 'parquet') {
          const select = `SELECT * FROM '${parquetUrl}' WHERE ${where}`;
          blob = await exportFilteredParquet(select, filename.replace(/\.parquet$/, ''));
        } else if (fmt === 'geojson') {
          blob = await exportFilteredGeoJSON(parquetUrl, where);
        } else {
          blob = await exportFilteredKML(parquetUrl, where, filename);
        }
        downloadBlob(blob, filename);
        clearTimeout(warmTimer);
        loader.dismiss();
        engineWarm = true;
        // Count the filtered export against the same layer + format
        // counter that catalog-card downloads use. The parquetUrl is the
        // raw R2 URL; strip the domain to get the R2 key, swap the
        // extension to the exported format, and fire-and-forget a GET to
        // /api/dl/ so the Pages Function increments D1.
        const countKey = parquetUrl.replace(/^https?:\/\/[^/]+\//, '').replace(/\.parquet$/, `.${fmt}`);
        fetch(`/api/dl/${countKey}`, { keepalive: true }).catch(() => {});
        status.innerHTML = `<span class="filter-panel__ok">Downloaded ${escapeHtml(filename)} (${fmtBytes(blob.size)}).</span>`;
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

// ───── Per-affordance renderers ─────

function renderField(
  col: ColumnStats,
  aff: Affordance,
  onChange: (filter: ActiveFilter | null) => void,
): HTMLElement {
  const field = document.createElement('div');
  field.className = 'filter-panel__field';
  field.dataset.col = col.name;
  field.dataset.kind = aff.kind;

  const label = document.createElement('span');
  label.className = 'filter-panel__label';
  label.textContent = col.name;
  field.appendChild(label);

  if (aff.kind === 'facet') field.appendChild(renderFacet(col, aff, onChange));
  else if (aff.kind === 'range') field.appendChild(renderRange(col, aff, onChange));
  else if (aff.kind === 'searchable' || aff.kind === 'search') field.appendChild(renderSearch(col, onChange));
  else if (aff.kind === 'boolean') field.appendChild(renderBoolean(col, onChange));
  return field;
}

function renderFacet(
  col: ColumnStats,
  aff: Extract<Affordance, { kind: 'facet' }>,
  onChange: (filter: ActiveFilter | null) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'filter-chips';
  const selected = new Set<string>();
  for (const { v, n, label } of aff.values) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'filter-chip';
    chip.dataset.value = String(v);
    chip.innerHTML =
      `<span class="filter-chip__v">${escapeHtml(label ?? String(v))}</span>` +
      `<span class="filter-chip__n">${n.toLocaleString('en-IN')}</span>`;
    chip.addEventListener('click', () => {
      const key = String(v);
      if (selected.has(key)) {
        selected.delete(key);
        chip.classList.remove('is-active');
      } else {
        selected.add(key);
        chip.classList.add('is-active');
      }
      const values = aff.values.map((x) => x.v).filter((x) => selected.has(String(x)));
      onChange(values.length ? { col: col.name, kind: 'in', values } : null);
    });
    wrap.appendChild(chip);
  }
  return wrap;
}

function renderRange(
  col: ColumnStats,
  aff: Extract<Affordance, { kind: 'range' }>,
  onChange: (filter: ActiveFilter | null) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'filter-range';
  const make = (placeholder: string): HTMLInputElement => {
    const i = document.createElement('input');
    i.type = 'number';
    i.placeholder = placeholder;
    i.className = 'filter-range__input';
    return i;
  };
  const minI = make(`≥ ${aff.min}`);
  const maxI = make(`≤ ${aff.max}`);
  const sep = document.createElement('span');
  sep.className = 'filter-range__sep';
  sep.textContent = ' – ';
  const update = () => {
    const min = minI.value === '' ? undefined : Number(minI.value);
    const max = maxI.value === '' ? undefined : Number(maxI.value);
    if (min == null && max == null) onChange(null);
    else onChange({ col: col.name, kind: 'range', min, max });
  };
  minI.addEventListener('input', update);
  maxI.addEventListener('input', update);
  wrap.appendChild(minI);
  wrap.appendChild(sep);
  wrap.appendChild(maxI);
  return wrap;
}

function renderSearch(
  col: ColumnStats,
  onChange: (filter: ActiveFilter | null) => void,
): HTMLElement {
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = `Search ${col.distinct.toLocaleString('en-IN')} ${col.name}…`;
  input.className = 'filter-search';
  let timer: number | undefined;
  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const q = input.value.trim();
      onChange(q ? { col: col.name, kind: 'search', q } : null);
    }, 300);
  });
  return input;
}

function renderBoolean(
  col: ColumnStats,
  onChange: (filter: ActiveFilter | null) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'filter-bool';
  let current: boolean | null = null;
  const buttons: HTMLButtonElement[] = [];
  for (const [label, v] of [['Yes', true], ['No', false]] as Array<[string, boolean]>) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.className = 'filter-bool__btn';
    btn.addEventListener('click', () => {
      if (current === v) {
        current = null;
        btn.classList.remove('is-active');
        onChange(null);
      } else {
        current = v;
        buttons.forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        onChange({ col: col.name, kind: 'bool', v });
      }
    });
    buttons.push(btn);
    wrap.appendChild(btn);
  }
  return wrap;
}

// ───── Tiny utilities ─────

function downloadUrl(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
