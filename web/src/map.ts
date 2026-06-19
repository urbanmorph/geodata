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
import { featureCollectionBounds, type FC } from './validate';
import { reduceOverlay, initialOverlayState, type OverlayState, type OverlayAction, type Surface } from './view-overlays';
import { displayTitle } from './layer-display';
import { paddingForPanelRect, type Padding } from './map-padding';
import { resolveLocateConfig } from './locate-config';
// Static (not dynamic) import: geolocation must be requested synchronously
// inside the tap handler. A dynamic import() pushes getCurrentPosition past the
// user-gesture window, which mobile Chrome silently drops (no prompt, no sheet).
// locate is tiny and folds into this already-lazy map chunk.
import { openLocate, closeLocate } from './locate';
import { buildFeatureFilter, parseAtParam } from './locate-actions';

type Layer = {
  id: string;
  level: string | null;
  source: string;
  rows: number | null;
  name?: string;
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
// Source-layer + level of the open layer, used by the locate "Zoom to it"
// highlight (filter the same source; pick a sensible arrival zoom by level).
let currentSourceLayer: string | undefined;
let currentLayerLevel: string | null = null;
// Coords from a shared ?at=lat,lng link, consumed by the next locate show()
// so the deep-link reproduces the result without the visitor's own GPS.
let pendingLocateCoords: { lat: number; lng: number } | null = null;

// Arrival zoom for "Zoom to it", keyed by layer level. A best-effort fitBounds
// then tightens to the actual feature; this just gets us close enough that the
// feature's tiles are loaded for that fit. Wards default to 13, else 11.
const LEVEL_ZOOM: Record<string, number> = {
  state: 6, district: 9, subdistrict: 10, block: 11, panchayat: 12, village: 13,
  assembly_constituency: 9, parliament_constituency: 8, seismic_zone: 7, eco_zone: 7,
  health_facility: 14, airport: 11,
};
const arrivalZoom = (level: string | null): number =>
  (level && LEVEL_ZOOM[level]) || (level && /^wards_/.test(level) ? 13 : 11);

// ---------------------------------------------------------------------------
// Single-open overlay controller
// ---------------------------------------------------------------------------
//
// The map chrome has three secondary surfaces — basemap picker, download menu,
// filter/export — that used to toggle independently, so on mobile (where each
// is a bottom sheet) opening one left the others stacked behind it. The pure
// reducer in view-overlays.ts is the single source of truth for which surface
// is open; this DOM layer applies that state. See spec-view-mobile-controls.md.

type SurfaceHandle = { btn: HTMLElement | null; show: () => void; hide: () => void };
const surfaceHandles: Partial<Record<Surface, SurfaceHandle>> = {};
let overlayState: OverlayState = initialOverlayState;

const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;

function applyOverlay(prevActive: Surface | null): void {
  const active = overlayState.active;
  if (prevActive && prevActive !== active) surfaceHandles[prevActive]?.hide();
  if (active) surfaceHandles[active]?.show();
  document.getElementById('map-scrim')?.classList.toggle('open', active !== null);
  // `sheet-open` hides MapLibre's control layer on mobile so the attribution +
  // zoom controls don't paint over the open sheet (their stacking context
  // fights the fixed sheet). See the max-width:640px block in the template.
  document.getElementById('map-overlay')?.classList.toggle('sheet-open', active !== null);
  for (const name of Object.keys(surfaceHandles) as Surface[]) {
    surfaceHandles[name]?.btn?.setAttribute('aria-expanded', String(name === active));
  }
  map?.resize();
}

function dispatchOverlay(action: OverlayAction): void {
  const next = reduceOverlay(overlayState, action);
  if (next === overlayState) return;
  const prev = overlayState.active;
  overlayState = next;
  applyOverlay(prev);
}

function resetOverlays(): void {
  const prev = overlayState.active;
  overlayState = initialOverlayState;
  if (prev) surfaceHandles[prev]?.hide();
  document.getElementById('map-scrim')?.classList.remove('open');
  document.getElementById('map-overlay')?.classList.remove('sheet-open');
}

// A surface that dismisses itself (e.g. the filter panel's own close button)
// tells the controller so without re-triggering its hide(): the DOM is already
// gone, we just clear the state + chrome.
function notifyOverlayClosed(name: Surface): void {
  if (overlayState.active !== name) return;
  overlayState = initialOverlayState;
  document.getElementById('map-scrim')?.classList.remove('open');
  document.getElementById('map-overlay')?.classList.remove('sheet-open');
  surfaceHandles[name]?.btn?.setAttribute('aria-expanded', 'false');
}

// Outside-click dismisses the transient menus (basemap / download). Buttons and
// popovers stopPropagation, so this only fires on a true outside click. The
// filter panel and the scrim manage their own dismissal.
document.addEventListener(
  'click',
  () => {
    if (overlayState.active === 'basemap' || overlayState.active === 'download') {
      dispatchOverlay({ type: 'close' });
    }
  },
  { passive: true },
);
// Tapping the scrim (mobile) closes whatever sheet is open.
document.getElementById('map-scrim')?.addEventListener('click', () =>
  dispatchOverlay({ type: 'close' }),
);

// Register a popover-style surface (basemap, download). The button toggles it;
// returns a close fn for callers that complete an action and want to dismiss.
function registerPopover(name: Surface, btn: HTMLButtonElement, popover: HTMLElement): () => void {
  surfaceHandles[name] = {
    btn,
    show: () => popover.classList.add('open'),
    hide: () => popover.classList.remove('open'),
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    dispatchOverlay({ type: 'toggle', surface: name });
  };
  popover.onclick = (e) => e.stopPropagation();
  return () => dispatchOverlay({ type: 'close' });
}

// Toolbar buttons hold an icon + a .tb-label span; set the text on the span so
// the icon survives (plain textContent would wipe it).
function setToolLabel(btn: HTMLElement, text: string): void {
  const label = btn.querySelector('.tb-label');
  if (label) label.textContent = text;
  else btn.textContent = text;
}

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
  opts?: { padding?: Padding; duration?: number },
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


function panelAwarePadding(): Padding {
  const base = 20;
  const panel = document.querySelector<HTMLElement>('.filter-panel');
  if (!panel) return { top: base, bottom: base, left: base, right: base };
  const r = panel.getBoundingClientRect();
  return paddingForPanelRect(r, window.innerWidth, base);
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
// Locate "Zoom to it" — highlight the located feature + frame it
// ---------------------------------------------------------------------------

const HL_LAYERS = ['locate-hl-fill', 'locate-hl-line', 'locate-hl-circle'];
const HL_ACCENT = '#f59e0b'; // amber — stands out against the blue data layers

function clearLocateHighlight(): void {
  if (!map) return;
  for (const id of HL_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
}

// Highlight the located feature in accent so it reads as "this one" among its
// neighbours (which stay rendered normally), then fly to it. Polygon → fill +
// line; point → circle (whichever the geometry matches paints; the others are
// no-ops). Called from the result sheet's "Zoom to it" with the user's point
// (contains) or the feature's point (nearest).
function highlightAndZoom(props: Record<string, unknown>, lng: number, lat: number): void {
  if (!map) return;
  clearLocateHighlight();
  const filter = buildFeatureFilter(props);
  const common = currentSourceLayer ? { 'source-layer': currentSourceLayer } : {};
  if (filter) {
    map.addLayer({ id: 'locate-hl-fill', type: 'fill', source: 'layer', ...common, filter: filter as never,
      paint: { 'fill-color': HL_ACCENT, 'fill-opacity': 0.3 } });
    map.addLayer({ id: 'locate-hl-line', type: 'line', source: 'layer', ...common, filter: filter as never,
      paint: { 'line-color': HL_ACCENT, 'line-opacity': 1,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 12, 3.5] } });
    // Circle only for point geometries — otherwise it beads every polygon vertex.
    map.addLayer({ id: 'locate-hl-circle', type: 'circle', source: 'layer', ...common,
      filter: ['all', POINT_GEOM_FILTER, ...filter.slice(1)] as never,
      paint: { 'circle-color': HL_ACCENT, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 11] } });
  }

  const z = arrivalZoom(currentLayerLevel);
  map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), z), duration: 700 });

  // Best-effort tighten to the feature's real bounds once tiles settle.
  // querySourceFeatures returns tile-clipped geometry, but the union bbox frames
  // the feature well when its tiles are loaded (they are, after the flyTo). A
  // point's bbox is ~zero-area, so we leave the flyTo zoom in that case.
  if (!filter) return;
  map.once('idle', () => {
    if (!map) return;
    try {
      const feats = map.querySourceFeatures('layer', {
        ...(currentSourceLayer ? { sourceLayer: currentSourceLayer } : {}),
        filter: filter as never,
      });
      if (!feats.length) return;
      const b = featureCollectionBounds({ type: 'FeatureCollection', features: feats } as unknown as FC);
      if (!b) return;
      if (b[2] - b[0] < 1e-4 && b[3] - b[1] < 1e-4) return; // a point — already framed
      map.fitBounds(asBounds(b), { padding: panelAwarePadding(), maxZoom: 15, duration: 500 });
    } catch { /* query/fit is best-effort */ }
  });
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
    currentSourceLayer = sourceLayer;

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
    // No pmtiles header to read bounds from. Fetch the geojson once, derive its
    // extent, and fit the view to it — same outcome as the pmtiles path above.
    // Passing the parsed data to addSource avoids a second fetch.
    let data: unknown = layer.geojson.url;
    try {
      const resp = await fetch(layer.geojson.url);
      if (resp.ok) {
        const fc = (await resp.json()) as FC;
        data = fc;
        const b = featureCollectionBounds(fc);
        if (b) {
          layerBounds = snapToIndiaIfLarge(b);
          flyTo(layerBounds, { padding: BASE_PADDING, duration: 0 });
        }
      }
    } catch {
      // network/parse failure → fall back to the URL load + India bounds
    }
    currentSourceLayer = undefined;
    map.addSource('layer', { type: 'geojson', data: data as never, attribution: layer.source });
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
      map.setFilter(id, mapFilter ? (['all', POINT_GEOM_FILTER, mapFilter] as unknown as maplibregl.FilterSpecification) : POINT_GEOM_FILTER);
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
      // Nothing rendered while a filter is active means the in-tile filter
      // matched no features — usually the filtered column isn't carried as a
      // PMTiles property on this layer. Don't strand the user on a blank map:
      // drop the map filter (the DuckDB count/export still reflect the filter).
      if (!features.length) {
        for (const id of DATA_LAYERS) {
          if (!m.getLayer(id)) continue;
          m.setFilter(id, id === 'point' ? POINT_GEOM_FILTER : null);
        }
        return;
      }
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
  registerPopover('download', btn, popover);
}

