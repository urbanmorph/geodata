// Basemap registry for the collect map, ported from bharatlas.com (web/src/
// basemaps.ts + the buildBaseStyle/setBasemap logic in web/src/map.ts). Four
// options, switchable at runtime on the map:
//
//   1. minimal — "Bharatlas Minimal": solid ocean + Natural Earth land + the
//      LGD-dissolved India outline (India-correct claim, no international labels).
//      Same-origin GeoJSON, no external tiles — fewer round-trips than raster.
//   2. positron — Esri Light Gray Canvas (light base + labels; good field
//      orientation). Default. Keyless, same host as the Esri imagery below.
//      (Was CARTO Light until CARTO started watermarking its free tiles with
//      "API KEY REQUIRED"; the id/layer stay 'positron' for stored-preference
//      and layer-order compatibility.)
//   3. opentopo — OpenTopoMap (topographic relief).
//   4. satellite — Esri Imagery.
//
// All four live in ONE MapLibre style; switching flips layer visibility (never
// setStyle), so the review markers + reference overlays survive a basemap change.
import maplibregl from 'maplibre-gl';
import type { StyleSpecification, SourceSpecification, LayerSpecification } from 'maplibre-gl';

export type BasemapId = 'minimal' | 'positron' | 'opentopo' | 'satellite';

export interface Basemap {
  id: BasemapId;
  name: string;
  hint: string;
  sources: Record<string, SourceSpecification>;
  layers: LayerSpecification[]; // layer ids must be unique across the whole registry
}

const ESRI_LIGHT_ATTRIB = 'Tiles © <a href="https://www.esri.com">Esri</a>: Esri, HERE, Garmin, © OpenStreetMap contributors, GIS User Community';
const OSM_IN_ATTRIB = 'India boundary: <a href="https://github.com/osm-in/mapbox-gl-styles" target="_blank" rel="noopener">osm-in</a> · © OpenStreetMap contributors (ODbL)';
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
    id: 'minimal',
    name: 'Bharatlas Minimal',
    hint: 'India-correct boundaries · land + ocean · no labels',
    sources: {
      'world-land': { type: 'geojson', data: '/world-land.geojson', attribution: 'Land: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> (public domain)' },
      'india-boundary': { type: 'geojson', data: '/india-boundary.geojson', attribution: OSM_IN_ATTRIB },
      'india-outline': { type: 'geojson', data: '/india-outline.geojson', attribution: 'India outline: LGD (dissolved states)' },
    },
    layers: [
      { id: 'minimal-bg', type: 'background', paint: { 'background-color': '#dee5e8' } },
      { id: 'minimal-land', type: 'fill', source: 'world-land', paint: { 'fill-color': '#f5f3ef', 'fill-outline-color': '#d0c8be' } },
      { id: 'minimal-india-fill', type: 'fill', source: 'india-outline', paint: { 'fill-color': '#f5f3ef' } },
      { id: 'minimal-india-outline', type: 'line', source: 'india-outline', paint: { 'line-color': '#7d6a5a', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.0, 10, 2.0], 'line-opacity': 0.9 } },
    ],
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

export const DEFAULT_BASEMAP: BasemapId = 'positron'; // labelled tiles help field orientation
export const INDIA_CENTER: [number, number] = [78.9, 22];

// Accept a legacy/stored id (the old set was positron/satellite/topo).
export function normalizeBasemap(id?: string | null): BasemapId {
  if (id === 'topo') return 'opentopo';
  return BASEMAPS.some((b) => b.id === id) ? (id as BasemapId) : DEFAULT_BASEMAP;
}

// One style carrying every basemap's sources + layers; only the active basemap's
// layers start visible. MapLibre's attribution control follows the visible layers,
// so only the on-screen basemap is credited.
export function buildBaseStyle(active: BasemapId): StyleSpecification {
  const sources: Record<string, SourceSpecification> = {};
  const layers: LayerSpecification[] = [];
  for (const b of BASEMAPS) {
    Object.assign(sources, b.sources);
    for (const lyr of b.layers) {
      const layout = { ...(lyr as { layout?: Record<string, unknown> }).layout, visibility: b.id === active ? 'visible' : 'none' };
      layers.push({ ...lyr, layout } as LayerSpecification);
    }
  }
  return { version: 8, sources, layers };
}

export function setBasemap(map: maplibregl.Map, id: BasemapId): void {
  for (const b of BASEMAPS) {
    for (const lyr of b.layers) {
      if (map.getLayer(lyr.id)) map.setLayoutProperty(lyr.id, 'visibility', b.id === id ? 'visible' : 'none');
    }
  }
}

const KEY = 'collect:basemap';
export function getStoredBasemap(): BasemapId | null {
  try { const v = localStorage.getItem(KEY); return v && BASEMAPS.some((b) => b.id === v) ? (v as BasemapId) : null; } catch { return null; }
}
export function setStoredBasemap(id: BasemapId): void {
  try { localStorage.setItem(KEY, id); } catch { /* per-device convenience only */ }
}
