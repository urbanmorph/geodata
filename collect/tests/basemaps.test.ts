import { describe, it, expect } from 'vitest';
import { BASEMAPS, buildBaseStyle, normalizeBasemap, DEFAULT_BASEMAP, type BasemapId } from '../src/basemap';

describe('normalizeBasemap', () => {
  it('maps the legacy "topo" id to opentopo', () => {
    expect(normalizeBasemap('topo')).toBe('opentopo');
  });
  it('keeps a valid id', () => {
    expect(normalizeBasemap('satellite')).toBe('satellite');
    expect(normalizeBasemap('osm')).toBe('osm');
  });
  it('falls back to the default for unknown / empty (incl. the retired "minimal")', () => {
    expect(normalizeBasemap('minimal')).toBe(DEFAULT_BASEMAP); // basemap was removed
    expect(normalizeBasemap('nope')).toBe(DEFAULT_BASEMAP);
    expect(normalizeBasemap(null)).toBe(DEFAULT_BASEMAP);
    expect(normalizeBasemap(undefined)).toBe(DEFAULT_BASEMAP);
  });
});

const allBasemapLayerIds = new Set(BASEMAPS.flatMap((b) => b.layers.map((l) => l.id)));

describe('buildBaseStyle', () => {
  it('carries every basemap\'s layers, with only the active basemap visible', () => {
    const active: BasemapId = 'satellite';
    const style = buildBaseStyle(active);
    const ids = style.layers.map((l) => l.id);
    for (const b of BASEMAPS) for (const l of b.layers) expect(ids).toContain(l.id);
    const activeIds = new Set(BASEMAPS.find((b) => b.id === active)!.layers.map((l) => l.id));
    for (const l of style.layers) {
      if (!allBasemapLayerIds.has(l.id)) continue; // skip the always-on India overlay
      const vis = (l as { layout?: { visibility?: string } }).layout?.visibility;
      expect(vis).toBe(activeIds.has(l.id) ? 'visible' : 'none');
    }
  });
  it('layer ids are unique across the whole registry (required for the single style)', () => {
    const ids = buildBaseStyle('positron').layers.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('India-correct overlay', () => {
  // bharatlas view maps always trace India's LGD-dissolved claim on top of the
  // basemap. It must be present + visible whatever basemap is active (the raster
  // tiles render the international boundary view).
  for (const active of ['positron', 'osm', 'opentopo', 'satellite'] as BasemapId[]) {
    it(`draws the India outline over the ${active} basemap`, () => {
      const style = buildBaseStyle(active);
      const claim = style.layers.filter((l) => l.id === 'india-claim' || l.id === 'india-claim-casing');
      expect(claim).toHaveLength(2);
      for (const l of claim) {
        const vis = (l as { layout?: { visibility?: string } }).layout?.visibility;
        expect(vis === undefined || vis === 'visible').toBe(true); // never hidden
      }
      // the outline draws on top of every basemap layer
      const ids = style.layers.map((l) => l.id);
      const lastBasemapIdx = Math.max(...[...allBasemapLayerIds].map((id) => ids.indexOf(id)));
      expect(ids.indexOf('india-claim-casing')).toBeGreaterThan(lastBasemapIdx);
      expect(ids.indexOf('india-claim')).toBeGreaterThan(lastBasemapIdx);
    });
  }
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
