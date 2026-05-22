// Lazy-loaded map renderer. Imports MapLibre + PMTiles only when the user clicks "view".
import maplibregl, { Map as MlMap } from 'maplibre-gl';
import { Protocol, PMTiles } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { overlayLoader, VERBS_MAP } from './loading';
import { getCatalog, getFullCatalog } from './catalog';
import { escapeHtml } from './util';
import { availableDownloads, fmtBytes } from './format-hints';
import { BASEMAPS, getStoredBasemap, setStoredBasemap, type BasemapId } from './basemaps';
import { embedIframeHtml } from './embed-snippet';
import { imageFilename, dataUrlToBlob, triggerDownload } from './image-export';

type Layer = {
  id: string;
  level: string;
  source: string;
  rows: number | null;
  parquet?: { url: string; bytes: number } | null;
  pmtiles?: { url: string; bytes: number } | null;
  geojson?: { url: string; bytes: number } | null;
  notes?: string;
};

let map: MlMap | null = null;
let filterAbort: AbortController | null = null;

// Register the pmtiles:// protocol with MapLibre. Idempotent.
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

// Pre-registered PMTiles archives — lets MapLibre share the parsed header.
const archives = new Map<string, PMTiles>();
function getArchive(url: string): PMTiles {
  let a = archives.get(url);
  if (!a) {
    a = new PMTiles(url);
    protocol.add(a);
    archives.set(url, a);
  }
  return a;
}

// All registered basemaps are added as raster sources at style-init time;
// visibility is toggled per the user's choice. Overlay layers sit on top and
// are never touched by basemap swaps.
function buildBaseStyle(active: BasemapId): maplibregl.StyleSpecification {
  const sources: Record<string, maplibregl.RasterSourceSpecification> = {};
  const layers: maplibregl.LayerSpecification[] = [];
  for (const b of BASEMAPS) {
    sources[b.id] = b.source;
    layers.push({
      id: b.id,
      type: 'raster',
      source: b.id,
      layout: { visibility: b.id === active ? 'visible' : 'none' },
    });
  }
  return { version: 8, sources, layers };
}

let activeBasemap: BasemapId = 'osm';
function setBasemap(id: BasemapId): void {
  if (!map) return;
  for (const b of BASEMAPS) {
    if (map.getLayer(b.id)) {
      map.setLayoutProperty(b.id, 'visibility', b.id === id ? 'visible' : 'none');
    }
  }
  activeBasemap = id;
  setStoredBasemap(id);
}

const INDIA_BOUNDS: [number, number, number, number] = [68, 6, 98, 38];

export async function openLayer(layerId: string, opts: { titleEl: HTMLElement }) {
  const cat = (await getCatalog()) as { layers?: Layer[] };
  const layer = cat.layers?.find((l) => l.id === layerId);
  if (!layer) {
    opts.titleEl.textContent = `unknown layer: ${layerId}`;
    return;
  }
  opts.titleEl.textContent = `${layer.level} · ${layer.source} · ${layer.rows?.toLocaleString('en-IN') ?? '—'} rows`;

  // Filter wiring runs in the background — stats fetch + rank shouldn't
  // block the map's first paint. Worst case, the Filter & export button
  // appears a moment after the map renders.
  wireFilterButton(layer).catch((e) => console.warn('wireFilterButton failed', e));
  wireDownloadButton(layer);
  wireBasemapButton();

  const container = document.getElementById('map')!;
  container.innerHTML = '';
  if (map) {
    map.remove();
    map = null;
  }
  const loader = overlayLoader(container, VERBS_MAP);
  activeBasemap = getStoredBasemap();
  map = new maplibregl.Map({
    container,
    style: buildBaseStyle(activeBasemap),
    bounds: INDIA_BOUNDS,
    fitBoundsOptions: { padding: 20 },
    attributionControl: { compact: true },
    // Required so map.getCanvas().toDataURL() returns pixels for the
    // "Export image (PNG)" menu entry. Tiny perf cost; acceptable here.
    preserveDrawingBuffer: true,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));
  map.once('idle', () => loader.dismiss());

  map.on('load', () => {
    attachData(layer).catch((e) => {
      console.error('attachData failed', e);
      const c = document.getElementById('map')!;
      const err = document.createElement('div');
      err.id = 'map-loading';
      err.textContent = `failed to load layer: ${(e as Error).message}`;
      c.appendChild(err);
    });
  });
}

