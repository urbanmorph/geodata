// Basemap registry for the map viewer.
//
// Two options today:
//
//   1. minimal (default) — solid background + India boundary GeoJSON overlay
//      from osm-in/mapbox-gl-styles. No raster tiles, no external API key,
//      no third-party network beyond the same-origin static GeoJSON. India's
//      international boundary is rendered per India's official claim (the
//      claimed_by:IN lines from the osm-in dataset); de facto disputed lines
//      that India rejects (disputed_by:IN) are skipped. This is the answer
//      to the J&K-labels feedback — by not loading a basemap that carries
//      international-convention labels, the labels can't appear.
//
//   2. positron (Carto Light) — kept as an opt-in for users who want
//      geographic context (roads, cities, terrain shading). Labelled with
//      "international labels" in the menu so users know what they're
//      switching to. CARTO terms allow this for low-traffic open-source
//      use; attribution is required (handled by MapLibre via the source's
//      attribution field).
//
// India boundary GeoJSON: 56 KB, 137 LineStrings, hand-curated by the osm-in
// community from OpenStreetMap data. Lives at /india-boundary.geojson on
// same origin (committed under web/public/). See:
//   https://github.com/osm-in/mapbox-gl-styles
//   https://gist.github.com/planemad/933e2b5a4c7d9f0a26541522a1492f92

import type { SourceSpecification, LayerSpecification } from 'maplibre-gl';

export type BasemapId = 'minimal' | 'topo' | 'positron';

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
    id: 'topo',
    name: 'Bharatlas Topo',
    hint: 'India-correct · elevation tints · hillshade · no labels',
    sources: {
      'terrain-dem': {
        type: 'raster-dem',
        // Mapzen Terrarium tiles via AWS Open Terrain Tiles (public dataset,
        // no API key). MapLibre decodes the RGB-encoded elevation natively
        // and feeds it to both the color-relief and hillshade layers.
        tiles: ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: 15,
        attribution:
          'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">AWS Open Terrain Tiles</a> (Tilezen Joerd · CC-BY)',
      },
      'india-boundary': {
        type: 'geojson',
        data: '/india-boundary.geojson',
        attribution: OSM_IN_ATTRIB,
      },
    },
    layers: [
      {
        id: 'topo-bg',
        type: 'background',
        // Fallback ocean colour while terrain tiles load. Matches the
        // shallow-ocean stop in the color-relief ramp below.
        paint: { 'background-color': '#a8c8d4' },
      },
      {
        // MapLibre 5.6+ color-relief layer — paints each pixel based on its
        // elevation via the [`elevation`] expression. True hypsometric tints
        // (greens for lowland, tans for hills, browns for mountains, snow
        // for peaks). Source must be a raster-dem; the encoding decoding
        // is handled by MapLibre itself.
        id: 'topo-color-relief',
        type: 'color-relief',
        source: 'terrain-dem',
        paint: {
          'color-relief-color': [
            'interpolate',
            ['linear'],
            ['elevation'],
            -500, '#7daabb', // deep ocean (Indian Ocean trenches)
            -50, '#a8c8d4', // shallow / continental shelf
            0, '#c8d8d2', // coast — barely-land
            1, '#a6c2a3', // lowland green (Indo-Gangetic plain)
            300, '#cad99a', // hills — light olive
            800, '#dccc8d', // low mountains — tan
            1800, '#c69e6c', // mid mountains — golden brown
            3200, '#a07550', // high mountains — burnt umber
            4800, '#806244', // very high — dark earth
            5800, '#e9ddca', // snow line — warm ivory
            8848, '#ffffff', // peaks — white (Everest)
          ],
        },
      },
      {
        id: 'topo-hillshade',
        type: 'hillshade',
        source: 'terrain-dem',
        paint: {
          // Subtle relief shading on top of the hypsometric tints so
          // mountains have visible texture. Kept gentle so the colour
          // ramp remains readable; the tints are the dominant visual.
          'hillshade-exaggeration': 0.45,
          'hillshade-shadow-color': '#5a4a3a',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-accent-color': '#a89070',
          'hillshade-illumination-direction': 335,
        },
      },
      {
        id: 'topo-india-boundary',
        type: 'line',
        source: 'india-boundary',
        filter: ['!=', ['get', 'disputed_by'], 'IN'],
        paint: {
          'line-color': '#3a2f24', // dark earth — readable on any tint
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 10, 2.2],
          'line-opacity': 0.85,
        },
      },
    ],
  },
  {
    id: 'positron',
    name: 'Carto Light',
    hint: 'international labels (boundaries not India-correct)',
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
