// One rule for every layer the map must download whole (no map tiles): if the
// file is large, or would be slow on this connection, say so and let the reader
// choose before fetching it (owner, 2026-11-18: generic, never per layer).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCost, largeLoadHtml, LARGE_BYTES, SLOW_SECONDS } from '../src/large-load';
import { viewMapLink, wholeFileBytes, inlineMapLink } from '../../shared/large-load.mjs';

const MB = 1024 * 1024;

describe('loadCost', () => {
  it('is large over the size limit, whatever the connection', () => {
    expect(loadCost(LARGE_BYTES + 1).large).toBe(true);
    expect(loadCost(101 * MB, 100).large).toBe(true);
  });
  it('is large when the reported connection would take too long', () => {
    // 8 MB at 2 Mbps is about 34 s
    const c = loadCost(8 * MB, 2);
    expect(c.seconds).toBeGreaterThan(SLOW_SECONDS);
    expect(c.large).toBe(true);
  });
  it('small and quick loads straight away; unknown speed judges by size alone', () => {
    expect(loadCost(2 * MB, 10).large).toBe(false);
    expect(loadCost(8 * MB).large).toBe(false);
    expect(loadCost(8 * MB).seconds).toBeNull();
  });
  it('an unknown size never blocks', () => {
    expect(loadCost(null).large).toBe(false);
  });
});

describe('largeLoadHtml', () => {
  it('states the size and, when known, the time; offers to load or download', () => {
    const html = largeLoadHtml(loadCost(101 * MB, 5), '/api/dl/geoboundaries/IND_ADM3.geojson');
    expect(html).toMatch(/101\.0 MB/);
    expect(html).toMatch(/about 3 min on this connection/);
    expect(html).toMatch(/<button[^>]*data-load[^>]*>Load it<\/button>/);
    expect(html).toMatch(/<a[^>]*href="\/api\/dl\/geoboundaries\/IND_ADM3.geojson"[^>]*download[^>]*>Download instead<\/a>/);
  });
  it('without a speed estimate it gives the size only', () => {
    expect(largeLoadHtml(loadCost(44 * MB), '/x')).not.toMatch(/on this connection/);
  });
});

describe('the map asks before downloading a whole file', () => {
  it('confirms before fetching the GeoJSON', () => {
    const map = readFileSync(resolve(__dirname, '../src/map.ts'), 'utf8');
    const i = map.indexOf('await confirmLargeLoad(');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(map.indexOf('await fetch(layer.geojson.url)'));
  });
  it('closing the map clears any open card, so it cannot load an old layer later', () => {
    const map = readFileSync(resolve(__dirname, '../src/map.ts'), 'utf8');
    expect(map).toMatch(/export function closeLayer\(\) \{\n  clearLargeLoad\(document\);/);
    expect(readFileSync(resolve(__dirname, '../src/large-load.ts'), 'utf8')).toMatch(/clearLargeLoad\(container\);[^\n]*\n  if \(!cost\.large\)/);
  });
});

describe('the View map button says so up front', () => {
  it('a whole-file layer over the limit gets its own call to action and style', () => {
    const html = viewMapLink('/view/gb_adm3', 101 * MB, 'btn-primary', 'View map');
    expect(html).toMatch(/class="btn-primary btn-primary--large"/);
    expect(html).toMatch(/data-load-bytes="105906176"/);
    // A different call to action, not the same label with a size bolted on; the size goes in the title.
    // An hourglass marks it (the size is already in the row's downloads); the label says what it is.
    expect(html).toMatch(/<svg class="large-icon"[^>]*aria-hidden="true"[\s\S]*<\/svg>View large map<\/a>/);
    expect(html).toMatch(/title="Loads one 101\.0 MB file in full"/);
    expect(html).toMatch(/aria-label="View large map: loads one 101\.0 MB file in full"/);
  });
  it('a small whole-file layer keeps the plain button but carries its size for the speed rule', () => {
    const html = viewMapLink('/view/x', 2 * MB, 'btn-primary', 'View map');
    expect(html).not.toMatch(/--large/);
    expect(html).toMatch(/>View map</);
    expect(html).toMatch(/data-load-bytes="2097152"/);
  });
  it('tiled layers carry nothing (tiles load what is on screen)', () => {
    expect(wholeFileBytes({ pmtiles: { url: 'p', bytes: 9e9 }, geojson: { url: 'g', bytes: 9e9 } })).toBeNull();
    expect(wholeFileBytes({ geojson: { url: 'g', bytes: 7 } })).toBe(7);
  });
  it('/layers rows and community cards use it; the page applies the speed rule', () => {
    const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
    expect(read('scripts/prerender.mjs')).toMatch(/viewMapLink\(/);
    expect(read('scripts/community-card.mjs')).toMatch(/viewMapLink\(/);
    expect(read('src/layers.ts')).toMatch(/markLargeViews\(/);
  });
});

describe('inline links to a large map (alternate sources) keep their text and gain the mark', () => {
  it('large: hourglass before the name, size in title and label', () => {
    const html = inlineMapLink('/view/gb_adm3', 101 * MB, 'geoBoundaries');
    expect(html).toMatch(/^<a href="\/view\/gb_adm3" class="link--large" data-load-bytes="105906176" title="Loads one 101\.0 MB file in full"/);
    expect(html).toMatch(/aria-label="geoBoundaries: loads one 101\.0 MB file in full"/);
    expect(html).toMatch(/<svg class="large-icon"[\s\S]*<\/svg>geoBoundaries<\/a>$/);
  });
  it('small or tiled: a plain link', () => {
    expect(inlineMapLink('/view/soi_subdistricts', null, 'SOI')).toBe('<a href="/view/soi_subdistricts">SOI</a>');
  });
  it('/layers uses it for the also: links', () => {
    expect(readFileSync(resolve(__dirname, '../scripts/prerender.mjs'), 'utf8')).toMatch(/inlineMapLink\(`\/view\/\$\{l\.id\}`, wholeFileBytes\(l\), l\.source\)/);
  });
});

describe('markLargeViews (the speed rule in the page)', () => {
  it('re-labels only View map buttons, never inline links', () => {
    expect(readFileSync(resolve(__dirname, '../src/large-load.ts'), 'utf8')).toMatch(/querySelectorAll<HTMLAnchorElement>\('a\.btn-primary\[data-load-bytes\]'\)/);
  });
});
