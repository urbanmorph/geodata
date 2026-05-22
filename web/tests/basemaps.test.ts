import { describe, it, expect, beforeEach } from 'vitest';
import {
  BASEMAPS,
  DEFAULT_BASEMAP,
  getStoredBasemap,
  setStoredBasemap,
  getBasemap,
  type BasemapId,
} from '../src/basemaps';

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
  it('exposes at least three basemap options', () => {
    expect(BASEMAPS.length).toBeGreaterThanOrEqual(3);
  });

  it('every entry has a unique id, name, hint, and raster source', () => {
    const ids = new Set<string>();
    for (const b of BASEMAPS) {
      expect(b.id).toBeTruthy();
      expect(ids.has(b.id)).toBe(false);
      ids.add(b.id);
      expect(b.name.length).toBeGreaterThan(0);
      expect(b.hint.length).toBeGreaterThan(0);
      expect(b.source.type).toBe('raster');
      // tiles[] may not be present on all source spec variants; check via cast.
      const tiles = (b.source as { tiles?: string[] }).tiles;
      expect(tiles).toBeTruthy();
      expect(tiles!.length).toBeGreaterThan(0);
    }
  });

  it('every source carries attribution (Carto and OSM both require it)', () => {
    for (const b of BASEMAPS) {
      expect(b.source.attribution).toBeTruthy();
      expect(String(b.source.attribution).length).toBeGreaterThan(5);
    }
  });

  it('tile URLs use https and reference OSM or Carto', () => {
    for (const b of BASEMAPS) {
      const tiles = (b.source as { tiles?: string[] }).tiles || [];
      for (const t of tiles) {
        expect(t).toMatch(/^https:\/\//);
        expect(t).toMatch(/openstreetmap|cartocdn/);
      }
    }
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

  it('round-trips a stored basemap id', () => {
    setStoredBasemap('voyager', storage);
    expect(getStoredBasemap(storage)).toBe('voyager');
  });

  it('ignores a stored id that no longer matches a known basemap (forward-compat)', () => {
    storage.setItem('bharatlas:basemap', 'mapbox-xyz' as unknown as BasemapId);
    expect(getStoredBasemap(storage)).toBe(DEFAULT_BASEMAP);
  });
});

describe('basemaps — getBasemap', () => {
  it('returns the matching basemap by id', () => {
    expect(getBasemap('positron').id).toBe('positron');
  });

  it('falls back to the first registered basemap for unknown ids', () => {
    // The cast is intentional — we want runtime resilience even if a stale
    // localStorage value or URL hash sneaks past the type system.
    expect(getBasemap('what-even' as BasemapId).id).toBe(BASEMAPS[0].id);
  });
});
