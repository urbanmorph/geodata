// Generic FilterPanel: renders one affordance per ranked column (facet chips,
// range inputs, debounced search box, boolean toggle) and maintains an
// ActiveFilter[] that drives both the in-tile MapLibre repaint and the
// DuckDB-WASM count/export queries. Single-state filters short-circuit to a
// pre-baked R2 extract when one exists.

import { inlineLoader, VERBS_ENGINE, VERBS_EXPORT, VERBS_GEOJSON, VERBS_KML, VERBS_COUNT } from './loading';
import { getCatalog, type Layer } from './catalog';
import { escapeHtml, downloadHref, triggerDownload } from './util';
import {
  usesServerFilter, FILTER_EXPORT_MAX_BYTES, FILTER_EXPORT_MAX_ROWS, FILTER_EXPORT_MAX_SHAPE_BYTES, SERVER_SHAPE_EXPORT,
} from '../../shared/large-load.mjs';
import { fmtBytes } from './format-hints';
import { dlProxyUrl } from '../../shared/downloads.mjs';
import { pickAffordance, type Affordance, type ColumnStats } from './filter-schema';
import { moveActive } from './search-pop';
import {
  buildMaplibreFilter,
  escString,
  whereClause,
  resolveStateCodes,
  typeaheadSQL,
  matchCountText,
  type ActiveFilter,
  type MaplibreFilter,
} from './filter-where';

// DuckDB-WASM (./db, ~47 kB gz) loads the first time the panel counts, suggests or
// exports: the map prefetches this module, and a layer filtered on the server never needs it.
const loadDb = () => import('./db');

type FilterLayer = Pick<Layer, 'id' | 'parquet' | 'geojson' | 'kml' | 'level' | 'source'>;

export type FilterCallbacks = {
  /** The panel's × : the map hides the panel and keeps the filter. */
  onClose: () => void;
  onActiveFiltersChange?: (filters: ActiveFilter[], mapFilter: MaplibreFilter) => void;
  /** How many features match the filter, once counted (null while counting or unknown). */
  onCount?: (matched: number | null) => void;
};