async function attachData(layer: Layer) {
  if (!map) return;

  if (layer.pmtiles?.url) {
    const archive = getArchive(layer.pmtiles.url);
    const [header, metadata] = await Promise.all([archive.getHeader(), archive.getMetadata()]);
    const vlayers = (metadata as { vector_layers?: Array<{ id: string }> }).vector_layers || [];
    if (!vlayers.length) throw new Error('pmtiles has no vector_layers');
    const sourceLayer = vlayers[0].id;

    map.addSource('layer', {
      type: 'vector',
      url: `pmtiles://${layer.pmtiles.url}`,
      attribution: layer.source,
      minzoom: header.minZoom,
      maxzoom: header.maxZoom,
    });
    map.fitBounds([
      [header.minLon, header.minLat],
      [header.maxLon, header.maxLat],
    ], { padding: 20, duration: 0 });
    addFillLayers('layer', sourceLayer);
  } else if (layer.geojson?.url) {
    map.addSource('layer', { type: 'geojson', data: layer.geojson.url, attribution: layer.source });
    addFillLayers('layer');
  } else {
    throw new Error('no renderable source for ' + layer.id);
  }
}

function addFillLayers(sourceId: string, sourceLayer?: string) {
  if (!map) return;
  const common = sourceLayer ? { 'source-layer': sourceLayer } : {};
  map.addLayer({
    id: 'fill',
    type: 'fill',
    source: sourceId,
    ...common,
    paint: {
      'fill-color': '#0a58ca',
      'fill-opacity': 0.22,
    },
  });
  map.addLayer({
    id: 'line',
    type: 'line',
    source: sourceId,
    ...common,
    paint: {
      'line-color': '#0a58ca',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 10, 1.2],
      'line-opacity': 0.85,
    },
  });

  // One popup with one look — fed by hover on pointer devices and by tap on
  // touch devices. Tap-on-feature shows it, tap-elsewhere (or tap a different
  // feature) swaps/dismisses. Same code path; no separate sticky variant.
  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: '320px',
    className: 'geo-popup',
  });
  function buildRows(props: Record<string, unknown> | null | undefined): string {
    return Object.entries(props || {})
      .filter(([k, v]) => !k.startsWith('_') && v != null && v !== '')
      .slice(0, 10)
      .map(
        ([k, v]) =>
          `<div class="geo-popup__row"><span class="geo-popup__k">${escapeHtml(k)}</span><span class="geo-popup__v">${escapeHtml(String(v))}</span></div>`
      )
      .join('');
  }

  let popupId: string | number | undefined;
  const showPopup = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
    const f = e.features?.[0];
    if (!f) return;
    const fid = (f.id as string | number | undefined) ?? f.properties?.OBJECTID ?? f.properties?.vil_lgd;
    if (fid !== popupId) {
      popup.setHTML(buildRows(f.properties));
      popupId = fid;
    }
    popup.setLngLat(e.lngLat).addTo(map!);
  };
  map.on('mousemove', 'fill', (e) => {
    map!.getCanvas().style.cursor = 'pointer';
    showPopup(e);
  });
  map.on('mouseleave', 'fill', () => {
    map!.getCanvas().style.cursor = '';
    popup.remove();
    popupId = undefined;
  });
  // Touch / no-hover devices: tap a feature to show its details. Tapping
  // empty map or a different feature swaps/clears it.
  map.on('click', 'fill', showPopup);
  map.on('click', (e) => {
    // Empty-map tap (no features at click point) dismisses the popup.
    const hit = map!.queryRenderedFeatures(e.point, { layers: ['fill'] });
    if (!hit.length) {
      popup.remove();
      popupId = undefined;
    }
  });
}

export function closeLayer() {
  if (map) {
    map.remove();
    map = null;
  }
  filterAbort?.abort();
  filterAbort = null;
  const btn = document.getElementById('map-filter') as HTMLButtonElement | null;
  if (btn) btn.classList.remove('shown');
  document.querySelector('.filter-panel')?.remove();
  // Close any open header popovers so reopening a layer starts fresh.
  for (const p of document.querySelectorAll('.map-popover.open')) p.classList.remove('open');
}

// Single popover-toggle helper shared by Download + Basemap. Click-outside
// closes; opening one auto-closes the other.
function bindPopover(btn: HTMLButtonElement, popover: HTMLElement): void {
  const close = () => {
    popover.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    for (const p of document.querySelectorAll('.map-popover.open')) p.classList.remove('open');
    popover.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    popover.classList.contains('open') ? close() : open();
  };
  popover.onclick = (e) => e.stopPropagation();
  document.addEventListener('click', close, { passive: true });
}

