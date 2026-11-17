// Option B (Nov 2026): every layer lives on /layers, one section per theme with
// a theme index; the home page stays lean (hero, India map, Browse by theme)
// and searches a small inline index of the same rows instead of the full list.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
const layers = read('layers.html');
const home = read('index.html');
const catalog = JSON.parse(read('../catalog.json')) as { layers: { id: string; level: string; provenance?: string }[] };

describe('/layers', () => {
  it('is a content page titled All layers, with the search box and every theme as a section', () => {
    expect(layers).toMatch(/<body class="page"/);
    expect(layers).toMatch(/<h1 class="page-title">All layers<\/h1>/);
    expect(layers).toContain('id="catalog-search"');
    const sections = [...layers.matchAll(/<section class="category-section" id="([a-z-]+)" data-category="\1"/g)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(5);
  });
  it('has an index linking to each theme section, with counts', () => {
    const idx = layers.match(/<nav class="theme-index"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
    const links = [...idx.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
    for (const id of links) expect(layers, id).toContain(`id="${id}" data-category="${id}"`);
    expect(links.length).toBeGreaterThan(5);
  });
  it('lists every curated layer level', () => {
    const levels = new Set(catalog.layers.filter((l) => l.provenance !== 'community').map((l) => l.level));
    for (const lvl of levels) expect(layers, lvl).toContain(`data-level="${lvl}"`);
  });
  it('loads its own script, not the home page bundle', () => {
    expect(layers).toContain('src="/src/layers.ts"');
    expect(layers).not.toContain('src="/src/main.ts"');
  });
});

describe('lean home page', () => {
  it('no longer carries the layer list', () => {
    expect(home).not.toContain('id="catalog-grid"');
    expect(home).not.toMatch(/<section class="row row--curated/);
  });
  it('links the themes and an "all layers" button to /layers', () => {
    const cards = [...home.matchAll(/<a class="theme-card[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
    expect(cards.length).toBeGreaterThan(5);
    for (const h of cards) expect(h).toMatch(/^\/layers(#[a-z-]+|\?q=community)?$/);
    expect(home).toMatch(/<a class="btn btn--line"[^>]*href="\/layers">See all \d+ layers<\/a>/);
  });
  it('searches /layer-index.json, which matches the /layers rows one for one', () => {
    // Fetched on the search's first focus, so the home page carries no list.
    expect(read('src/main.ts')).toContain("fetch('/layer-index.json')");
    const index = JSON.parse(read('public/layer-index.json')) as { t: string; h: string }[];
    const rows = [...layers.matchAll(/data-search-primary="/g)].length;
    expect(index.length).toBe(rows);
    // Curated rows open their map or their /layers anchor; community layers
    // (production builds only, from D1) open their /c/<id> page.
    for (const e of index) expect(e.h).toMatch(/^\/view\/[a-z0-9_]+$|^\/layers#[a-z0-9_]+$|^\/c\/[A-Za-z0-9_-]+$/);
  });
  it('is back under 85 KB gzipped', async () => {
    const { gzipSync } = await import('node:zlib');
    expect(gzipSync(home).length).toBeLessThan(85 * 1024);
  });
});

describe('/layers is a first-class page', () => {
  it('is in the nav, the sitemap, the cache headers, the cache purge and the build', () => {
    expect(home).toMatch(/<a href="\/layers"[^>]*>Layers<\/a>/);
    expect(read('public/sitemap.xml')).toContain('<loc>https://bharatlas.com/layers</loc>');
    expect(read('public/_headers')).toMatch(/^\/layers\n\s+Cache-Control:/m);
    expect(read('scripts/purge-cache.mjs')).toContain("'/layers'");
    expect(read('vite.config.ts')).toContain("layers: resolve(__dirname, 'layers.html')");
  });
});