export function mountFilterPanel(
  layer: FilterLayer,
  container: HTMLElement,
  ranked: ColumnStats[],
  rowCount: number,
  callbacks: FilterCallbacks,
): void {
  // Over LARGE_FILTER_BYTES the API counts and exports; the browser never
  // opens the layer's parquet (shared/large-load.mjs).
  const server = usesServerFilter(layer);
  const firstBtn = server
    ? `<button class="filter-panel__btn filter-panel__btn--primary" data-fmt="csv" disabled>
            <span class="fmt">CSV</span><span class="muted">spreadsheets · centre point</span>
          </button>`
    : `<button class="filter-panel__btn filter-panel__btn--primary" data-fmt="parquet" disabled>
            <span class="fmt">Parquet</span><span class="muted">analytics · smallest</span>
          </button>`;
  const shapeBtns = server && !SERVER_SHAPE_EXPORT ? '' : `
          <button class="filter-panel__btn" data-fmt="geojson" disabled>
            <span class="fmt">GeoJSON</span><span class="muted">QGIS, web</span>
          </button>
          <button class="filter-panel__btn" data-fmt="kml" disabled>
            <span class="fmt">KML</span><span class="muted">Google Earth &amp; Maps</span>
          </button>`;
  const hint = server
    ? `This layer is large, so filtering runs on the bharatlas server: the count and exports (up to ${FILTER_EXPORT_MAX_ROWS.toLocaleString('en-IN')} rows) come from there.`
    : 'Filtering runs in your browser. It downloads only the parts of the file your filter needs.';
  const panel = document.createElement('aside');
  panel.className = 'filter-panel';
  panel.id = 'map-filter-panel';
  panel.innerHTML = `
    <header class="filter-panel__head">
      <span class="filter-panel__title" tabindex="-1">Filter &amp; export</span>
      <button class="filter-panel__close" aria-label="Close filter">×</button>
    </header>
    <div class="filter-panel__body">
      <div class="filter-panel__cols" id="filter-cols"></div>
      <div class="filter-panel__foot">
        <div class="filter-panel__row" id="filter-summary">
          <span class="filter-panel__muted">Pick a value above to enable export.</span>
        </div>
        <div class="filter-panel__actions">
          ${firstBtn}${shapeBtns}
        </div>
        <div class="filter-panel__status" id="filter-status" aria-live="polite"></div>
      </div>
      <p class="filter-panel__hint">${hint}</p>
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
    callbacks.onCount?.(null);
    if (!active.length) {
      summary.innerHTML = `<span class="filter-panel__muted">Pick a value above to enable export.</span>`;
      return;
    }
    summary.innerHTML = `<span class="filter-panel__muted">Counting…</span>`;
    lastPlan = null;
    countTimer = window.setTimeout(() => runRowCount(active), 300);
  }

  // A large layer's latest count and estimated export sizes, so its export
  // can refuse above the caps without asking the server again.
  let lastPlan: ExportPlan | null = null;

  /** The match count, and for a large layer its export plan. The caller keeps
   *  the plan only if this count is still the latest (a stale plan must never
   *  gate a newer filter's export). */
  async function countMatches(active: ActiveFilter[]): Promise<{ n: number; plan: ExportPlan | null }> {
    if (server) {
      const plan = await apiPlan(layer.id, active);
      return { n: plan.total, plan };
    }
    const { query } = await loadDb();
    const rows = await query<{ n: bigint | number }>(
      `SELECT COUNT(*) AS n FROM ${escString(layer.parquet!.url)} WHERE ${whereClause(active)}`,
    );
    return { n: Number(rows[0]?.n ?? 0), plan: null };
  }

  async function runRowCount(active: ActiveFilter[]) {
    if (!layer.parquet?.url) return;
    const mySeq = ++countSeq;
    const warm = engineWarm || server;
    countLoader = inlineLoader(summary, warm ? VERBS_COUNT : VERBS_ENGINE);
    const warmTimer = !warm
      ? window.setTimeout(() => countLoader?.setVerbs(VERBS_COUNT), 8000)
      : undefined;
    try {
      const { n, plan } = await countMatches(active);
      window.clearTimeout(warmTimer);
      if (mySeq !== countSeq) return;
      lastPlan = plan;
      countLoader?.dismiss();
      countLoader = undefined;
      engineWarm = true;
      summary.innerHTML = `<span><strong>${matchCountText(n, rowCount)}</strong> match.</span>`;
      callbacks.onCount?.(n);
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
    }, server ? undefined : layer.parquet?.url); // no typeahead scan for a large layer
    colsEl.appendChild(field);
  }

  closeBtn.addEventListener('click', () => callbacks.onClose());

  // Pre-baked R2 extracts manifest — used only for the state-filter fast
  // path (one IN on a state column with one value). Lazy-fetched.
  let extracts: Record<string, Record<string, { url: string; bytes: number }>> = {};
  let stateNameToCode = new Map<string, number>();
  getCatalog()
    .then((c) => {
      extracts = (layer.level ? c.extracts?.[layer.level] : undefined) || {};
      if (c.states) {
        stateNameToCode = new Map(c.states.map((s) => [s.name.toLowerCase(), s.code]));
      }
    })
    .catch(() => {});

  // Warm DuckDB-WASM in the background — masks the cold start when the
  // user clicks an export button.
  if (!server) loadDb().then((db) => db.getDb()).catch(() => {});

  /** Large layer: check the count against the cap, then let the browser
   *  stream /export straight to a file (no copy of the rows in the tab). */
  async function serverExport(fmt: ExportFmt, active: ActiveFilter[]) {
    let plan = lastPlan;
    if (!plan) {
      try {
        // Not cached: the filter may change before this answer arrives.
        plan = await apiPlan(layer.id, active);
      } catch (e) {
        status.innerHTML = `<span class="filter-panel__err">Export failed: ${escapeHtml(String((e as Error).message))}</span>`;
        return;
      }
    }
    const n = plan.total;
    const refusal = overCapMessage(n, plan.estimated_bytes[fmt], fmt, active, !!layer.geojson?.url?.endsWith('.zip'), plan.shape_bytes);
    if (refusal) {
      status.innerHTML = `<span class="filter-panel__err">${escapeHtml(refusal)}</span>`;
      return;
    }
    const filename = `${layer.id}.${fmt}`;
    downloadHref(`/api/v1/layers/${encodeURIComponent(layer.id)}/export?format=${fmt}&filter=${filterParam(active)}`, filename);
    status.innerHTML = `<span class="filter-panel__ok">Downloading ${escapeHtml(filename)} (${n.toLocaleString('en-IN')} rows) from the server.</span>`;
  }

  exportBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const active = getActiveFilters();
      if (!active.length) return;
      const fmt = btn.dataset.fmt as 'parquet' | 'geojson' | 'kml' | 'csv';

      // Pre-baked R2 fast path: skip DuckDB entirely when the user picked
      // exactly one state (single value on a known state column) and a
      // matching bake exists.
      const stateCodes = resolveStateCodes(active, stateNameToCode);
      if (stateCodes.length === 1) {
        const code = stateCodes[0];
        const bake = extracts[String(code)]?.[fmt];
        if (bake?.url) {
          const fn = `${layer.id}__state${code}.${fmt}`;
          downloadHref(dlProxyUrl(bake.url, fmt), fn);
          status.innerHTML = `<span class="filter-panel__ok">Downloaded ${escapeHtml(fn)} (${fmtBytes(bake.bytes)}, pre-baked).</span>`;
          return;
        }
      }

      if (server) {
        await serverExport(fmt as ExportFmt, active);
        return;
      }

      // Generic path: build WHERE via filter-where.ts and run DuckDB export.
      const parquetUrl = layer.parquet!.url;
      const where = whereClause(active);
      const filename = `${layer.id}.${fmt}`;
      const verbs = fmt === 'geojson' ? VERBS_GEOJSON : fmt === 'kml' ? VERBS_KML : VERBS_EXPORT;
      setExportEnabled(false);
      const loader = inlineLoader(status, engineWarm ? verbs : VERBS_ENGINE);
      const warmTimer = !engineWarm
        ? window.setTimeout(() => loader.setVerbs(verbs), 8000)
        : undefined;
      try {
        const { exportFilteredParquet, exportFilteredGeoJSON, exportFilteredKML } = await loadDb();
        let blob: Blob;
        if (fmt === 'parquet') {
          const select = `SELECT * FROM ${escString(parquetUrl)} WHERE ${where}`;
          blob = await exportFilteredParquet(select, filename.replace(/\.parquet$/, ''));
        } else if (fmt === 'geojson') {
          blob = await exportFilteredGeoJSON(parquetUrl, where);
        } else {
          blob = await exportFilteredKML(parquetUrl, where, filename);
        }
        triggerDownload(blob, filename);
        clearTimeout(warmTimer);
        loader.dismiss();
        engineWarm = true;
        countDownload(layer, fmt);
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

/** Count a filtered export against the same layer + format counter the
 *  download links use (the format's own file, so versioned keys count right).
 *  redirect:'manual' stops at the counter's 302 instead of fetching the file. */
function countDownload(layer: FilterLayer, fmt: 'parquet' | 'geojson' | 'kml' | 'csv'): void {
  if (fmt === 'csv') return; // no CSV file to count against
  const url = layer[fmt]?.url;
  if (!url) return;
  fetch(dlProxyUrl(url, fmt), { redirect: 'manual', keepalive: true }).catch(() => {});
}

// ───── Server path (layers over LARGE_FILTER_BYTES) ─────

function filterParam(active: ActiveFilter[]): string {
  return encodeURIComponent(JSON.stringify(active));
}

type ExportFmt = 'geojson' | 'kml' | 'csv';
type ExportPlan = { total: number; estimated_bytes: Record<ExportFmt, number>; shape_bytes?: number };

/** The match count and each format's estimated export size, from
 *  /api/v1/layers/{id}/export?estimate=1 (reads only the filter columns). */
async function apiPlan(layerId: string, active: ActiveFilter[]): Promise<ExportPlan> {
  const r = await fetch(`/api/v1/layers/${encodeURIComponent(layerId)}/export?estimate=1&filter=${filterParam(active)}`);
  const body = (await r.json()) as { data?: ExportPlan; error?: string };
  if (!r.ok || typeof body.data?.total !== 'number') throw new Error(body.error || `HTTP ${r.status}`);
  return body.data;
}

const MB = (n: number) => `${Math.round(n / (1024 * 1024)).toLocaleString('en-IN')} MB`;
const FMT_LABEL: Record<ExportFmt, string> = { geojson: 'GeoJSON', kml: 'KML', csv: 'CSV' };

/** Above an export cap (rows, estimated bytes, or for GeoJSON/KML the shape
 *  decoding): what to say instead of exporting, the same as the API's 400;
 *  null when the export may go ahead.
 *  A single value on one column of a layer split per state (its GeoJSON is a
 *  zip of state files) points to that zip. */
export function overCapMessage(
  n: number, bytes: number, fmt: ExportFmt, active: ActiveFilter[], perStateZips: boolean, shapeBytes = 0,
): string | null {
  const one = active.length === 1 && active[0].kind === 'in' && active[0].values.length === 1;
  const instead = perStateZips && one
    ? 'For a whole state, download the per-state zip (GeoJSON, KML or shapefile) from the layer\'s files; or narrow the filter.'
    : 'Narrow the filter, or download the whole layer from its files.';
  if (n > FILTER_EXPORT_MAX_ROWS) {
    return `${n.toLocaleString('en-IN')} match: more than one export holds (${FILTER_EXPORT_MAX_ROWS.toLocaleString('en-IN')}). ${instead}`;
  }
  if (bytes > FILTER_EXPORT_MAX_BYTES) {
    return `${n.toLocaleString('en-IN')} match, an estimated ${MB(bytes)} as ${FMT_LABEL[fmt]}: more than one export holds (${MB(FILTER_EXPORT_MAX_BYTES)}). ${instead}`;
  }
  if (fmt !== 'csv' && shapeBytes > FILTER_EXPORT_MAX_SHAPE_BYTES) {
    return `${n.toLocaleString('en-IN')} match, spread over too much of this layer to export their shapes in one go. ${instead} Or export CSV (each row with its centre point).`;
  }
  return null;
}

// ───── Per-affordance renderers ─────

function renderField(
  col: ColumnStats,
  aff: Affordance,
  onChange: (filter: ActiveFilter | null) => void,
  parquetUrl?: string,
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
  else if (aff.kind === 'search') field.appendChild(renderSearch(col, onChange, parquetUrl));
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
    chip.setAttribute('aria-pressed', 'false');
    chip.innerHTML =
      `<span class="filter-chip__v">${escapeHtml(label ?? String(v))}</span>` +
      `<span class="filter-chip__n">${n.toLocaleString('en-IN')}</span>`;
    chip.addEventListener('click', () => {
      const key = String(v);
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      setPressed(chip, selected.has(key));
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
  const make = (placeholder: string, bound: string): HTMLInputElement => {
    const i = document.createElement('input');
    i.type = 'number';
    i.placeholder = placeholder;
    i.className = 'filter-range__input';
    i.setAttribute('aria-label', `${col.name}, ${bound}`);
    return i;
  };
  const minI = make(`≥ ${aff.min}`, 'minimum');
  const maxI = make(`≤ ${aff.max}`, 'maximum');
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

let typeaheadIds = 0;

function renderSearch(
  col: ColumnStats,
  onChange: (filter: ActiveFilter | null) => void,
  parquetUrl?: string,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'filter-typeahead';
  wrap.style.position = 'relative';
  const listId = `filter-typeahead-${++typeaheadIds}`;

  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = `Search ${col.distinct.toLocaleString('en-IN')} ${col.name}…`;
  input.className = 'filter-search';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', `${col.name}, search`);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');
  wrap.appendChild(input);

  const list = document.createElement('ul');
  list.className = 'filter-typeahead__list';
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', `${col.name} suggestions`);
  wrap.appendChild(list);

  // The highlighted suggestion (arrow keys), -1 for none.
  let active = -1;
  const options = () => Array.from(list.querySelectorAll<HTMLLIElement>('[role="option"]'));
  const setList = (values: string[]) => {
    list.replaceChildren(...values.map((v, i) => {
      const li = document.createElement('li');
      li.className = 'filter-typeahead__item';
      li.id = `${listId}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.textContent = v;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(v);
      });
      return li;
    }));
    active = -1;
    input.removeAttribute('aria-activedescendant');
    input.setAttribute('aria-expanded', String(values.length > 0));
  };

  // Suggestions in flight belong to the text that asked: any change cancels them.
  let timer: number | undefined;
  let abortCtrl: AbortController | null = null;
  const cancelSuggestions = () => {
    window.clearTimeout(timer);
    abortCtrl?.abort();
  };

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'filter-typeahead__clear';
  clearBtn.textContent = '×';
  clearBtn.setAttribute('aria-label', `Clear ${col.name} search`);
  clearBtn.style.display = 'none';
  clearBtn.addEventListener('click', () => {
    cancelSuggestions();
    input.value = '';
    clearBtn.style.display = 'none';
    setList([]);
    onChange(null);
  });
  wrap.appendChild(clearBtn);

  function pick(value: string) {
    cancelSuggestions();
    input.value = value;
    clearBtn.style.display = '';
    setList([]);
    onChange({ col: col.name, kind: 'search', q: value });
  }

  input.addEventListener('input', () => {
    cancelSuggestions();
    const q = input.value.trim();
    clearBtn.style.display = q ? '' : 'none';

    if (!q) {
      setList([]);
      onChange(null);
      return;
    }

    // Fire the filter immediately for map feedback
    onChange({ col: col.name, kind: 'search', q });

    // Typeahead: query DuckDB for matching values (debounced)
    if (!parquetUrl) return;
    timer = window.setTimeout(async () => {
      // This request's own controller: a newer keystroke aborts it, so stale rows never land.
      const ctrl = (abortCtrl = new AbortController());
      try {
        const { query } = await loadDb();
        const rows = await query<{ v: string }>(typeaheadSQL(parquetUrl, col.name, q));
        if (ctrl.signal.aborted) return;
        setList(rows.map((r) => String(r.v)));
      } catch { /* query failed — degrade to plain search */ }
    }, 250);
  });

  // Arrow keys move through the suggestions, Enter picks one, Escape closes them.
  input.addEventListener('keydown', (e) => {
    const opts = options();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!opts.length) return;
      e.preventDefault();
      active = moveActive(active, e.key, opts.length);
      opts.forEach((o, i) => o.setAttribute('aria-selected', String(i === active)));
      input.setAttribute('aria-activedescendant', opts[active].id);
    } else if (e.key === 'Enter' && active >= 0 && opts[active]) {
      e.preventDefault();
      pick(opts[active].textContent ?? '');
    } else if (e.key === 'Escape' && opts.length) {
      e.stopPropagation(); // close the suggestions, not the panel
      setList([]);
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => setList([]), 200);
  });

  return wrap;
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
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      current = current === v ? null : v;
      buttons.forEach((b, i) => setPressed(b, current === (i === 0)));
      onChange(current == null ? null : { col: col.name, kind: 'bool', v: current });
    });
    buttons.push(btn);
    wrap.appendChild(btn);
  }
  return wrap;
}

// ───── Tiny utilities ─────

/** A toggle's look and its state for assistive tech, together. */
function setPressed(btn: HTMLElement, on: boolean): void {
  btn.classList.toggle('is-active', on);
  btn.setAttribute('aria-pressed', String(on));
}

