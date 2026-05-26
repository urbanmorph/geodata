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
import { type ActiveFilter, type MaplibreFilter } from './filter-where';

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDIA_BOUNDS: [number, number, number, number] = [68, 6, 98, 38];
const BASE_PADDING = { top: 60, bottom: 20, left: 20, right: 20 };
const MAX_POPUP_PROPS = 10;
const DATA_LAYERS = ['fill', 'line-halo', 'line', 'point'] as const;
const INTERACTIVE_LAYERS = ['fill', 'point'] as const;
const POINT_GEOM_FILTER: maplibregl.FilterSpecification = ['==', ['geometry-type'], 'Point'];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let map: MlMap | null = null;
let filterAbort: AbortController | null = null;
let activeBasemap: BasemapId = 'minimal';
let layerBounds: [number, number, number, number] = INDIA_BOUNDS;

// ---------------------------------------------------------------------------
// PMTiles protocol + archive cache
// ---------------------------------------------------------------------------

const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asBounds(b: [number, number, number, number]): [[number, number], [number, number]] {
  return [[b[0], b[1]], [b[2], b[3]]];
}

function flyTo(
  bounds: [number, number, number, number],
  opts?: { padding?: Record<string, number>; duration?: number },
): void {
  if (!map) return;
  map.fitBounds(asBounds(bounds), {
    padding: opts?.padding ?? BASE_PADDING,
    duration: opts?.duration ?? 600,
  });
}

function snapToIndiaIfLarge(bounds: [number, number, number, number]): [number, number, number, number] {
  const indiaArea = (INDIA_BOUNDS[2] - INDIA_BOUNDS[0]) * (INDIA_BOUNDS[3] - INDIA_BOUNDS[1]);
  const layerArea = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
  return layerArea / indiaArea > 0.5 ? INDIA_BOUNDS : bounds;
}

function panelAwarePadding(): { top: number; bottom: number; left: number; right: number } {
  const base = 20;
  const panel = document.querySelector<HTMLElement>('.filter-panel');
  if (!panel) return { top: base, bottom: base, left: base, right: base };
  const r = panel.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (r.bottom >= vh - 1 && r.width >= vw * 0.7) {
    return { top: base, bottom: base + r.height, left: base, right: base };
  }
  return { top: base, bottom: base, left: base, right: base + r.width };
}

// ---------------------------------------------------------------------------
// Basemap
// ---------------------------------------------------------------------------

function buildBaseStyle(active: BasemapId): maplibregl.StyleSpecification {
  const sources: Record<string, maplibregl.SourceSpecification> = {};
  const layers: maplibregl.LayerSpecification[] = [];
  for (const b of BASEMAPS) {
    Object.assign(sources, b.sources);
    for (const lyr of b.layers) {
      const existingLayout = (lyr as { layout?: Record<string, unknown> }).layout || {};
      layers.push({
        ...lyr,
        layout: { ...existingLayout, visibility: b.id === active ? 'visible' : 'none' },
      } as maplibregl.LayerSpecification);
    }
  }
  return { version: 8, sources, layers };
}

function setBasemap(id: BasemapId): void {
  if (!map) return;
  for (const b of BASEMAPS) {
    for (const lyr of b.layers) {
      if (map.getLayer(lyr.id)) {
        map.setLayoutProperty(lyr.id, 'visibility', b.id === id ? 'visible' : 'none');
      }
    }
  }
  activeBasemap = id;
  setStoredBasemap(id);
}

// ---------------------------------------------------------------------------
// Data layer rendering
// ---------------------------------------------------------------------------

