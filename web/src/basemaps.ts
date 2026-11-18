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
  // IDs must be unique across all basemaps in the registry: once the reader
  // has switched, the style carries several, only the active one visible.
  sources: Record<string, SourceSpecification>;
  layers: LayerSpecification[];
  // Icons and label fonts, for a basemap that draws them (Streets).
  sprite?: string;
  glyphs?: string;
};

const OPENTOPOMAP_ATTRIB =
  'Map data: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> · Style: © <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)';

// The minimal basemap's colours. Dark mode keeps the same layers with dark
// paint (no extra list entry): a deep ocean, a slightly lighter land and the
// India outline in the dark theme's edge colour, so the map sits inside the
// near-black chrome instead of glowing cream.
type Scheme = 'light' | 'dark';
const MINIMAL_COLORS: Record<Scheme, { ocean: string; land: string; coast: string; outline: string }> = {
  light: { ocean: '#dee5e8', land: '#f5f3ef', coast: '#d0c8be', outline: '#7d6a5a' },
  dark: { ocean: '#0e141b', land: '#1f242b', coast: '#363d47', outline: '#c8d0e3' },
};

/** Every paint value of the minimal basemap that differs by scheme, as
 *  [layer id, paint property, value]: the starting style and a live theme switch use it. */
export function minimalPaint(scheme: Scheme): Array<[string, string, string]> {
  const c = MINIMAL_COLORS[scheme];
  return [
    ['minimal-bg', 'background-color', c.ocean],
    ['minimal-land', 'fill-color', c.land],
    ['minimal-land', 'fill-outline-color', c.coast],
    ['minimal-india-fill', 'fill-color', c.land],
    ['minimal-india-outline', 'line-color', c.outline],
  ];
}

export const BASEMAPS: Basemap[] = [
  {
    id: 'minimal',
    name: 'bharatlas Minimal',
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
          'background-color': MINIMAL_COLORS.light.ocean,
        },
      },
      {
        id: 'minimal-land',
        type: 'fill',
        source: 'world-land',
        paint: {
          'fill-color': MINIMAL_COLORS.light.land, // warm off-white
          'fill-outline-color': MINIMAL_COLORS.light.coast, // subtle taupe coast outline
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
          'fill-color': MINIMAL_COLORS.light.land,
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
          'line-color': MINIMAL_COLORS.light.outline,
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.0, 10, 2.0],
          'line-opacity': 0.9,
        },
      },
      // The osm-in claim lines (/india-boundary.geojson) are no longer drawn:
      // the LGD-dissolved outline already traces India's claim (J&K, Ladakh,
      // Arunachal via the state polygons).
    ],
  },
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

/** A basemap's layers for a colour scheme: only the minimal basemap changes. */
export function basemapLayers(b: Basemap, scheme: Scheme = 'light'): LayerSpecification[] {
  if (b.id !== 'minimal' || scheme === 'light') return b.layers;
  const paint = minimalPaint(scheme);
  return b.layers.map((l) => {
    const changes = paint.filter(([id]) => id === l.id);
    if (!changes.length) return l;
    const p = { ...(l as { paint?: Record<string, unknown> }).paint };
    for (const [, prop, value] of changes) p[prop] = value;
    return { ...l, paint: p } as LayerSpecification;
  });
}

/** The map's starting style: the active basemap alone, with a sprite and glyphs only if it draws icons or labels. */
export function baseStyle(active: BasemapId, scheme: Scheme = 'light'): StyleSpecification {
  const b = basemapById(active) ?? basemapById(DEFAULT_BASEMAP)!;
  return {
    version: 8,
    ...(b.sprite ? { sprite: b.sprite } : {}),
    ...(b.glyphs ? { glyphs: b.glyphs } : {}),
    sources: { ...b.sources },
    layers: [...basemapLayers(b, scheme)],
  };
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

