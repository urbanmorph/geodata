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
// The map starts with the active basemap only (baseStyle): MapLibre's `load`,
// which gates attaching the data layer, waits on every source and the sprite in
// the style, so a hidden basemap would only slow the first draw. The viewer adds
// another basemap's sources, layers and sprite when the reader switches to it.

import type { SourceSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { MINIMAL, styleFor, type Basemap, type BasemapId, type Scheme } from './basemap-minimal';
import { LIBERTY } from '../../shared/liberty';
import { esriImagerySource } from '../../shared/esri-imagery';

const SATELLITE_TILES = esriImagerySource(import.meta.env?.VITE_ARCGIS_KEY as string | undefined);

export type { BasemapId, Basemap } from './basemap-minimal';
export { minimalPaint, basemapLayers } from './basemap-minimal';

const OPENTOPOMAP_ATTRIB =
  'Map data: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> · Style: © <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)';

export const BASEMAPS: Basemap[] = [
  MINIMAL,
  {
    id: 'liberty',
    name: 'Streets',
    hint: 'OpenStreetMap roads, buildings and landmarks · India border from LGD',
    sources: LIBERTY.sources as Record<string, SourceSpecification>,
    layers: LIBERTY.layers as unknown as LayerSpecification[],
    sprite: LIBERTY.sprite,
    glyphs: LIBERTY.glyphs,
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

const BASEMAP_LAYER_IDS = new Set(BASEMAPS.flatMap((b) => b.layers.map((l) => l.id)));

export const basemapById = (id: BasemapId): Basemap | undefined => BASEMAPS.find((b) => b.id === id);

/** The map's starting style: the active basemap alone (see the header). */
export function baseStyle(active: BasemapId, scheme: Scheme = 'light'): StyleSpecification {
  return styleFor(basemapById(active) ?? MINIMAL, scheme);
}

/** Where a basemap added later goes, given the style's layer ids in order: under
 *  the first layer that is not a basemap's, so the data and overlays stay on top. */
export function basemapInsertBefore(layerIds: string[]): string | undefined {
  return layerIds.find((id) => !BASEMAP_LAYER_IDS.has(id));
}

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

