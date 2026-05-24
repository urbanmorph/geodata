// Basemap registry for the map viewer.
//
// Two options:
//
//   1. minimal (default) — solid ocean background + Natural Earth 1:110m
//      land polygons + India boundary line per India's claim (osm-in
//      community GeoJSON, ODbL). No raster tiles, no external API key,
//      no third-party network beyond the same-origin static GeoJSON.
//      The de facto disputed lines that India rejects (disputed_by:IN)
//      are filtered out. This is the answer to the J&K-labels feedback:
//      by not loading a basemap that carries international-convention
//      labels, the labels can't appear.
//
//   2. positron (Carto Light) — opt-in for users who want geographic
//      context (roads, cities). Labelled with "international labels" in
//      the menu so users know what they're switching to. CARTO terms
//      allow this for low-traffic open-source use; attribution required.
//
// A third "Topo" option using Mapzen Terrarium DEM + MapLibre 5's
// color-relief layer was prototyped and dropped — perf cost of fetching
// DEM tiles per viewport wasn't worth the visual upgrade, and a
// pre-baked hypsometric tile set is more work than the audience
// currently warrants. Dropping topo also let us revert MapLibre 5 →
// 4.7.1, shrinking the map-vendor bundle by ~250 KB raw.
//
// India boundary GeoJSON: 56 KB, 137 LineStrings, hand-curated by the
// osm-in community from OpenStreetMap data. Lives at
// /india-boundary.geojson on same origin (committed under web/public/).
//   https://github.com/osm-in/mapbox-gl-styles
//   https://gist.github.com/planemad/933e2b5a4c7d9f0a26541522a1492f92

import type { SourceSpecification, LayerSpecification } from 'maplibre-gl';

export type BasemapId = 'minimal' | 'positron';

export type Basemap = {
  id: BasemapId;
  name: string;
  hint: string;
  // Each basemap declares its own sources + layers. Multiple layers per
  // basemap is supported (the minimal style has bg + line layers). Layer
  // IDs must be unique across all basemaps in the registry so the style
  // can carry them all simultaneously, with only the active basemap's
  // layers set visible.
  sources: Record<string, SourceSpecification>;
  layers: LayerSpecification[];
};

const CARTO_ATTRIB =
  '© <a href="https://carto.com/attribution/">CARTO</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const OSM_IN_ATTRIB =
  'India boundary: <a href="https://github.com/osm-in/mapbox-gl-styles" target="_blank" rel="noopener">osm-in</a> · © OpenStreetMap contributors (ODbL)';

export const BASEMAPS: Basemap[] = [
  {
    id: 'minimal',
    name: 'Bharatlas Minimal',
    hint: 'India-correct boundaries · land + ocean · no labels',
    sources: {
      'world-land': {
        type: 'geojson',
        // Natural Earth 1:110m land polygons (138 KB, 127 features, polygon-only).
        // World coverage, coarse at high zoom but sufficient for our viewport
        // range (country → city scale). Drives the land/water visual distinction.
        // CC0 / Public Domain via Natural Earth Data.
        data: '/world-land.geojson',
        attribution:
          'Land polygons: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> (public domain)',
      },
      'india-boundary': {
        type: 'geojson',
        data: '/india-boundary.geojson',
        attribution: OSM_IN_ATTRIB,
      },
    },
    layers: [
      {
        id: 'minimal-bg',
        type: 'background',
        paint: {
          // Soft cool grey-blue — reads as ocean / sea on a printed atlas.
          // Land polygons paint a warm off-white on top so the contrast is
          // calm + civic, not vibrant.
          'background-color': '#dee5e8',
        },
      },
      {
        id: 'minimal-land',
        type: 'fill',
        source: 'world-land',
        paint: {
          'fill-color': '#f5f3ef', // warm off-white
          'fill-outline-color': '#d0c8be', // subtle taupe coast outline
        },
      },
      {
        id: 'minimal-india-boundary',
        type: 'line',
        source: 'india-boundary',
        // Render only lines India claims OR that aren't a disputed-by-IN line.
        // Skips the 51 features tagged disputed_by:IN with no claim attached
        // (these are the de facto international convention India rejects).
        // Renders the 64 claimed_by:IN features (India's claim) + the 22
        // undisputed segments (e.g. India-Sri Lanka coast where there's no
        // controversy).
        filter: ['!=', ['get', 'disputed_by'], 'IN'],
        paint: {
          'line-color': '#7d6a5a', // warm taupe, reads as a printed-atlas boundary
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 10, 1.8],
          'line-opacity': 0.9,
        },
      },
    ],
  },
  {
    id: 'positron',
    name: 'Carto Light',
    hint: 'international labels (state lines overlaid via LGD, labels unchangeable)',
    sources: {
      'positron-tiles': {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
          'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        attribution: CARTO_ATTRIB,
      },
    },
    layers: [
      {
        id: 'positron-base',
        type: 'raster',
        source: 'positron-tiles',
      },
    ],
  },
];

export const DEFAULT_BASEMAP: BasemapId = 'minimal';

const STORAGE_KEY = 'bharatlas:basemap';

export function getStoredBasemap(storage: Storage = globalThis.localStorage): BasemapId {
  try {
    const v = storage.getItem(STORAGE_KEY);
    if (v && BASEMAPS.some((b) => b.id === v)) return v as BasemapId;
  } catch {
    // localStorage may be unavailable (private mode, SSR) — fall through.
  }
  return DEFAULT_BASEMAP;
}

export function setStoredBasemap(id: BasemapId, storage: Storage = globalThis.localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, id);
  } catch {
    // Best-effort: a failure to persist shouldn't break the swap.
  }
}

export function getBasemap(id: BasemapId): Basemap {
  return BASEMAPS.find((b) => b.id === id) || BASEMAPS[0];
}