function wireDownloadButton(layer: Layer): void {
  const btn = document.getElementById('map-download') as HTMLButtonElement | null;
  const popover = document.getElementById('map-download-popover');
  if (!btn || !popover) return;
  const downloads = availableDownloads(layer);
  btn.classList.add('shown');
  popover.innerHTML =
    (downloads.length
      ? `<div class="map-popover__title">Download whole layer</div>` +
        downloads
          .map(
            (d) =>
              `<a class="map-popover__item" href="${escapeHtml(d.url)}" download>
                <span class="map-popover__fmt">${escapeHtml(d.label)}</span>
                <span class="map-popover__size">${escapeHtml(fmtBytes(d.bytes))}</span>
                <span class="map-popover__hint">${escapeHtml(d.hint)}</span>
              </a>`,
          )
          .join('') +
        `<div class="map-popover__foot">Need a slice? Use <strong>Filter &amp; export</strong> for state-scoped GeoJSON &amp; KML.</div>`
      : '') +
    `<div class="map-popover__title">Share this view</div>` +
    `<button class="map-popover__item map-popover__item--btn" data-action="copy-embed">
      <span class="map-popover__fmt">Copy embed code</span>
      <span class="map-popover__hint">paste into a blog post or report</span>
    </button>` +
    `<button class="map-popover__item map-popover__item--btn" data-action="export-png">
      <span class="map-popover__fmt">Export image (PNG)</span>
      <span class="map-popover__hint">current viewport, your active base map</span>
    </button>`;
  const copyBtn = popover.querySelector<HTMLButtonElement>('[data-action="copy-embed"]');
  const exportBtn = popover.querySelector<HTMLButtonElement>('[data-action="export-png"]');
  copyBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const snippet = embedIframeHtml(layer.id, location.origin);
    try {
      await navigator.clipboard.writeText(snippet);
      const fmt = copyBtn.querySelector<HTMLElement>('.map-popover__fmt');
      if (fmt) {
        const original = fmt.textContent;
        fmt.textContent = '✓ Copied';
        setTimeout(() => { if (original) fmt.textContent = original; }, 1400);
      }
    } catch {
      // Clipboard may be blocked (insecure context); fall back to a prompt.
      prompt('Copy this iframe snippet:', snippet);
    }
  });
  exportBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!map) return;
    // preserveDrawingBuffer: true on init means the canvas is always
    // readable; no need to triggerRepaint or wait for a 'render' event.
    try {
      const url = map.getCanvas().toDataURL('image/png');
      triggerDownload(dataUrlToBlob(url), imageFilename(layer.id));
    } catch (err) {
      console.error('PNG export failed', err);
    }
  });
  bindPopover(btn, popover);
}

function wireBasemapButton(): void {
  const btn = document.getElementById('map-basemap') as HTMLButtonElement | null;
  const popover = document.getElementById('map-basemap-popover');
  if (!btn || !popover) return;
  btn.classList.add('shown');
  const render = () => {
    popover.innerHTML =
      `<div class="map-popover__title">Base map</div>` +
      BASEMAPS.map(
        (b) =>
          `<button class="map-popover__item map-popover__item--btn${
            b.id === activeBasemap ? ' is-active' : ''
          }" data-basemap="${b.id}">
            <span class="map-popover__fmt">${escapeHtml(b.name)}</span>
            <span class="map-popover__hint">${escapeHtml(b.hint)}</span>
          </button>`,
      ).join('');
    for (const el of popover.querySelectorAll<HTMLButtonElement>('[data-basemap]')) {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.basemap as BasemapId;
        setBasemap(id);
        render();
      });
    }
  };
  render();
  bindPopover(btn, popover);
}

