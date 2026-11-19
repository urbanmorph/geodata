// The bharatlas Minimal basemap on its own: solid ocean, Natural Earth land, the
// LGD-dissolved India fill and outline, in light or dark paint. The layer map's
// basemap registry (basemaps.ts) lists it first; /preview draws only this one,
// so it does not load the other basemaps' styles (Streets is ~40 kB).
import type { SourceSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';

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

// The minimal basemap's colours. Dark mode keeps the same layers with dark
// paint (no extra list entry): a deep ocean, a slightly lighter land and the
// India outline in the dark theme's edge colour, so the map sits inside the
// near-black chrome instead of glowing cream.
export type Scheme = 'light' | 'dark';
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

export const MINIMAL: Basemap = {
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
  };

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

/** A style holding one basemap alone, with a sprite and glyphs only if it draws icons or labels. */
export function styleFor(b: Basemap, scheme: Scheme = 'light'): StyleSpecification {
  return {
    version: 8,
    ...(b.sprite ? { sprite: b.sprite } : {}),
    ...(b.glyphs ? { glyphs: b.glyphs } : {}),
    sources: { ...b.sources },
    layers: [...basemapLayers(b, scheme)],
  };
}

export const minimalStyle = (scheme: Scheme = 'light'): StyleSpecification => styleFor(MINIMAL, scheme);
