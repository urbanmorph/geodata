import { describe, it, expect } from 'vitest';
import { BASEMAPS, buildBaseStyle, normalizeBasemap, DEFAULT_BASEMAP, type BasemapId } from '../src/basemap';

describe('normalizeBasemap', () => {
  it('maps the legacy "topo" id to opentopo', () => {
    expect(normalizeBasemap('topo')).toBe('opentopo');
  });
  it('keeps a valid id', () => {
    expect(normalizeBasemap('satellite')).toBe('satellite');
    expect(normalizeBasemap('minimal')).toBe('minimal');
  });
  it('falls back to the default for unknown / empty', () => {
    expect(normalizeBasemap('nope')).toBe(DEFAULT_BASEMAP);
    expect(normalizeBasemap(null)).toBe(DEFAULT_BASEMAP);
    expect(normalizeBasemap(undefined)).toBe(DEFAULT_BASEMAP);
  });
});

describe('buildBaseStyle', () => {
  it('carries every basemap\'s layers, with only the active one visible', () => {
    const active: BasemapId = 'minimal';
    const style = buildBaseStyle(active);
    const ids = style.layers.map((l) => l.id);
    for (const b of BASEMAPS) for (const l of b.layers) expect(ids).toContain(l.id);
    const activeIds = new Set(BASEMAPS.find((b) => b.id === active)!.layers.map((l) => l.id));
    for (const l of style.layers) {
      const vis = (l as { layout?: { visibility?: string } }).layout?.visibility;
      expect(vis).toBe(activeIds.has(l.id) ? 'visible' : 'none');
    }
  });
  it('layer ids are unique across the whole registry (required for the single style)', () => {
    const ids = BASEMAPS.flatMap((b) => b.layers.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('no CARTO dependency', () => {
  // CARTO started serving an "API KEY REQUIRED" watermark on its free raster
  // tiles (light_all). Guard so no basemap silently depends on cartocdn again.
  it('no basemap tiles point at cartocdn', () => {
    const tiles = BASEMAPS.flatMap((b) =>
      Object.values(b.sources).flatMap((s) => ((s as { tiles?: string[] }).tiles) || []),
    );
    for (const t of tiles) expect(t).not.toContain('cartocdn');
  });
});

describe('Esri Imagery tile ordering', () => {
  // Esri's REST tile service is {z}/{y}/{x}, not OSM's {z}/{x}/{y}. Guard it.
  it('satellite source uses y-before-x', () => {
    const sat = BASEMAPS.find((b) => b.id === 'satellite')!;
    const tiles = (sat.sources['satellite-tiles'] as { tiles: string[] }).tiles;
    expect(tiles[0]).toContain('{z}/{y}/{x}');
  });
});