function addDataLayers(sourceId: string, sourceLayer?: string) {
  if (!map) return;
  const common = sourceLayer ? { 'source-layer': sourceLayer } : {};
  map.addLayer({
    id: 'fill', type: 'fill', source: sourceId, ...common,
    paint: { 'fill-color': '#0a58ca', 'fill-opacity': 0.22 },
  });
  map.addLayer({
    id: 'line-halo', type: 'line', source: sourceId, ...common,
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.5, 10, 3.5],
      'line-opacity': 0.75,
    },
  });
  map.addLayer({
    id: 'line', type: 'line', source: sourceId, ...common,
    paint: {
      'line-color': '#0a58ca',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 10, 1.2],
      'line-opacity': 0.85,
    },
  });
  map.addLayer({
    id: 'point', type: 'circle', source: sourceId, ...common,
    filter: POINT_GEOM_FILTER,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 10, 5, 14, 7],
      'circle-color': '#0a58ca',
      'circle-opacity': 0.75,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 10, 1],
      'circle-stroke-color': '#fff',
    },
  });

  for (const id of ['minimal-india-outline', 'minimal-india-boundary']) {
    if (map.getLayer(id)) map.moveLayer(id, 'line-halo');
  }
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

function bindPopupToLayers() {
  if (!map) return;
  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: '320px',
    className: 'geo-popup',
  });

  function buildRows(props: Record<string, unknown> | null | undefined): string {
    return Object.entries(props || {})
      .filter(([k, v]) => !k.startsWith('_') && v != null && v !== '')
      .slice(0, MAX_POPUP_PROPS)
      .map(
        ([k, v]) =>
          `<div class="geo-popup__row"><span class="geo-popup__k">${escapeHtml(k)}</span><span class="geo-popup__v">${escapeHtml(String(v))}</span></div>`,
      )
      .join('');
  }

  let popupId: string | number | undefined;
  const showPopup = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
    const f = e.features?.[0];
    if (!f) return;
    const fid = (f.id as string | number | undefined)
      ?? f.properties?.OBJECTID
      ?? f.properties?.objectid
      ?? f.properties?.vil_lgd
      ?? f.properties?.soi_code
      ?? `${e.lngLat.lng.toFixed(5)},${e.lngLat.lat.toFixed(5)}`;
    if (fid !== popupId) {
      popup.setHTML(buildRows(f.properties));
      popupId = fid;
    }
    popup.setLngLat(e.lngLat).addTo(map!);
  };

  for (const id of INTERACTIVE_LAYERS) {
    map.on('mousemove', id, (e) => {
      map!.getCanvas().style.cursor = 'pointer';
      showPopup(e);
    });
    map.on('mouseleave', id, () => {
      map!.getCanvas().style.cursor = '';
      popup.remove();
      popupId = undefined;
    });
    map.on('click', id, showPopup);
  }
  map.on('click', (e) => {
    const hit = map!.queryRenderedFeatures(e.point, { layers: [...INTERACTIVE_LAYERS] });
    if (!hit.length) {
      popup.remove();
      popupId = undefined;
    }
  });
}

// ---------------------------------------------------------------------------
// Data source attachment
// ---------------------------------------------------------------------------

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
    layerBounds = snapToIndiaIfLarge([header.minLon, header.minLat, header.maxLon, header.maxLat]);
    flyTo(layerBounds, { padding: BASE_PADDING, duration: 0 });
    addDataLayers('layer', sourceLayer);
  } else if (layer.geojson?.url) {
    map.addSource('layer', { type: 'geojson', data: layer.geojson.url, attribution: layer.source });
    addDataLayers('layer');
  } else {
    throw new Error('no renderable source for ' + layer.id);
  }

  bindPopupToLayers();
}

