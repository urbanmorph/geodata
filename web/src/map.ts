// Lazy-loaded map renderer. Imports MapLibre + PMTiles only when the user clicks "view".
import maplibregl, { Map as MlMap } from 'maplibre-gl';
import { Protocol, PMTiles } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';

type Catalog = {
  layers: Array<{
    id: string;
    level: string;
    source: string;
    rows: number | null;
    parquet?: { url: string; bytes: number } | null;
    pmtiles?: { url: string; bytes: number } | null;
    geojson?: { url: string; bytes: number } | null;
    notes?: string;
  }>;
};

let catalog: Catalog | null = null;
let map: MlMap | null = null;

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

async function loadCatalog(): Promise<Catalog> {
  if (catalog) return catalog;
  const resp = await fetch('/catalog.json');
  catalog = (await resp.json()) as Catalog;
  return catalog;
}

export async function openLayer(layerId: string, opts: { titleEl: HTMLElement }) {
  const cat = await loadCatalog();
  const layer = cat.layers.find((l) => l.id === layerId);
  if (!layer) {
    opts.titleEl.textContent = `unknown layer: ${layerId}`;
    return;
  }
  opts.titleEl.textContent = `${layer.level} · ${layer.source} · ${layer.rows?.toLocaleString('en-IN') ?? '—'} rows`;

  const container = document.getElementById('map')!;
  container.innerHTML = '';
  if (map) {
    map.remove();
    map = null;
  }
  const loader = showLoader(container);
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

async function attachData(layer: Catalog['layers'][number]) {
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

  // Hover-popup
  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: '320px',
    className: 'geo-popup',
  });
  map.on('mousemove', 'fill', (e) => {
    map!.getCanvas().style.cursor = 'pointer';
    const f = e.features?.[0];
    if (!f) return;
    const rows = Object.entries(f.properties || {})
      .filter(([k, v]) => !k.startsWith('_') && v != null && v !== '')
      .slice(0, 10)
      .map(
        ([k, v]) =>
          `<div class="geo-popup__row"><span class="geo-popup__k">${escapeHtml(k)}</span><span class="geo-popup__v">${escapeHtml(String(v))}</span></div>`
      )
      .join('');
    popup.setLngLat(e.lngLat).setHTML(rows).addTo(map!);
  });
  map.on('mouseleave', 'fill', () => {
    map!.getCanvas().style.cursor = '';
    popup.remove();
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

const LOADER_VERBS = [
  'Triangulating polygons…',
  'Plotting boundaries…',
  'Surveying terrain…',
  'Drawing meridians…',
  'Tessellating tiles…',
  'Decoding vector layers…',
  'Stitching coastlines…',
  'Resolving projections…',
  'Charting villages…',
  'Geolocating features…',
];

function showLoader(container: HTMLElement) {
  // Pick a starting verb at random, then cycle every 1.4s for variety.
  let i = Math.floor(Math.random() * LOADER_VERBS.length);
  const root = document.createElement('div');
  root.className = 'map-loader';
  root.innerHTML = `<div class="map-loader__ring" aria-hidden="true"></div><div class="map-loader__verb" role="status" aria-live="polite">${LOADER_VERBS[i]}</div>`;
  container.appendChild(root);
  const verbEl = root.querySelector('.map-loader__verb') as HTMLElement;
  const timer = window.setInterval(() => {
    i = (i + 1) % LOADER_VERBS.length;
    verbEl.textContent = LOADER_VERBS[i];
  }, 1400);
  return {
    dismiss() {
      clearInterval(timer);
      root.classList.add('fade');
      setTimeout(() => root.remove(), 240);
    },
  };
}

export function closeLayer() {
  if (map) {
    map.remove();
    map = null;
  }
}