async function wireFilterButton(layer: Layer) {
  const btn = document.getElementById('map-filter') as HTMLButtonElement | null;
  if (!btn) return;
  filterAbort?.abort();
  filterAbort = new AbortController();
  const signal = filterAbort.signal;

  btn.classList.remove('shown');
  document.querySelector('.filter-panel')?.remove();
  if (!layer.parquet?.url) return;

  // Load column stats — baked first (most curated layers), live probe otherwise
  // (opencity wards + geoBoundaries + future community uploads).
  const { rankColumns } = await import('./filter-schema');
  const fullCat = await getFullCatalog();
  const baked = fullCat.filter_stats?.[layer.id];

  let columns: import('./filter-schema').ColumnStats[];
  let rowCount: number;
  if (baked) {
    rowCount = baked.row_count;
    columns = baked.columns.map((c) => ({
      name: c.name,
      type: c.type,
      distinct: c.distinct,
      nullFrac: c.null_frac,
      min: c.min,
      max: c.max,
      topValues: c.top_values,
    }));
  } else {
    try {
      const { describeParquet } = await import('./filter-probe');
      if (signal.aborted) return;
      const probe = await describeParquet(layer.parquet.url);
      rowCount = probe.rowCount;
      columns = probe.columns;
    } catch (e) {
      console.warn('filter-probe failed for', layer.id, e);
      return;
    }
  }
  if (signal.aborted) return;

  // Decorate state_lgd top_values with state names so the chips read e.g.
  // "Karnataka" instead of "29". Filter value stays the numeric code so
  // the export pipeline keeps working.
  if (fullCat.states?.length) {
    const names = new Map(fullCat.states.map((s) => [String(s.code), s.name]));
    for (const col of columns) {
      if (/^state_lgd$/i.test(col.name) && col.topValues) {
        col.topValues = col.topValues.map((tv) => {
          const label = names.get(String(tv.v));
          return label ? { ...tv, label } : tv;
        });
      }
    }
  }

  const ranked = rankColumns(columns, rowCount);
  if (!ranked.length) return;

  btn.classList.add('shown');
  btn.textContent = 'Filter & export';
  btn.disabled = false;

  const idle: (cb: () => void) => void =
    'requestIdleCallback' in window
      ? (cb) => (window as unknown as { requestIdleCallback: (c: () => void, o: { timeout: number }) => void }).requestIdleCallback(cb, { timeout: 4000 })
      : (cb) => setTimeout(cb, 1500);
  idle(() => import('./filter'));

  btn.addEventListener(
    'click',
    async () => {
      if (document.querySelector('.filter-panel')) return;
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        const { mountFilterPanel } = await import('./filter');
        if (signal.aborted) return;
        mountFilterPanel(layer, document.getElementById('map')!, ranked, rowCount, {
          onClose: () => {
            btn.disabled = false;
            btn.textContent = 'Filter & export';
            applyActiveFilters([], null);
          },
          onActiveFiltersChange: (filters, mapFilter) => {
            applyActiveFilters(filters, mapFilter, fullCat);
          },
        });
      } catch (e) {
        console.error('filter panel failed to load', e);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Filter & export';
      }
    },
    { signal },
  );
}

// Read the filter panel's bounding box and produce a fitBounds padding
// object so the map fits inside the *uncovered* portion of the viewport.
function panelAwarePadding(): { top: number; bottom: number; left: number; right: number } {
  const base = 20;
  const panel = document.querySelector<HTMLElement>('.filter-panel');
  if (!panel) return { top: base, bottom: base, left: base, right: base };
  const r = panel.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Bottom sheet: panel is at the bottom and spans most of the viewport width.
  if (r.bottom >= vh - 1 && r.width >= vw * 0.7) {
    return { top: base, bottom: base + r.height, left: base, right: base };
  }
  // Default: right rail.
  return { top: base, bottom: base, left: base, right: base + r.width };
}

// Apply the active filter set to the map's fill+line layers. Uses the
// MapLibre filter that filter-where.ts produced, plus a fitBounds special
// case for the legacy state-filter (we know each state's bbox from the
// catalog, so the camera flies to it just like before).
function applyActiveFilters(
  filters: import('./filter-where').ActiveFilter[],
  mapFilter: import('./filter-where').MaplibreFilter,
  fullCatalog?: { state_bounds?: Record<string, [number, number, number, number]> },
): void {
  if (!map) return;
  for (const id of ['fill', 'line']) {
    if (map.getLayer(id)) {
      map.setFilter(id, (mapFilter as maplibregl.FilterSpecification | null) ?? null);
    }
  }
  const padding = panelAwarePadding();
  // Single-state fly-to (LGD state filter).
  if (filters.length === 1 && filters[0].kind === 'in' && filters[0].values.length === 1 &&
      /^state_lgd$/i.test(filters[0].col)) {
    const code = String(filters[0].values[0]);
    const b = fullCatalog?.state_bounds?.[code];
    if (b) {
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding, duration: 600 });
      return;
    }
  }
  // Filter cleared → fly back to India.
  if (!filters.length) {
    map.fitBounds(INDIA_BOUNDS, { padding, duration: 600 });
  }
}