// LGD state boundaries layered on top of any non-LGD layer for cross-source
// comparison and to show India-correct boundaries on the Carto basemap.
async function addLgdOverlay(catalogLayers: Layer[], activeLayerId: string): Promise<void> {
  if (!map) return;
  if (activeLayerId === 'lgd_states') return;
  const lgd = catalogLayers.find((l) => l.id === 'lgd_states');
  if (!lgd?.pmtiles?.url) return;

  const archive = getArchive(lgd.pmtiles.url);
  const metadata = await archive.getMetadata();
  const vlayers = (metadata as { vector_layers?: Array<{ id: string }> }).vector_layers || [];
  if (!vlayers.length) return;
  const sourceLayer = vlayers[0].id;

  if (map.getSource('lgd-overlay')) return;
  map.addSource('lgd-overlay', {
    type: 'vector',
    url: `pmtiles://${lgd.pmtiles.url}`,
    attribution: 'India boundaries · LGD',
  });
  map.addLayer({
    id: 'lgd-overlay-line',
    type: 'line',
    source: 'lgd-overlay',
    'source-layer': sourceLayer,
    paint: {
      'line-color': '#8b7e6f',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.3, 10, 0.7],
      'line-opacity': 0.3,
    },
  });
}

// ---------------------------------------------------------------------------
// Filter column loading
// ---------------------------------------------------------------------------

async function loadFilterColumns(
  layer: Layer,
  signal: AbortSignal,
): Promise<{ columns: import('./filter-schema').ColumnStats[]; rowCount: number } | null> {
  if (!layer.parquet?.url) return null;

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
      if (signal.aborted) return null;
      const probe = await describeParquet(layer.parquet!.url);
      rowCount = probe.rowCount;
      columns = probe.columns;
    } catch (e) {
      console.warn('filter-probe failed for', layer.id, e);
      return null;
    }
  }
  if (signal.aborted) return null;

  if (baked?.column_groups?.length) {
    const drop = new Set<string>();
    for (const g of baked.column_groups) {
      for (const m of g.members) if (m !== g.canonical) drop.add(m);
    }
    columns = columns.filter((c) => !drop.has(c.name));
  }

  const ranked = rankColumns(columns, rowCount);
  if (!ranked.length) return null;
  return { columns: ranked, rowCount };
}

// ---------------------------------------------------------------------------
// Filter application
// ---------------------------------------------------------------------------

function applyActiveFilters(
  filters: ActiveFilter[],
  mapFilter: MaplibreFilter,
): void {
  if (!map) return;
  for (const id of DATA_LAYERS) {
    if (!map.getLayer(id)) continue;
    if (id === 'point') {
      map.setFilter(id, mapFilter ? ['all', POINT_GEOM_FILTER, mapFilter as maplibregl.FilterSpecification] : POINT_GEOM_FILTER);
    } else {
      map.setFilter(id, (mapFilter as maplibregl.FilterSpecification | null) ?? null);
    }
  }
  const padding = panelAwarePadding();

  if (filters.length) {
    const m = map;
    const p = padding;
    m.once('idle', () => {
      const features = m.queryRenderedFeatures(undefined, {
        layers: (['fill', 'point'] as string[]).filter((id) => m.getLayer(id)),
      });
      if (!features.length) return;
      const bounds = new maplibregl.LngLatBounds();
      for (const f of features) {
        if (f.geometry.type === 'Point') {
          bounds.extend(f.geometry.coordinates as [number, number]);
        } else if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
          const coords = f.geometry.type === 'Polygon'
            ? f.geometry.coordinates[0]
            : f.geometry.coordinates[0][0];
          for (const c of coords) bounds.extend(c as [number, number]);
        }
      }
      if (!bounds.isEmpty()) {
        m.fitBounds(bounds, { padding: p, duration: 600 });
      }
    });
  } else {
    flyTo(layerBounds, { padding, duration: 600 });
  }
}

// ---------------------------------------------------------------------------
// Popover helper
// ---------------------------------------------------------------------------

function bindPopover(btn: HTMLButtonElement, popover: HTMLElement): () => void {
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
  return close;
}

