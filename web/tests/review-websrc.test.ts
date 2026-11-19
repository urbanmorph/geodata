// Fixes from the web/src review (Nov 2026): pure seams tested directly, wiring
// without a seam of its own pinned on the source (as viewer-correctness.test.ts does).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { showPopupAt } from '../src/map-startup';
import { memoRetry } from '../src/memo-retry';
import { featuresFromRows } from '../src/wkb-rows';
import { fileToFC } from '../src/parse-geo';
import { validate, INDIA_BBOX } from '../src/validate';
import { whereClause } from '../src/filter-where';
import { minimalStyle } from '../src/basemap-minimal';
import { arrivalZoom } from '../src/locate-config';
import { turnstileSiteKey, TEST_SITEKEY } from '../scripts/turnstile-key.mjs';
import { parseAtParam, isWardLayer } from '../src/locate-actions';

const src = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
/** Source with // and /* comments removed, so only code and strings remain. */
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
/** The body of a top-level function in a source file. */
const fnBody = (file: string, name: string) => {
  const s = code(file);
  const start = s.search(new RegExp(`function ${name}\\(`));
  expect(start, `${name} in ${file}`).toBeGreaterThan(-1);
  return s.slice(start, s.indexOf('\n}\n', start));
};

describe('map pop-up', () => {
  it('adds the pop-up once and only moves it after that (addTo re-creates an open one)', () => {
    let open = false;
    const popup = {
      isOpen: () => open,
      setLngLat: vi.fn(function (this: unknown) { return popup; }),
      addTo: vi.fn(() => { open = true; return popup; }),
    };
    const map = {};
    showPopupAt(popup, { lng: 77, lat: 12 }, map);
    showPopupAt(popup, { lng: 77.1, lat: 12.1 }, map);
    showPopupAt(popup, { lng: 77.2, lat: 12.2 }, map);
    expect(popup.addTo).toHaveBeenCalledTimes(1);
    expect(popup.setLngLat).toHaveBeenCalledTimes(3);
  });
  it('map.ts places the pop-up through showPopupAt', () => {
    expect(code('src/map.ts')).toContain('showPopupAt(popup');
    expect(code('src/map.ts')).not.toMatch(/popup\.setLngLat\([^)]*\)\.addTo\(/);
  });
});

describe('filter panel loads DuckDB only when it needs it', () => {
  it('filter.ts has no static import of ./db (the prefetch would pull the 47 kB gz engine shim)', () => {
    expect(code('src/filter.ts')).not.toMatch(/^import[^;]*from '\.\/db'/m);
    expect(code('src/filter.ts')).toContain("import('./db')");
  });
});

