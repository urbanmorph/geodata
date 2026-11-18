// How fast /view/<id> shows its data layer: the order the map's work happens in,
// what waits for what, and what is put off until the data has drawn.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { onFirstRender, openGenerations, framesFromFile, FRAME_FROM_FILE_MAX } from '../src/map-startup';

const src = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');

type Handler = (e?: Record<string, unknown>) => void;
function fakeMap(loaded: () => boolean) {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(type: string, fn: Handler) { (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(fn); },
    off(type: string, fn: Handler) { handlers.get(type)?.delete(fn); },
    isSourceLoaded: () => loaded(),
    fire(type: string, e?: Record<string, unknown>) { for (const fn of [...(handlers.get(type) ?? [])]) fn(e); },
    count: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe('onFirstRender: the data layer has drawn', () => {
  it('fires on the frame after a tile of the source has loaded and the source is complete', () => {
    let loaded = false;
    const m = fakeMap(() => loaded);
    const cb = vi.fn();
    onFirstRender(m, 'layer', cb);
    m.fire('render');
    m.fire('sourcedata', { sourceId: 'layer', sourceDataType: 'metadata' }); // metadata, no tiles yet
    loaded = true;
    m.fire('sourcedata', { sourceId: 'layer', sourceDataType: 'metadata' });
    m.fire('render');
    expect(cb).not.toHaveBeenCalled();
    m.fire('sourcedata', { sourceId: 'basemap', tile: {} });
    m.fire('render');
    expect(cb).not.toHaveBeenCalled();
    m.fire('sourcedata', { sourceId: 'layer', tile: {} });
    expect(cb).not.toHaveBeenCalled(); // drawn on the next frame, not yet
    m.fire('render');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('waits while other tiles of the source are still loading', () => {
    let loaded = false;
    const m = fakeMap(() => loaded);
    const cb = vi.fn();
    onFirstRender(m, 'layer', cb);
    m.fire('sourcedata', { sourceId: 'layer', tile: {} });
    m.fire('render');
    expect(cb).not.toHaveBeenCalled();
    loaded = true;
    m.fire('sourcedata', { sourceId: 'layer', tile: {} });
    m.fire('render');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('falls back to idle (nothing in view to draw), fires once, and unhooks itself', () => {
    const m = fakeMap(() => false);
    const cb = vi.fn();
    onFirstRender(m, 'layer', cb);
    m.fire('idle');
    m.fire('idle');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(m.count()).toBe(0);
  });

  it('can be cancelled', () => {
    const m = fakeMap(() => true);
    const cb = vi.fn();
    const cancel = onFirstRender(m, 'layer', cb);
    cancel();
    m.fire('idle');
    expect(cb).not.toHaveBeenCalled();
    expect(m.count()).toBe(0);
  });
});

describe('openGenerations: an older open that resumes does nothing', () => {
  it('only the latest generation is current; closing ends it too', () => {
    const g = openGenerations();
    const a = g.next();
    expect(g.isCurrent(a)).toBe(true);
    const b = g.next();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
    g.next(); // a close
    expect(g.isCurrent(b)).toBe(false);
  });
});

describe('framesFromFile: which whole-file layers are read on the page to frame the view', () => {
  it('small files (every community layer without tiles) are read for their extent', () => {
    expect(framesFromFile(1_687_231)).toBe(true);
    expect(framesFromFile(FRAME_FROM_FILE_MAX)).toBe(true);
  });
  it('large files go straight to the map worker and open on India', () => {
    expect(framesFromFile(FRAME_FROM_FILE_MAX + 1)).toBe(false);
    expect(framesFromFile(46_170_854)).toBe(false);
    expect(framesFromFile(null)).toBe(false);
    expect(framesFromFile(undefined)).toBe(false);
  });
});

describe('map startup order (map.ts)', () => {
  const MAP = src('src/map.ts');
  const fnBody = (name: string) => {
    const start = MAP.indexOf(name);
    expect(start).toBeGreaterThan(-1);
    const next = MAP.indexOf('\nfunction ', start + 1);
    const nextAsync = MAP.indexOf('\nasync function ', start + 1);
    const nextExport = MAP.indexOf('\nexport ', start + 1);
    const ends = [next, nextAsync, nextExport].filter((i) => i > 0);
    return MAP.slice(start, ends.length ? Math.min(...ends) : undefined);
  };

  it('builds the map before waiting on the catalog', () => {
    const body = fnBody('export async function openLayer');
    expect(body.indexOf('new maplibregl.Map(')).toBeGreaterThan(-1);
    expect(body.indexOf('new maplibregl.Map(')).toBeLessThan(body.indexOf('await getCatalog()'));
  });

  it('starts the PMTiles header read before the style has loaded', () => {
    const body = fnBody('export async function openLayer');
    expect(body.indexOf('readPmtiles(')).toBeGreaterThan(-1);
    expect(body.indexOf('readPmtiles(')).toBeLessThan(body.indexOf('await loaded;'));
  });

  it('starts the style from the active basemap only', () => {
    expect(MAP).toContain('style: baseStyle(activeBasemap)');
    expect(MAP).not.toContain('buildBaseStyle');
    expect(MAP).not.toContain('minimal-india-boundary');
  });

  it('reads filter columns only when the Filter panel opens, never on map open', () => {
    const wire = fnBody('async function wireFilterButton');
    const open = wire.slice(wire.indexOf('const openFilterPanel'));
    const beforeOpen = wire.slice(0, wire.indexOf('const openFilterPanel'));
    expect(beforeOpen).not.toMatch(/loadFilterColumns\(layer, signal\)\s*;/);
    expect(beforeOpen).not.toContain("import('./filter')");
    expect(open).toContain('filterColumns()');
  });

  it('puts the filter chunk prefetch and the LGD overlay after the first data render', () => {
    const body = fnBody('export async function openLayer');
    const first = body.slice(body.indexOf('onFirstRender('));
    expect(body.indexOf('onFirstRender(')).toBeGreaterThan(-1);
    expect(first).toContain('loader.dismiss()');
    expect(first).toContain('addLgdOverlay(');
    expect(first).toContain("import('./filter')");
    expect(body.slice(0, body.indexOf('onFirstRender('))).not.toContain('addLgdOverlay(');
  });

  it('a failed open takes the loader down and says why', () => {
    const body = fnBody('export async function openLayer');
    expect(body).toMatch(/catch \(e\) \{[\s\S]*?loader\.dismiss\(\)[\s\S]*?showLayerError/);
  });

  it('a large GeoJSON is handed to MapLibre by URL, after the large-load card', () => {
    const body = fnBody('async function attachData');
    expect(body.indexOf('confirmLargeLoad(')).toBeGreaterThan(-1);
    expect(body.indexOf('confirmLargeLoad(')).toBeLessThan(body.indexOf('framesFromFile('));
  });
});

describe('main.ts: a failed layer open is caught', () => {
  it('wraps openLayer so an error shows instead of an unhandled rejection', () => {
    const MAIN = src('src/main.ts');
    expect(MAIN).toMatch(/try \{\s*const m = await loadMap\(\);\s*await m\.openLayer\([\s\S]*?\} catch \(e\) \{[\s\S]*?showLayerError/);
  });
});

describe('home page preconnects', () => {
  const HTML = src('index.template.html');
  it('only to the data host the map uses on open', () => {
    expect(HTML).toContain('<link rel="preconnect" href="https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev" crossorigin />');
    expect(HTML).not.toContain('tile.openstreetmap.org'); // no basemap uses it
    expect(HTML).not.toContain('preconnect" href="https://cdn.jsdelivr.net'); // only once Filter opens
    expect(HTML).not.toContain('preconnect" href="https://tiles.openfreemap.org'); // not on the default basemap
  });
});
