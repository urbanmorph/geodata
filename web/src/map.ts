// Lazy-loaded map renderer. Imports MapLibre + PMTiles only when the user clicks "view".
import maplibregl, { Map as MlMap } from 'maplibre-gl';
import { Protocol, PMTiles } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { overlayLoader, VERBS_MAP } from './loading';
import { getCatalog } from './catalog';
import { escapeHtml } from './util';

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

// MapLibre over OpenStreetMap raster fallback — no API key, attribution required.
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

const INDIA_BOUNDS: [number, number, number, number] = [68, 6, 98, 38];

export async function openLayer(layerId: string, opts: { titleEl: HTMLElement }) {
  const cat = (await getCatalog()) as { layers?: Layer[] };
  const layer = cat.layers?.find((l) => l.id === layerId);
  if (!layer) {
    opts.titleEl.textContent = `unknown layer: ${layerId}`;
    return;
  }
  opts.titleEl.textContent = `${layer.level} · ${layer.source} · ${layer.rows?.toLocaleString('en-IN') ?? '—'} rows`;

  await wireFilterButton(layer);

  const container = document.getElementById('map')!;
  container.innerHTML = '';
  if (map) {
    map.remove();
    map = null;
  }
  const loader = overlayLoader(container, VERBS_MAP);
  map = new maplibregl.Map({
    container,
    style: BASE_STYLE,
    bounds: INDIA_BOUNDS,
    fitBoundsOptions: { padding: 20 },
    attributionControl: { compact: true },
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

  // Hover-popup. HTML rebuild is memoised by feature id so dense panning over
  // dense layers (villages: 584k features) doesn't re-stringify on every mousemove.
  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: '320px',
    className: 'geo-popup geo-popup--hover',
  });
  // Sticky popup on tap/click — keeps content visible on touch devices.
  // The hover popup above stays on devices with a real pointer.
  const tapPopup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: true,
    maxWidth: '320px',
    className: 'geo-popup geo-popup--tap',
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
  map.on('mousemove', 'fill', (e) => {
    map!.getCanvas().style.cursor = 'pointer';
    const f = e.features?.[0];
    if (!f) return;
    const fid = (f.id as string | number | undefined) ?? f.properties?.OBJECTID ?? f.properties?.vil_lgd;
    if (fid !== popupId) {
      popup.setHTML(buildRows(f.properties));
      popupId = fid;
    }
    popup.setLngLat(e.lngLat).addTo(map!);
  });
  map.on('mouseleave', 'fill', () => {
    map!.getCanvas().style.cursor = '';
    popup.remove();
    popupId = undefined;
  });

  map.on('click', 'fill', (e) => {
    const f = e.features?.[0];
    if (!f) return;
    popup.remove();
    tapPopup.setLngLat(e.lngLat).setHTML(buildRows(f.properties)).addTo(map!);
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
}

async function wireFilterButton(layer: Layer) {
  const btn = document.getElementById('map-filter') as HTMLButtonElement | null;
  if (!btn) return;
  filterAbort?.abort();
  filterAbort = new AbortController();
  const signal = filterAbort.signal;

  // Only LGD parquet layers carry the code chain that powers state-filtering.
  const filterable = !!layer.parquet?.url && layer.source === 'LGD';
  if (!filterable) {
    btn.classList.remove('shown');
    document.querySelector('.filter-panel')?.remove();
    return;
  }
  btn.classList.add('shown');
  btn.textContent = 'Filter & export';
  btn.disabled = false;

  // B2: prefetch the filter chunk during idle time so the click feels instant.
  // Dynamic import dedupes — when the click fires, the chunk is already cached.
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
        mountFilterPanel(layer, document.getElementById('map')!, {
          onClose: () => {
            btn.disabled = false;
            btn.textContent = 'Filter & export';
            applyStateFilter(null, null);
          },
          onStateChange: applyStateFilter,
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

// Filter the active layer to a single state and fly the camera to its bounds.
// Property name varies by parquet (state_lgd vs State_LGD) so we match either.
function applyStateFilter(
  code: number | null,
  bounds: [number, number, number, number] | null,
): void {
  if (!map) return;
  const filter =
    code == null
      ? null
      : ['any', ['==', ['get', 'state_lgd'], code], ['==', ['get', 'State_LGD'], code]];
  for (const id of ['fill', 'line']) {
    if (map.getLayer(id)) map.setFilter(id, filter as maplibregl.FilterSpecification);
  }
  // Compute padding from the actual panel rect so fitBounds centres in the
  // visible area regardless of layout (right-rail desktop, bottom-sheet mobile).
  const padding = panelAwarePadding();
  if (bounds) {
    map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding, duration: 600 },
    );
  } else {
    map.fitBounds(INDIA_BOUNDS, { padding, duration: 600 });
  }
}
