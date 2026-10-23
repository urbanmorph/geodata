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
//   2. liberty ("Streets") — opt-in for users who want geographic context:
//      OpenFreeMap Liberty (OpenStreetMap roads, buildings, landmarks, place
//      names), vector, shared with collect and trimmed for India in
//      shared/liberty.ts so it draws no borders or country/state names of its
//      own; the LGD outline stays the only border. Replaced CARTO Light, whose
//      free tiles now carry an "API KEY REQUIRED" watermark (a stored
//      'positron' maps here).
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
import { LIBERTY } from '../../shared/liberty';
import { esriImagerySource } from '../../shared/esri-imagery';

const SATELLITE_TILES = esriImagerySource(import.meta.env?.VITE_ARCGIS_KEY as string | undefined);

export type BasemapId = 'minimal' | 'liberty' | 'opentopo' | 'satellite';

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

const OSM_IN_ATTRIB =
  'India boundary: <a href="https://github.com/osm-in/mapbox-gl-styles" target="_blank" rel="noopener">osm-in</a> · © OpenStreetMap contributors (ODbL)';

const OPENTOPOMAP_ATTRIB =
  'Map data: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> · Style: © <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)';

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
      'india-outline': {
        type: 'geojson',
        // Simplified LGD-dissolved India polygon (106 KB, same-origin).
        // Complete closed outline including coast + India's claimed
        // territory (J&K, Aksai Chin, Arunachal). Simplified at ~1 km
        // tolerance — good enough for country-scale basemap rendering.
        data: '/india-outline.geojson',
        attribution: 'India outline: LGD (dissolved states)',
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
      // Fill India with the SAME warm off-white using the LGD-dissolved
      // polygon, on top of world-land. Natural Earth's 1:110m coastline
      // disagrees with LGD by several km along the Konkan / Coromandel
      // coast, so the ocean colour was leaking through inside the outline
      // ("water seeping past the boundaries"). Stacking this India fill
      // on top closes the gap exactly to the outline that's drawn next.
      {
        id: 'minimal-india-fill',
        type: 'fill',
        source: 'india-outline',
        paint: {
          'fill-color': '#f5f3ef',
        },
      },
      // Complete India outline from the LGD-dissolved polygon. Renders
      // the full coast + all land borders as a single stroke — the osm-in
      // file only had claim lines (J&K, Aksai Chin, Arunachal) so the
      // coast and non-disputed borders were invisible.
      {
        id: 'minimal-india-outline',
        type: 'line',
        source: 'india-outline',
        paint: {
          'line-color': '#7d6a5a',
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.0, 10, 2.0],
          'line-opacity': 0.9,
        },
      },
      // osm-in claim lines no longer rendered — the LGD-dissolved outline
      // already traces India's claim (includes J&K + Ladakh + Arunachal
      // via the state polygons). Keeping the india-boundary source + its
      // attribution so it's still available if needed, but no layer draws
      // from it on the Minimal basemap.
    ],
  },
  {
    id: 'liberty',
    name: 'Streets',
    hint: 'OpenStreetMap roads, buildings and landmarks · India border from LGD',
    sources: LIBERTY.sources as Record<string, SourceSpecification>,
    layers: LIBERTY.layers as unknown as LayerSpecification[],
  },
  {
    id: 'opentopo',
    name: 'OpenTopoMap',
    hint: 'topographic relief · international labels (state lines overlaid via LGD)',
    sources: {
      // OpenTopoMap is a community-hosted OSM-derived topographic style with
      // hypsometric tints + contour lines + relief shading. No API key. CC-BY-SA.
      // Their usage policy asks for restraint at scale; bharatlas's alpha
      // volume is well within their politely-asked-for limits. If we scale up
      // significantly we'd need to either self-host or move to a paid tier
      // (e.g. Thunderforest, Stadia, MapTiler).
      'opentopo-tiles': {
        type: 'raster',
        tiles: [
          'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 17,
        attribution: OPENTOPOMAP_ATTRIB,
      },
    },
    layers: [
      {
        id: 'opentopo-base',
        type: 'raster',
        source: 'opentopo-tiles',
      },
    ],
  },
  // Satellite only with an ArcGIS key (shared/esri-imagery.ts): keyless Esri use is not licensed.
  ...(SATELLITE_TILES
    ? [
        {
          id: 'satellite' as const,
          name: 'Esri Imagery',
          hint: 'global satellite · India state lines overlaid via LGD · online only',
          sources: { 'satellite-tiles': SATELLITE_TILES as SourceSpecification },
          layers: [{ id: 'satellite-base', type: 'raster', source: 'satellite-tiles' } as LayerSpecification],
        },
      ]
    : []),
];

export const DEFAULT_BASEMAP: BasemapId = 'minimal';

const STORAGE_KEY = 'bharatlas:basemap';

export function getStoredBasemap(storage: Storage = globalThis.localStorage): BasemapId {
  try {
    const v = storage.getItem(STORAGE_KEY);
    if (v === 'positron') return 'liberty'; // the retired Carto Light
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