describe('/preview', () => {
  it('a second success does not stack a second copy/download handler', () => {
    expect(fnBody('src/preview.ts', 'renderSuccess')).not.toContain('addEventListener(');
  });
  it('a file dropped later wins over a slower earlier one', () => {
    const body = fnBody('src/preview.ts', 'handleFile');
    expect(body).toMatch(/const seq = \+\+fileSeq/);
    expect(body.match(/if \(seq !== fileSeq\) return/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
  it('does not read and parse a GeoJSON file a second time for its CRS', () => {
    expect(fnBody('src/preview.ts', 'handleFile')).not.toContain('file.text()');
  });
  it('draws with the minimal basemap alone, not the whole basemap registry', () => {
    const p = code('src/preview.ts');
    expect(p).toContain("from './basemap-minimal'");
    expect(p).not.toContain("from './basemaps'");
  });
  it('the "already on bharatlas" banner stays hidden until a listed file is viewed', () => {
    // .view-only set display:block, which beat the [hidden] attribute: every upload showed it.
    expect(src('preview.template.html')).toMatch(/\.view-only\[hidden\]\s*\{\s*display:\s*none/);
  });
  it('takes every geometry filter from map-paint', () => {
    expect(code('src/preview.ts')).not.toContain("'geometry-type'");
  });
});

describe('fileToFC', () => {
  it('returns the parsed GeoJSON object too, so its CRS needs no second parse', async () => {
    const raw = { type: 'FeatureCollection', crs: { properties: { name: 'EPSG:3857' } }, features: [] };
    const out = await fileToFC(new File([JSON.stringify(raw)], 'x.geojson'));
    expect(out.raw).toEqual(raw);
    expect(validate(out.fc, out.raw).crs).toBe('EPSG:3857');
  });
});

describe('framing filter matches', () => {
  it('frames every geometry type, line layers included', () => {
    const body = fnBody('src/map.ts', 'applyActiveFilters');
    expect(body).toContain('featureCollectionBounds(');
    expect(body).toContain('INTERACTIVE_LAYERS');
    expect(body).not.toContain("f.geometry.type === 'Polygon'");
  });
});

describe('tile property names', () => {
  it('are read once per loaded set of tiles, not on every keystroke', () => {
    const body = fnBody('src/map.ts', 'tilePropertyKeys');
    expect(body).toMatch(/if \(tileKeys\) return tileKeys/);
    expect(code('src/map.ts')).toMatch(/tileKeys = null/);
  });
});

describe('memoRetry', () => {
  it('runs the load once while it succeeds', async () => {
    const load = vi.fn(async () => 1);
    const get = memoRetry(load);
    expect(await get()).toBe(1);
    expect(await get()).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('forgets a failure, so the next call tries again', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(2);
    const get = memoRetry(load);
    await expect(get()).rejects.toThrow('offline');
    expect(await get()).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('main.ts and layers.ts share one /layer-index.json loader', () => {
    for (const f of ['src/main.ts', 'src/layers.ts']) {
      expect(code(f), f).toContain('fetchLayerIndex(');
      expect(code(f), f).not.toContain("fetch('/layer-index.json')");
    }
  });
});

describe('featuresFromRows', () => {
  // WKB point (little endian) at 77.5, 12.9.
  const point = () => {
    const b = new ArrayBuffer(21);
    const v = new DataView(b);
    v.setUint8(0, 1);
    v.setUint32(1, 1, true);
    v.setFloat64(5, 77.5, true);
    v.setFloat64(13, 12.9, true);
    return b;
  };
  const row = (o: Record<string, unknown>) => ({ toJSON: () => ({ ...o }) });
  it('reads geometry from any byte view Arrow hands back, and turns BigInts into numbers', () => {
    const feats = featuresFromRows([
      row({ name: 'a', n: 5n, geometry: new Uint8Array(point()) }),
      row({ name: 'b', n: 6n, geometry: new DataView(point()) }),
    ]);
    expect(feats).toHaveLength(2);
    expect(feats[1]).toEqual({ geometry: { type: 'Point', coordinates: [77.5, 12.9] }, properties: { name: 'b', n: 6 } });
  });
  it('reads a geometry column named geom too (GDAL-written parquet, e.g. airports)', () => {
    const feats = featuresFromRows([row({ name: 'a', geom: new Uint8Array(point()), xmin: 1 })]);
    expect(feats).toEqual([{ geometry: { type: 'Point', coordinates: [77.5, 12.9] }, properties: { name: 'a', xmin: 1 } }]);
  });
  it('skips rows without or with malformed geometry', () => {
    expect(featuresFromRows([row({ geometry: null }), row({ geometry: new Uint8Array([1, 99, 0, 0, 0]) })])).toEqual([]);
  });
  it('parse-geo and db.ts both use it', () => {
    expect(code('src/parse-geo.ts')).toContain('readFeatures(');
    expect(code('src/db.ts')).toContain('featuresFromRows(');
  });
});

describe('validate', () => {
  it('counts a feature with several bad coordinates as one invalid feature', () => {
    const fc = {
      type: 'FeatureCollection' as const,
      features: [
        { type: 'Feature' as const, geometry: { type: 'Polygon', coordinates: [[[NaN, 1], [NaN, 2], [NaN, 3], [NaN, 1]]] }, properties: {} },
        { type: 'Feature' as const, geometry: { type: 'Point', coordinates: [77, 12] }, properties: {} },
      ],
    };
    const r = validate(fc);
    expect(r.invalid).toBe(1);
    expect(r.count).toBe(2);
  });
});

describe('one India bbox', () => {
  it('map.ts and locate-actions.ts use INDIA_BBOX', () => {
    expect(code('src/map.ts')).not.toContain('[68, 6, 98, 38]');
    expect(code('src/locate-actions.ts')).toContain('INDIA_BBOX');
    expect(parseAtParam(`${INDIA_BBOX[3]},${INDIA_BBOX[2]}`)).not.toBeNull();
    expect(parseAtParam(`${INDIA_BBOX[3] + 0.1},80`)).toBeNull();
  });
});

describe('filter SQL', () => {
  it('whereClause is the bare condition', () => {
    expect(whereClause([{ col: 'a', kind: 'bool' as const, v: true }])).toBe('"a" = TRUE');
    expect(whereClause([])).toBe('');
  });
  it('no caller strips WHERE back off', () => {
    expect(code('src/filter.ts')).not.toContain('WHERE\\s+');
  });
  it('parquet URLs go into SQL escaped', () => {
    for (const f of ['src/filter.ts', 'src/db.ts', 'src/filter-probe.ts']) {
      expect(code(f), f).not.toMatch(/FROM '\$\{/);
    }
  });
});

describe('map.ts filter typing', () => {
  it('needs no `as never` casts for filters', () => {
    expect(code('src/map.ts')).not.toMatch(/filter(: [a-zA-Z.[\]()0-9, ]+)? as never/);
    expect(code('src/map.ts')).not.toMatch(/\] as never/);
  });
});

describe('map.ts small fixes', () => {
  it('reads the LGD overlay archive through readPmtiles', () => {
    expect(fnBody('src/map.ts', 'addLgdOverlay')).toContain('readPmtiles(');
  });
  it('imports the loader verbs statically', () => {
    expect(code('src/map.ts')).not.toContain("import('./loading')");
  });
  it('fetches layer usage when the About panel first shows', () => {
    const body = fnBody('src/map.ts', 'wireAboutButton');
    expect(body.indexOf('/api/v1/usage')).toBeGreaterThan(body.indexOf('show: () =>'));
  });
});

describe('minimal basemap', () => {
  it('follows the colour scheme', () => {
    const bg = (s: ReturnType<typeof minimalStyle>) =>
      (s.layers.find((l) => l.id === 'minimal-bg') as { paint: Record<string, string> }).paint['background-color'];
    expect(bg(minimalStyle('light'))).not.toBe(bg(minimalStyle('dark')));
  });
});

describe('locate-config helpers', () => {
  it('isWardLayer', () => {
    expect(isWardLayer('wards_pune')).toBe(true);
    expect(isWardLayer('lgd_states')).toBe(false);
    expect(isWardLayer(null)).toBe(false);
  });
  it('arrivalZoom: by level, wards 13, else 11', () => {
    expect(arrivalZoom('state')).toBe(6);
    expect(arrivalZoom('wards_pune')).toBe(13);
    expect(arrivalZoom('toString')).toBe(11);
    expect(arrivalZoom(null)).toBe(11);
  });
  it('the ward test lives in one place', () => {
    for (const f of ['src/map.ts', 'src/locate-config.ts', 'src/ward-index.ts']) {
      expect(code(f), f).not.toContain('/^wards_/');
    }
  });
});

describe('Turnstile site key at build', () => {
  it('a deploy build in CI refuses the test key or no key', () => {
    expect(() => turnstileSiteKey({ CI: 'true', COMMUNITY_FROM: 'remote' })).toThrow(/TURNSTILE_SITEKEY/);
    expect(() => turnstileSiteKey({ CI: 'true', COMMUNITY_FROM: 'remote', TURNSTILE_SITEKEY: TEST_SITEKEY })).toThrow();
    expect(turnstileSiteKey({ CI: 'true', COMMUNITY_FROM: 'remote', TURNSTILE_SITEKEY: '0xreal' })).toBe('0xreal');
  });
  it('local, test and pull-request builds fall back to the test key', () => {
    expect(turnstileSiteKey({})).toBe(TEST_SITEKEY);
    expect(turnstileSiteKey({ CI: 'true' })).toBe(TEST_SITEKEY);
    expect(turnstileSiteKey({ CI: 'true', COMMUNITY_FROM: 'local' })).toBe(TEST_SITEKEY);
  });
  it('preview.ts has no fallback key of its own', () => {
    expect(code('src/preview.ts')).not.toContain('1x00000000000000000000AA');
  });
});

describe('download links carry their format', () => {
  it('/layers links name the counted format, so live counts need no text hack', () => {
    expect(src('layers.html')).toMatch(/<a href="[^"]+" download data-fmt="shapefile">shp<\/a>/);
    expect(code('src/live-counts.ts')).not.toContain("=== 'shp'");
  });
});

describe('dead code', () => {
  it('large-load.ts re-exports nothing for tests only', () => {
    expect(code('src/large-load.ts')).not.toMatch(/^export \{[^}]*LARGE_BYTES/m);
  });
  it('no unused CSS rules', () => {
    expect(src('releases.template.html')).not.toContain('.rel-meta');
    expect(src('docs.template.html')).not.toContain('.try-it');
  });
  it('the shared chunk rule matches catalog.ts only', () => {
    expect(src('vite.config.ts')).not.toContain("id.includes('src/catalog')");
  });
});