function wireBasemapButton(): void {
  const btn = document.getElementById('map-basemap') as HTMLButtonElement | null;
  const popover = document.getElementById('map-basemap-popover');
  if (!btn || !popover) return;
  btn.classList.add('shown');
  const closePopover = registerPopover('basemap', btn, popover);
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

  delete surfaceHandles.filter;
  btn.classList.remove('shown');
  document.querySelector('.filter-panel')?.remove();
  if (!layer.parquet?.url) return;

  btn.classList.add('shown');
  setToolLabel(btn, 'Filter');
  btn.disabled = false;

  const columnsPromise = loadFilterColumns(layer, signal);

  const idle: (cb: () => void) => void =
    'requestIdleCallback' in window
      ? (cb) => (window as unknown as { requestIdleCallback: (c: () => void, o: { timeout: number }) => void }).requestIdleCallback(cb, { timeout: 4000 })
      : (cb) => setTimeout(cb, 1500);
  idle(() => import('./filter'));

  const resetFilterChrome = () => {
    btn.disabled = false;
    setToolLabel(btn, 'Filter');
    applyActiveFilters([], null);
    flyTo(layerBounds, { padding: BASE_PADDING });
  };

  // Switching surfaces on mobile tears the sheet down (direct removal mirrors
  // closeLayer); the user's filters reset, same as the panel's own close.
  const dismissFilterPanel = () => {
    if (!document.querySelector('.filter-panel')) return;
    document.querySelector('.filter-panel')?.remove();
    resetFilterChrome();
  };

  const openFilterPanel = async () => {
    if (document.querySelector('.filter-panel')) return; // already open
    const container = document.getElementById('map')!;

    const { VERBS_ENGINE } = await import('./loading');
    const panel = document.createElement('div');
    panel.className = 'filter-panel';
    panel.innerHTML = `<div style="padding:24px;color:var(--muted);font-size:14px"></div>`;
    container.appendChild(panel);
    const msg = panel.firstElementChild!;
    let vi = 0;
    msg.textContent = VERBS_ENGINE[0];
    const timer = setInterval(() => { msg.textContent = VERBS_ENGINE[++vi % VERBS_ENGINE.length]; }, 1800);

    const result = await columnsPromise;
    clearInterval(timer);
    panel.remove();
    if (signal.aborted || !result) {
      notifyOverlayClosed('filter');
      return;
    }

    const { columns: ranked, rowCount } = result;
    btn.disabled = true;
    setToolLabel(btn, 'Loading…');
    try {
      const { mountFilterPanel } = await import('./filter');
      if (signal.aborted) {
        notifyOverlayClosed('filter');
        return;
      }
      mountFilterPanel(layer, container, ranked, rowCount, {
        onClose: () => {
          resetFilterChrome();
          notifyOverlayClosed('filter');
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
      setToolLabel(btn, 'Filter');
    }
  };

  // The filter panel is a persistent workspace, not a transient menu: on
  // desktop it coexists with the basemap/download dropdowns (hide is a no-op,
  // matching today). On mobile every surface is a bottom sheet competing for
  // the same space, so switching away tears it down.
  surfaceHandles.filter = {
    btn,
    show: () => { void openFilterPanel(); },
    hide: () => { if (isMobileViewport()) dismissFilterPanel(); },
  };

  btn.addEventListener(
    'click',
    () => dispatchOverlay({ type: 'toggle', surface: 'filter' }),
    { signal },
  );
}

// Find-my-location toolbar item. Shows only on locate-enabled layers (ward
// layers built-in for now; others opt in via level_meta.locate_label). Uses the
// reserved `findward` overlay surface; the flow + result sheet live in locate.ts.
function wireLocateButton(
  layer: Layer,
  levelMeta: { locate_label?: string; locate_mode?: string } | undefined,
): void {
  const btn = document.getElementById('map-locate') as HTMLButtonElement | null;
  const sheet = document.getElementById('locate-sheet');
  if (!btn || !sheet) return;

  delete surfaceHandles.findward;
  btn.classList.remove('shown', 'locating');

  const config = resolveLocateConfig(layer, levelMeta);
  if (!config) return; // layer not locate-enabled → no item in the bar

  setToolLabel(btn, config.label);
  btn.setAttribute('aria-label', config.label);
  btn.classList.add('shown');

  surfaceHandles.findward = {
    btn,
    show: () => {
      btn.classList.add('locating');
      // Synchronous: opens the sheet ("Locating you…") and fires
      // getCurrentPosition in the same tap, so the prompt actually appears.
      openLocate({
        layerId: layer.id, config, sheet, btn,
        onZoom: highlightAndZoom,
        coords: pendingLocateCoords ?? undefined,
        onClose: () => dispatchOverlay({ type: 'close' }),
      });
      pendingLocateCoords = null;
    },
    hide: () => {
      btn.classList.remove('locating');
      closeLocate(sheet);
    },
  };

  btn.onclick = (e) => {
    e.stopPropagation();
    dispatchOverlay({ type: 'toggle', surface: 'findward' });
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function openLayer(layerId: string, opts: { titleEl: HTMLElement }) {
  resetOverlays();
  const cat = (await getCatalog()) as {
    layers?: Layer[];
    level_meta?: Record<string, { label?: string; seo_title?: string; locate_label?: string; locate_mode?: string }>;
  };
  const layer = cat.layers?.find((l) => l.id === layerId);
  if (!layer) {
    opts.titleEl.textContent = `unknown layer: ${layerId}`;
    return;
  }
  // Prefer the friendly title from level_meta (e.g. "Greater Bengaluru Wards
  // (2025)") so the bar never shows a raw id like "wards_bengaluru_gba". Layers
  // without a level_meta entry (most standard admin levels resolve theirs only
  // on the edge via BUILTIN_LEVEL_META) keep the level · source · rows line.
  const levelMeta = cat.level_meta?.[layerId];
  const rowsLabel = layer.rows?.toLocaleString('en-IN') ?? '—';
  const friendly = (levelMeta?.label || levelMeta?.seo_title || layer.name || '').trim();
  opts.titleEl.textContent = friendly
    ? displayTitle({ id: layerId, name: layer.name }, levelMeta)
    : layer.level
      ? `${layer.level} · ${layer.source} · ${rowsLabel} rows`
      : `${layer.source} · ${rowsLabel} features`;

  wireFilterButton(layer).catch((e) => console.warn('wireFilterButton failed', e));
  wireDownloadButton(layer);
  wireBasemapButton();
  currentLayerLevel = layer.level;
  wireLocateButton(layer, levelMeta);

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
    attributionControl: false,
    preserveDrawingBuffer: true,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  // Attribution as a compact (i) docked top-left, off the bottom bar; it expands
  // on tap (satisfies the licence). Scale is desktop-only — on mobile it just
  // clutters the bottom edge where the toolbar now lives.
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-left');
  if (!isMobileViewport()) map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));
  // MapLibre opens the compact attribution on load (a full-width credit strip
  // over the map top). Collapse it to just the (i); it still expands on tap.
  map.once('load', () => {
    const a = container.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact');
    a?.classList.remove('maplibregl-compact-show');
    a?.removeAttribute('open');
  });

  map.on('load', async () => {
    try {
      await attachData(layer);
      await addLgdOverlay(cat.layers ?? [], layer.id);
      if (!map) return; // closeLayer may have run during the awaits
      map.once('idle', () => {
        loader.dismiss();
        // ?at=lat,lng deep-link (from Share): reproduce the located result and
        // zoom/highlight using the shared coords, not the visitor's own GPS.
        const at = parseAtParam(new URLSearchParams(location.search).get('at'));
        if (at && surfaceHandles.findward) {
          pendingLocateCoords = at;
          dispatchOverlay({ type: 'toggle', surface: 'findward' });
        }
      });
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
  resetOverlays();
  const btn = document.getElementById('map-filter') as HTMLButtonElement | null;
  if (btn) btn.classList.remove('shown');
  const locateBtn = document.getElementById('map-locate');
  locateBtn?.classList.remove('shown', 'locating');
  const locateSheet = document.getElementById('locate-sheet');
  if (locateSheet) { locateSheet.classList.remove('open'); locateSheet.innerHTML = ''; }
  document.querySelector('.filter-panel')?.remove();
  for (const p of document.querySelectorAll('.map-popover.open')) p.classList.remove('open');
}
