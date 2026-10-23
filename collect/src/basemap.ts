// Basemap registry for the collect map. Four switchable basemaps, plus a
// persistent India-correct boundary overlay drawn on top of every one:
//
//   1. liberty — "Streets": OpenFreeMap Liberty (OpenStreetMap roads, buildings,
//      landmarks, place names), vector, trimmed for India in shared/liberty.ts so
//      it draws no borders of its own. Default: someone marking a point needs
//      roads and buildings to place it against. (Replaced Esri Light Gray, which
//      has no licence for keyless use; before that CARTO Light, which now
//      watermarks its free tiles. A stored 'positron' maps here.)
//   2. osm — OpenStreetMap standard (detailed streets, buildings, paths).
//   3. opentopo — OpenTopoMap (topographic relief).
//   4. satellite — Esri World Imagery, only when the build has an ArcGIS key.
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
import { LIBERTY } from '../../shared/liberty';
import { esriImagerySource } from '../../shared/esri-imagery';

const SATELLITE_TILES = esriImagerySource(import.meta.env?.VITE_ARCGIS_KEY as string | undefined);

export type BasemapId = 'liberty' | 'osm' | 'opentopo' | 'satellite';

export interface Basemap {
  id: BasemapId;
  name: string;
  hint: string;
  sources: Record<string, SourceSpecification>;
  layers: LayerSpecification[]; // layer ids must be unique across the whole registry
}

const OSM_ATTRIB = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const OPENTOPO_ATTRIB = 'Map data: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM · Style: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)';

export const BASEMAPS: Basemap[] = [
  {
    id: 'liberty',
    name: 'Streets',
    hint: 'roads, buildings, landmarks and place names · OpenStreetMap',
    sources: LIBERTY.sources as Record<string, SourceSpecification>,
    layers: LIBERTY.layers as unknown as LayerSpecification[],
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
  // Satellite only with an ArcGIS key (shared/esri-imagery.ts): keyless Esri use is not licensed.
  ...(SATELLITE_TILES
    ? [{
        id: 'satellite' as const,
        name: 'Esri Imagery',
        hint: 'global satellite imagery · online only',
        sources: { 'satellite-tiles': SATELLITE_TILES as SourceSpecification },
        layers: [{ id: 'satellite-base', type: 'raster', source: 'satellite-tiles' } as LayerSpecification],
      }]
    : []),
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

export const DEFAULT_BASEMAP: BasemapId = 'liberty'; // roads and buildings to mark against
export const INDIA_CENTER: [number, number] = [78.9, 22];

// Accept a legacy/stored id (older sets had 'topo' and 'minimal'; 'positron' was the
// light default, now Streets). Maps' stored author basemap may still say 'positron'.
export function normalizeBasemap(id?: string | null): BasemapId {
  if (id === 'topo') return 'opentopo';
  if (id === 'positron') return 'liberty';
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
  // Streets' labels and icons; the raster basemaps need neither.
  return { version: 8, glyphs: LIBERTY.glyphs, sprite: LIBERTY.sprite, sources, layers };
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
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'positron') return 'liberty'; // the retired light default
    return v && BASEMAPS.some((b) => b.id === v) ? (v as BasemapId) : null;
  } catch { return null; }
}
export function setStoredBasemap(id: BasemapId): void {
  try { localStorage.setItem(KEY, id); } catch { /* per-device convenience only */ }
}
