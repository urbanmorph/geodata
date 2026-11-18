// Map viewer and home search: wiring that has no pure seam of its own, pinned on the source
// (review 2026-11-18), plus the catalog error text a reader can see.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
/** The body of a top-level function in a source file. */
const fnBody = (file: string, name: string) => {
  const s = src(file);
  const start = s.indexOf(`function ${name}(`);
  expect(start, `${name} in ${file}`).toBeGreaterThan(-1);
  const end = s.indexOf('\n}\n', start);
  return s.slice(start, end);
};
/** Source with // and /* comments removed, so only code and strings remain. */
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('map filter: matches off screen keep the filter', () => {
  const body = fnBody('src/map.ts', 'applyActiveFilters');
  it('decides column presence from the tile properties, not from what is on screen', () => {
    expect(body).toContain('filterColumnsInTiles(');
    expect(body).toContain('tilePropertyKeys(');
    expect(body).not.toMatch(/if \(!features\.length\) \{\s*setDataFilters\(null\)/);
  });
  it('keeps one pending idle fit: a new keystroke replaces the last one', () => {
    expect(body).toMatch(/m\.off\('idle', pendingFit\)/);
  });
  it('with nothing in view, zooms out to the layer to find the matches', () => {
    expect(body).toContain('layerBounds');
  });
});

describe('typeahead', () => {
  const s = src('src/filter.ts');
  it('checks its own request, not whichever controller is current', () => {
    expect(s).toMatch(/const ctrl = \(abortCtrl = new AbortController\(\)\)/);
    expect(s).toContain('ctrl.signal.aborted');
    expect(s).not.toContain('abortCtrl.signal.aborted');
  });
  it('builds its SQL with the shared escaping', () => {
    expect(s).toContain('typeaheadSQL(');
    expect(s).not.toMatch(/ILIKE '%\$\{/);
  });
});

describe('locate highlight', () => {
  it('passes the tile property names to buildFeatureFilter', () => {
    expect(fnBody('src/map.ts', 'highlightAndZoom')).toMatch(/buildFeatureFilter\(props, tilePropertyKeys\(\)/);
  });
});

describe('Escape', () => {
  it('closes an open popover or sheet before the map', () => {
    const main = src('src/main.ts');
    expect(main).toContain('closeTopSurface()');
    const close = fnBody('src/map.ts', 'closeTopSurface');
    expect(close).toContain('overlayState.active');
  });
  it('on the large-map card, Escape closes the map (declining the load leaves nothing to show)', () => {
    // owner, 2026-11-18: closing only the card left an empty basemap
    expect(fnBody('src/map.ts', 'closeTopSurface')).not.toContain('.large-load');
  });
  it('home search ignores Enter while an IME is composing', () => {
    expect(src('src/main.ts')).toContain('e.isComposing');
  });
});

describe('home page a11y', () => {
  const home = src('index.template.html');
  it('the basemap and download popovers are not menus (they hold no menuitems)', () => {
    expect(home).not.toContain('role="menu"');
    expect(home).not.toContain('aria-haspopup="menu"');
    expect(home).toMatch(/id="map-basemap"[^>]*aria-controls="map-basemap-popover"/);
  });
  it('the search combobox controls the results listbox', () => {
    expect(home).toMatch(/id="catalog-search"[^>]*aria-controls="search-results"/);
    expect(home).toMatch(/id="search-results"[^>]*role="listbox"/);
  });
});

describe('visible strings', () => {
  it('locate and preview copy has no em-dashes', () => {
    for (const f of ['src/locate.ts', 'src/preview.ts']) expect(code(f), f).not.toContain('—');
  });
});

describe('getCatalog error', () => {
  it('says it plainly, with no file name or status code', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const { getCatalog } = await import('../src/catalog');
    await expect(getCatalog()).rejects.toThrow("couldn't load the layer list");
    vi.unstubAllGlobals();
  });
});