// ---------------------------------------------------------------------------
// Header button wiring
// ---------------------------------------------------------------------------

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
      prompt('Copy this iframe snippet:', snippet);
    }
  });
  exportBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!map) return;
    const fmt = exportBtn.querySelector<HTMLElement>('.map-popover__fmt');
    const original = fmt?.textContent ?? '';
    if (fmt) fmt.textContent = 'Rendering…';
    try {
      await new Promise<void>((resolve) => {
        const m = map!;
        m.once('idle', () => resolve());
        m.triggerRepaint();
      });
      const url = map.getCanvas().toDataURL('image/png');
      triggerDownload(dataUrlToBlob(url), imageFilename(layer.id));
      if (fmt) {
        fmt.textContent = '✓ Saved';
        setTimeout(() => { if (original) fmt.textContent = original; }, 1400);
      }
    } catch (err) {
      console.error('PNG export failed', err);
      if (fmt) {
        fmt.textContent = 'Export failed';
        setTimeout(() => { if (original) fmt.textContent = original; }, 1800);
      }
    }
  });
  bindPopover(btn, popover);
}

function wireBasemapButton(): void {
  const btn = document.getElementById('map-basemap') as HTMLButtonElement | null;
  const popover = document.getElementById('map-basemap-popover');
  if (!btn || !popover) return;
  btn.classList.add('shown');
  const closePopover = bindPopover(btn, popover);
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
        closePopover();
      });
    }
  };
  render();
}

async function wireFilterButton(layer: Layer) {
  const btn = document.getElementById('map-filter') as HTMLButtonElement | null;
  if (!btn) return;
  filterAbort?.abort();
  filterAbort = new AbortController();
  const signal = filterAbort.signal;

  btn.classList.remove('shown');
  document.querySelector('.filter-panel')?.remove();

  btn.classList.add('shown');
  btn.disabled = true;
  const { VERBS_ENGINE } = await import('./loading');
  let verbIdx = 0;
  let verbTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    btn.textContent = VERBS_ENGINE[verbIdx++ % VERBS_ENGINE.length];
  }, 1800);
  btn.textContent = VERBS_ENGINE[0];

  const result = await loadFilterColumns(layer, signal);
  if (verbTimer) { clearInterval(verbTimer); verbTimer = null; }
  if (!result) { btn.classList.remove('shown'); return; }
  const { columns: ranked, rowCount } = result;

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
      btn.textContent = 'Preparing filters…';
      try {
        const { mountFilterPanel } = await import('./filter');
        if (signal.aborted) return;
        mountFilterPanel(layer, document.getElementById('map')!, ranked, rowCount, {
          onClose: () => {
            btn.disabled = false;
            btn.textContent = 'Filter & export';
            applyActiveFilters([], null);
            flyTo(layerBounds, { padding: BASE_PADDING });
          },
          onActiveFiltersChange: (filters, mapFilter) => {
            applyActiveFilters(filters, mapFilter);
          },
        });
        if (map) {
          requestAnimationFrame(() => {
            flyTo(layerBounds, { padding: panelAwarePadding(), duration: 300 });
          });
        }
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function openLayer(layerId: string, opts: { titleEl: HTMLElement }) {
  const cat = (await getCatalog()) as { layers?: Layer[] };
  const layer = cat.layers?.find((l) => l.id === layerId);
  if (!layer) {
    opts.titleEl.textContent = `unknown layer: ${layerId}`;
    return;
  }
  opts.titleEl.textContent = `${layer.level} · ${layer.source} · ${layer.rows?.toLocaleString('en-IN') ?? '—'} rows`;

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
    fitBoundsOptions: { padding: BASE_PADDING },
    attributionControl: { compact: true },
    preserveDrawingBuffer: true,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));

  map.on('load', async () => {
    try {
      await attachData(layer);
      await addLgdOverlay(cat.layers ?? [], layer.id);
      map.once('idle', () => loader.dismiss());
    } catch (e) {
      console.error('attachData failed', e);
      const c = document.getElementById('map')!;
      const err = document.createElement('div');
      err.id = 'map-loading';
      err.textContent = `failed to load layer: ${(e as Error).message}`;
      c.appendChild(err);
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
  for (const p of document.querySelectorAll('.map-popover.open')) p.classList.remove('open');
}
