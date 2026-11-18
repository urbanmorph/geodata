import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BASEMAPS,
  DEFAULT_BASEMAP,
  baseStyle,
  basemapInsertBefore,
  getStoredBasemap,
  setStoredBasemap,
  minimalPaint,
  type BasemapId,
} from '../src/basemaps';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIBERTY } from '../../shared/liberty';

class MockStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return Array.from(this.m.keys())[i] ?? null; }
}

describe('basemaps — registry', () => {
  it('exposes minimal (default) + Streets (Liberty) + OpenTopoMap, and satellite when there is an ArcGIS key', () => {
    const ids = BASEMAPS.map((b) => b.id);
    expect(ids.slice(0, 3)).toEqual(['minimal', 'liberty', 'opentopo']);
    expect(ids.length === 3 || ids[3] === 'satellite').toBe(true);
  });

  it('opentopo uses OpenTopoMap community tiles (no API key, CC-BY-SA)', () => {
    const ot = BASEMAPS.find((b) => b.id === 'opentopo');
    expect(ot).toBeTruthy();
    for (const src of Object.values(ot!.sources)) {
      const tiles = (src as { tiles?: string[] }).tiles || [];
      expect(tiles.length).toBeGreaterThan(0);
      for (const t of tiles) {
        expect(t).toMatch(/^https:\/\//);
        expect(t).toContain('opentopomap.org');
      }
      const attr = String((src as { attribution?: string }).attribution || '');
      expect(attr.toLowerCase()).toContain('opentopomap');
      expect(attr.toLowerCase()).toContain('openstreetmap');
    }
  });

  it('satellite, when offered, uses Esri World Imagery through the keyed service, never the keyless one', () => {
    const sat = BASEMAPS.find((b) => b.id === 'satellite');
    if (!sat) return; // no ArcGIS key in this build: the option is simply not offered
    const tiles = Object.values(sat.sources).flatMap((src) => (src as { tiles?: string[] }).tiles || []);
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      expect(t.startsWith('https://ibasemaps-api.arcgis.com/')).toBe(true);
      expect(t).toContain('{z}/{y}/{x}'); // Esri REST ordering
      expect(t).toMatch(/\?token=.+/);
    }
  });

  it('nothing is fetched from the keyless Esri service any more', () => {
    expect(JSON.stringify(BASEMAPS)).not.toContain('services.arcgisonline.com');
  });

  it('every entry has a unique id, name, hint, and non-empty sources + layers', () => {
    const ids = new Set<string>();
    for (const b of BASEMAPS) {
      expect(b.id).toBeTruthy();
      expect(ids.has(b.id)).toBe(false);
      ids.add(b.id);
      expect(b.name.length).toBeGreaterThan(0);
      expect(b.hint.length).toBeGreaterThan(0);
      expect(Object.keys(b.sources).length).toBeGreaterThan(0);
      expect(b.layers.length).toBeGreaterThan(0);
    }
  });

  it('layer ids are globally unique across all basemaps (style cannot carry duplicates)', () => {
    const layerIds = new Set<string>();
    for (const b of BASEMAPS) {
      for (const lyr of b.layers) {
        expect(layerIds.has(lyr.id)).toBe(false);
        layerIds.add(lyr.id);
      }
    }
  });

  it('the minimal basemap has no external network calls (no raster tiles)', () => {
    // The whole point of "minimal" is that it doesn't depend on a third-party
    // tile provider that might serve disputed-border labels. Sources are
    // same-origin GeoJSON only (Natural Earth land + osm-in India boundary).
    const minimal = BASEMAPS.find((b) => b.id === 'minimal');
    expect(minimal).toBeTruthy();
    for (const src of Object.values(minimal!.sources)) {
      expect(src.type).not.toBe('raster');
      expect(src.type).not.toBe('raster-dem');
      if (src.type === 'geojson') {
        const data = (src as { data: unknown }).data;
        if (typeof data === 'string') expect(data).toMatch(/^\//);
      }
    }
  });

  // (The Mapzen Terrarium topo basemap was prototyped and dropped; see the
  // basemaps.ts header comment for the rationale. If we re-add a topo
  // option later, the matching test belongs here.)

  it('Streets is the shared, India-trimmed OpenFreeMap Liberty basemap (OSM roads, buildings, landmarks)', () => {
    const streets = BASEMAPS.find((b) => b.id === 'liberty');
    expect(streets).toBeTruthy();
    expect(streets!.sources).toEqual(LIBERTY.sources);
    expect(streets!.layers).toEqual(LIBERTY.layers);
    expect(streets!.hint.toLowerCase()).toMatch(/roads.*buildings/);
  });

  it('no basemap depends on CARTO, whose free tiles now carry an "API KEY REQUIRED" watermark', () => {
    expect(JSON.stringify(BASEMAPS)).not.toContain('cartocdn');
  });


  it('every external source carries attribution (OSM, OpenFreeMap and Esri all require it)', () => {
    for (const b of BASEMAPS) {
      for (const src of Object.values(b.sources)) {
        expect((src as { attribution?: string }).attribution).toBeTruthy();
        expect(String((src as { attribution?: string }).attribution).length).toBeGreaterThan(5);
      }
    }
  });
});

// MapLibre's \`load\`, which gates attaching the data layer, waits for every
// source's metadata and the sprite in the style. So the first style carries only
// the active basemap; another one is added when the reader switches to it.
describe('basemaps — the starting style', () => {
  const sourceIds = (id: BasemapId) => Object.keys(baseStyle(id).sources);
  const layerIds = (id: BasemapId) => baseStyle(id).layers.map((l) => l.id);

  it('carries only the active basemap (no hidden sources to wait on)', () => {
    for (const b of BASEMAPS) {
      expect(sourceIds(b.id)).toEqual(Object.keys(b.sources));
      expect(layerIds(b.id)).toEqual(b.layers.map((l) => l.id));
    }
  });

  it('asks for the Streets sprite and glyphs only when Streets is the active basemap', () => {
    expect(baseStyle('liberty').sprite).toBe(LIBERTY.sprite);
    expect(baseStyle('liberty').glyphs).toBe(LIBERTY.glyphs);
    for (const id of ['minimal', 'opentopo'] as const) {
      expect(baseStyle(id).sprite).toBeUndefined();
      expect(baseStyle(id).glyphs).toBeUndefined();
    }
  });

  it('the default minimal map fetches nothing from OpenFreeMap', () => {
    expect(JSON.stringify(baseStyle('minimal'))).not.toContain('openfreemap');
  });

  it('drops the india-boundary source that no layer draws', () => {
    expect(sourceIds('minimal')).not.toContain('india-boundary');
    expect(sourceIds('minimal').sort()).toEqual(['india-outline', 'world-land']);
  });

  it('a basemap added later goes under the first layer that is not a basemap layer', () => {
    const minimal = layerIds('minimal');
    expect(basemapInsertBefore([...minimal, 'fill', 'line-halo', 'lgd-overlay-line'])).toBe('fill');
    expect(basemapInsertBefore(['minimal-bg', 'fill', 'minimal-india-outline', 'line-halo'])).toBe('fill');
    expect(basemapInsertBefore(minimal)).toBeUndefined(); // no data yet: on top is fine
    expect(basemapInsertBefore([])).toBeUndefined();
  });
});

describe('basemaps — persistence', () => {
  let storage: MockStorage;
  beforeEach(() => {
    storage = new MockStorage();
  });

  it('returns DEFAULT_BASEMAP when nothing is stored', () => {
    expect(getStoredBasemap(storage)).toBe(DEFAULT_BASEMAP);
  });

  it('defaults to the minimal India-correct view', () => {
    expect(DEFAULT_BASEMAP).toBe('minimal');
  });

  it('round-trips a stored basemap id', () => {
    setStoredBasemap('liberty', storage);
    expect(getStoredBasemap(storage)).toBe('liberty');
  });

  it('moves someone who had picked the retired Carto Light to Streets', () => {
    storage.setItem('bharatlas:basemap', 'positron');
    expect(getStoredBasemap(storage)).toBe('liberty');
  });

  it('ignores a stored id that no longer matches a known basemap (forward-compat)', () => {
    // 'voyager' is a stale id from a prior version of the registry — proves
    // we degrade gracefully when the registry shrinks across deploys.
    storage.setItem('bharatlas:basemap', 'voyager' as unknown as BasemapId);
    expect(getStoredBasemap(storage)).toBe(DEFAULT_BASEMAP);
  });
});

// Dark mode: the minimal basemap follows the page theme, so the map is not a
// bright cream rectangle inside near-black chrome. Same layers, dark paint; the
// list keeps one "bharatlas Minimal" entry (no new option to choose).
describe('basemaps: minimal follows the colour scheme', () => {
  const paintOf = (scheme: 'light' | 'dark', id: string) =>
    (baseStyle('minimal', scheme).layers.find((l) => l.id === id) as { paint: Record<string, unknown> }).paint;
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
  };

  it('light is the default and unchanged', () => {
    expect(baseStyle('minimal')).toEqual(baseStyle('minimal', 'light'));
    expect(paintOf('light', 'minimal-bg')['background-color']).toBe('#dee5e8');
  });

  it('dark paints a dark ocean and land, with a light India outline', () => {
    expect(lum(paintOf('dark', 'minimal-bg')['background-color'] as string)).toBeLessThan(0.2);
    expect(lum(paintOf('dark', 'minimal-land')['fill-color'] as string)).toBeLessThan(0.2);
    expect(paintOf('dark', 'minimal-india-fill')['fill-color']).toBe(paintOf('dark', 'minimal-land')['fill-color']);
    expect(lum(paintOf('dark', 'minimal-india-outline')['line-color'] as string)).toBeGreaterThan(0.6);
  });

  it('land and ocean stay distinguishable in dark', () => {
    const d = Math.abs(lum(paintOf('dark', 'minimal-bg')['background-color'] as string) - lum(paintOf('dark', 'minimal-land')['fill-color'] as string));
    expect(d).toBeGreaterThan(0.02);
  });

  it('minimalPaint lists every paint change between the schemes, for a live switch', () => {
    const dark = minimalPaint('dark');
    for (const [layer, prop, value] of dark) expect(paintOf('dark', layer)[prop]).toEqual(value);
    for (const [layer, prop, value] of minimalPaint('light')) expect(paintOf('light', layer)[prop]).toEqual(value);
    expect(dark.length).toBeGreaterThanOrEqual(4);
  });

  it('other basemaps do not change with the scheme', () => {
    expect(baseStyle('liberty', 'dark')).toEqual(baseStyle('liberty', 'light'));
  });

  it('the map reads the page scheme and follows a change', () => {
    const MAP = readFileSync(resolve(__dirname, '../src/map.ts'), 'utf8');
    expect(MAP).toContain("matchMedia('(prefers-color-scheme: dark)')");
    expect(MAP).toMatch(/minimalPaint\(/);
  });
});

describe('basemaps — satellite follows the ArcGIS key', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  const load = async (key: string) => {
    vi.stubEnv('VITE_ARCGIS_KEY', key);
    vi.resetModules();
    return (await import('../src/basemaps')).BASEMAPS.map((b) => b.id);
  };
  it('is offered with a key, and left out without one', async () => {
    expect(await load('a-key')).toContain('satellite');
    expect(await load('')).not.toContain('satellite');
  });
  it('someone who had chosen satellite gets the default when the build has no key', async () => {
    vi.stubEnv('VITE_ARCGIS_KEY', '');
    vi.resetModules();
    const m = await import('../src/basemaps');
    const storage = new MockStorage();
    storage.setItem('bharatlas:basemap', 'satellite');
    expect(m.getStoredBasemap(storage)).toBe(m.DEFAULT_BASEMAP);
  });
});

