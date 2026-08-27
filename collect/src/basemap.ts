// Basemap registry for the collect map. Three switchable raster basemaps, plus a
// persistent India-correct boundary overlay drawn on top of every one:
//
//   1. positron — Esri Light Gray Canvas (light base + labels). Default.
//      (Was CARTO Light until CARTO started watermarking its free tiles with
//      "API KEY REQUIRED"; the id/layer stay 'positron' for stored-preference
//      and layer-order compatibility.)
//   2. osm — OpenStreetMap standard (detailed streets, buildings, paths).
//   3. opentopo — OpenTopoMap (topographic relief).
//   4. satellite — Esri Imagery.
//
// A "Bharatlas Minimal" basemap used to be here; it was dropped because a
// featureless land/ocean canvas gives a field surveyor nothing to orient by. The
// uncluttered look belongs to the atlas's layer viewer, not to marking points.
//
// India-correct overlay: the raster tiles render the international boundary view,
// so the LGD-dissolved India outline is traced on top (always visible, above every
// basemap, below the review markers). India's claim (J&K, Ladakh, Arunachal) is
// shown correctly, mirroring bharatlas.com's view maps.
//
// Everything lives in ONE MapLibre style; switching flips basemap-layer visibility
// (never setStyle), so the overlay + review markers + reference layers survive.
import maplibregl from 'maplibre-gl';
import type { StyleSpecification, SourceSpecification, LayerSpecification } from 'maplibre-gl';

export type BasemapId = 'positron' | 'osm' | 'opentopo' | 'satellite';

export interface Basemap {
  id: BasemapId;
  name: string;
  hint: string;
  sources: Record<string, SourceSpecification>;
  layers: LayerSpecification[]; // layer ids must be unique across the whole registry
}

const ESRI_LIGHT_ATTRIB = 'Tiles © <a href="https://www.esri.com">Esri</a>: Esri, HERE, Garmin, © OpenStreetMap contributors, GIS User Community';
const OSM_ATTRIB = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const OPENTOPO_ATTRIB = 'Map data: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM · Style: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)';
const ESRI_ATTRIB = 'Tiles © <a href="https://www.esri.com">Esri</a> · Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

export const BASEMAPS: Basemap[] = [
  {
    id: 'positron',
    name: 'Light',
    hint: 'light canvas + place labels · good for orienting in the field',
    sources: {
      // Esri Light Gray Canvas — {z}/{y}/{x} like the imagery below. Base is the
      // light land/road canvas; reference is the labels overlay drawn on top.
      'lightgray-base': { type: 'raster', tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 16, attribution: ESRI_LIGHT_ATTRIB },
      'lightgray-ref': { type: 'raster', tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 16 },
    },
    layers: [
      { id: 'positron-base', type: 'raster', source: 'lightgray-base' },
      { id: 'positron-ref', type: 'raster', source: 'lightgray-ref' },
    ],
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    hint: 'detailed streets, buildings and paths · full field reference',
    sources: {
      'osm-tiles': { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: OSM_ATTRIB },
    },
    layers: [{ id: 'osm-base', type: 'raster', source: 'osm-tiles' }],
  },
  {
    id: 'opentopo',
    name: 'OpenTopoMap',
    hint: 'topographic relief + contours',
    sources: {
      'opentopo-tiles': { type: 'raster', tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`), tileSize: 256, maxzoom: 17, attribution: OPENTOPO_ATTRIB },
    },
    layers: [{ id: 'opentopo-base', type: 'raster', source: 'opentopo-tiles' }],
  },
  {
    id: 'satellite',
    name: 'Esri Imagery',
    hint: 'global satellite imagery',
    sources: {
      // Esri's REST tile service uses {z}/{y}/{x} ordering, not OSM's {z}/{x}/{y}.
      'satellite-tiles': { type: 'raster', tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: ESRI_ATTRIB },
    },
    layers: [{ id: 'satellite-base', type: 'raster', source: 'satellite-tiles' }],
  },
];

// India-correct boundary overlay — NOT a switchable basemap: always visible, above
// whichever basemap is active. The LGD-dissolved outline traces India's full,
// correct claim; a white casing under a taupe line keeps it legible over both the
// light basemaps and the dark satellite imagery.
const INDIA_OVERLAY_SOURCES: Record<string, SourceSpecification> = {
  'india-outline': { type: 'geojson', data: '/india-outline.geojson', attribution: 'India outline: LGD (dissolved states)' },
};
const INDIA_OVERLAY_LAYERS: LayerSpecification[] = [
  {
    id: 'india-claim-casing', type: 'line', source: 'india-outline',
    paint: { 'line-color': '#ffffff', 'line-opacity': 0.5, 'line-blur': 0.4, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 2.5, 8, 3.5, 12, 4.5] },
  },
  {
    id: 'india-claim', type: 'line', source: 'india-outline',
    paint: { 'line-color': '#5b4a3a', 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 8, 1.6, 12, 2.2] },
  },
];

export const DEFAULT_BASEMAP: BasemapId = 'positron'; // labelled tiles help field orientation
export const INDIA_CENTER: [number, number] = [78.9, 22];

// Accept a legacy/stored id (older sets had 'topo' and 'minimal').
export function normalizeBasemap(id?: string | null): BasemapId {
  if (id === 'topo') return 'opentopo';
  return BASEMAPS.some((b) => b.id === id) ? (id as BasemapId) : DEFAULT_BASEMAP;
}

// One style carrying every basemap's sources + layers (only the active basemap's
// layers start visible) plus the always-on India overlay on top. MapLibre's
// attribution control follows the visible layers, so only the on-screen basemap +
// the India outline are credited.
export function buildBaseStyle(active: BasemapId): StyleSpecification {
  const sources: Record<string, SourceSpecification> = { ...INDIA_OVERLAY_SOURCES };
  const layers: LayerSpecification[] = [];
  for (const b of BASEMAPS) {
    Object.assign(sources, b.sources);
    for (const lyr of b.layers) {
      const layout = { ...(lyr as { layout?: Record<string, unknown> }).layout, visibility: b.id === active ? 'visible' : 'none' };
      layers.push({ ...lyr, layout } as LayerSpecification);
    }
  }
  layers.push(...INDIA_OVERLAY_LAYERS); // above every basemap, always visible
  return { version: 8, sources, layers };
}

export function setBasemap(map: maplibregl.Map, id: BasemapId): void {
  for (const b of BASEMAPS) {
    for (const lyr of b.layers) {
      if (map.getLayer(lyr.id)) map.setLayoutProperty(lyr.id, 'visibility', b.id === id ? 'visible' : 'none');
    }
  }
  // the India overlay is never toggled — it stays visible across basemap changes
}

const KEY = 'collect:basemap';
export function getStoredBasemap(): BasemapId | null {
  try { const v = localStorage.getItem(KEY); return v && BASEMAPS.some((b) => b.id === v) ? (v as BasemapId) : null; } catch { return null; }
}
export function setStoredBasemap(id: BasemapId): void {
  try { localStorage.setItem(KEY, id); } catch { /* per-device convenience only */ }
}
