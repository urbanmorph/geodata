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
    const sections = [...layers.matchAll(/<section class="category-section" id="[a-z]+-([a-z-]+)" data-category="\1"/g)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(5);
  });
  it('has an index linking to each realm and theme section, with counts', () => {
    const idx = layers.match(/<nav class="theme-index"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
    const links = [...idx.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
    for (const id of links) expect(layers, id).toMatch(new RegExp(`<section class="(realm|category-section)" id="${id}"`));
    expect((idx.match(/class="theme-index__n"/g) || []).length).toBe(links.length);
    expect(links.length).toBeGreaterThan(8);
  });
  it('has no duplicate ids', () => {
    const ids = [...layers.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});

// Themes sit under three realms; a theme with layers in two realms (water:
// aquifers below, rivers on the ground) has a section in each.
describe('/layers realms', () => {
  const realms = [...layers.matchAll(/<section class="realm" id="([a-z]+)" aria-labelledby="\1-title">\s*<header class="realm__head">\s*<h2 class="realm__title" id="\1-title">([^<]+)<\/h2>\s*<p class="realm__desc">[^<]+<\/p>/g)]
    .map((m) => [m[1], m[2]]);
  // A realm's HTML, up to the next realm.
  const realmHtml = (id: string) => layers.split('<section class="realm" id="').find((s) => s.startsWith(`${id}"`)) || '';
  const sectionsIn = (id: string) => [...realmHtml(id).matchAll(/<section class="category-section" id="([a-z-]+)" data-category="([a-z-]+)"/g)].map((m) => [m[1], m[2]]);

  it('are Below ground, On the ground and In the air, in that order', () => {
    expect(realms).toEqual([['below', 'Below ground'], ['ground', 'On the ground'], ['air', 'In the air']]);
  });
  it('hold their themes as h3 sections with realm-prefixed ids', () => {
    for (const [id] of realms) {
      const secs = sectionsIn(id);
      expect(secs.length, id).toBeGreaterThan(0);
      for (const [sid, cat] of secs) expect(sid).toBe(`${id}-${cat}`);
    }
    expect(layers).toMatch(/<h3 class="category-section__title"/);
    expect(sectionsIn('below').map(([, c]) => c)).toContain('water');
    expect(sectionsIn('ground').map(([, c]) => c)).toContain('water');
  });
  it('put groundwater below, rivers on the ground and cyclones in the air', () => {
    expect(realmHtml('below')).toContain('data-id="cgwb_aquifers"');
    expect(realmHtml('ground')).not.toContain('data-id="cgwb_aquifers"');
    expect(realmHtml('air')).toContain('data-id="ndem_cyclone_tracks"');
  });
  it('keep /layers#<theme> working: the heading of the theme\'s largest section carries the plain id', () => {
    const secs = [...layers.matchAll(/<section class="category-section" id="[a-z]+-([a-z-]+)" data-category="\1">\s*<header class="category-section__head">\s*<h3 class="category-section__title"( id="[a-z-]+")?>[^<]*<\/h3>\s*<span class="category-section__count">(\d+) layer/g)]
      .map((m) => ({ cat: m[1], plain: m[2], n: Number(m[3]) }));
    const cats = [...new Set(secs.map((s) => s.cat))];
    expect(cats.length).toBeGreaterThan(5);
    for (const cat of cats) {
      const mine = secs.filter((s) => s.cat === cat);
      const tagged = mine.filter((s) => s.plain);
      expect(tagged, cat).toHaveLength(1);
      expect(tagged[0].plain).toBe(` id="${cat}"`);
      expect(tagged[0].n, cat).toBe(Math.max(...mine.map((s) => s.n)));
    }
    // Water: rivers on the ground outnumber groundwater below.
    expect(layers).toMatch(/id="ground-water"[^>]*>\s*<header class="category-section__head">\s*<h3 class="category-section__title" id="water"/);
  });
  it('separate sections with a rule only after a visible one (a hidden first theme leaves no stray border)', () => {
    const tmpl = read('layers.template.html');
    expect(tmpl).toMatch(/\.category-section:not\(\.hidden\) ~ \.category-section \{[^}]*border-top/);
    expect(tmpl).not.toContain('.category-section:first-of-type');
  });
  it('point to mugilu, the sister site, for live air and weather', () => {
    expect(realmHtml('air')).toMatch(/<a [^>]*href="https:\/\/mugilu\.live\/?"/);
    expect(layers).not.toMatch(/mugilu\.live[^"]*\?/);
  });
  it('lists every curated layer level', () => {
    const levels = new Set(catalog.layers.filter((l) => l.provenance !== 'community').map((l) => l.level));
    for (const lvl of levels) expect(layers, lvl).toMatch(new RegExp(`<section class="row row--curated[^"]*" id="${lvl}"`));
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
    for (const h of cards) expect(h).toMatch(/^\/layers(#(below|ground|air)-[a-z-]+|\?q=community)$/);
    expect(home).toMatch(/<a class="btn btn--line"[^>]*href="\/layers">See all \d+ layers<\/a>/);
  });
  it('groups the theme cards by realm, each card on its /layers section with the same count', () => {
    const groups = [...home.matchAll(/<div class="realm-group">\s*<h3 class="realm-group__title"><a href="\/layers#([a-z]+)">([^<]+)<\/a><\/h3>\s*<p class="realm-group__desc">([^<]+)<\/p>([\s\S]*?)<\/div>\s*(?=<div class="realm-group">|<p class="see-all">)/g)];
    expect(groups.map((g) => [g[1], g[2]])).toEqual([['below', 'Below ground'], ['ground', 'On the ground'], ['air', 'In the air']]);
    const realmsJson = JSON.parse(read('../shared/realms.json')).realms as { id: string; desc: string }[];
    for (const g of groups) {
      expect(g[3]).toBe(realmsJson.find((r) => r.id === g[1])!.desc);
      for (const m of g[4].matchAll(/<a class="theme-card" href="\/layers#([a-z]+)-([a-z-]+)">[\s\S]*?<span class="count">(\d+)<\/span>/g)) {
        expect(m[1], m[0]).toBe(g[1]);
        expect(layers, `${m[1]}-${m[2]}`).toMatch(new RegExp(`<section class="category-section" id="${m[1]}-${m[2]}"[^>]*>\\s*<header class="category-section__head">\\s*<h3[^>]*>[^<]*</h3>\\s*<span class="category-section__count">${m[3]} layer`));
      }
    }
    const air = groups.find((g) => g[1] === 'air')![4];
    expect(air).toContain('href="/layers#air-environment"');
    expect(air).toMatch(/see <a href="https:\/\/mugilu\.live"[^>]*>mugilu<\/a>, our sister site/);
  });
  it('searches /layer-index.json, which matches the /layers rows one for one', () => {
    // Fetched on the search's first focus, so the home page carries no list.
    expect(read('src/catalog-filter.ts')).toContain("fetch('/layer-index.json')");
    expect(read('src/main.ts')).toContain('fetchLayerIndex(');
    const index = JSON.parse(read('public/layer-index.json')) as { i: string; t: string; h: string; n?: number }[];
    // Every row, in page order, is one entry of the index, by its id.
    const rowIds = [...layers.matchAll(/<(?:section class="row row--curated[^"]*"|article class="comm-card[^"]*") id="[^"]*" data-id="([^"]+)"|<article class="comm-card[^"]*" data-id="([^"]+)"/g)]
      .map((m) => m[1] ?? m[2]);
    expect(rowIds.length).toBeGreaterThan(10);
    expect(index.map((e) => e.i)).toEqual(rowIds);
    // Curated rows open their map or their /layers anchor; community layers
    // (production builds only, from D1) open their /c/<id> page.
    // Each entry says how many layers its row holds, as the row's data-layers does.
    const rowLayers = [...layers.matchAll(/data-layers="(\d+)"/g)].map((m) => Number(m[1]));
    expect(index.filter((e) => e.n).map((e) => e.n)).toEqual(rowLayers);
    for (const e of index) expect(e.h).toMatch(/^\/view\/[a-z0-9_]+$|^\/layers#[a-z0-9_]+$|^\/c\/[A-Za-z0-9_-]+$/);
  });
  it('is back under 85 KB gzipped', async () => {
    const { gzipSync } = await import('node:zlib');
    expect(gzipSync(home).length).toBeLessThan(85 * 1024);
  });
});

describe('/layers weight', () => {
  it('filters from /layer-index.json: rows carry no search haystacks or unused data-*', () => {
    expect(read('src/layers.ts')).toContain('fetchLayerIndex(');
    for (const attr of ['data-search-primary', 'data-search-body', 'data-title', 'data-sub', 'data-href', 'data-provenance', 'data-source', 'data-level', 'data-created']) {
      expect(layers, attr).not.toContain(`${attr}=`);
    }
    // A row's theme is its section's; nothing reads an overflow flag.
    expect(layers).not.toMatch(/<(section class="row|article class="comm-card)[^>]*data-category=/);
    expect(layers).not.toContain('data-overflow');
  });
  it('draws the separators between download formats in CSS, not as markup in every row (about 600 B gzipped)', () => {
    expect(layers).not.toMatch(/class="dl-inline">(?:(?!<\/span><\/p>).)*class="dot"/s);
  });
  it('ships without source indentation (about 1 KB gzipped)', () => {
    expect(layers).not.toMatch(/\n[ \t]+/);
  });
  // CI's build, with live download counts and community entries, runs about 1.7 KB heavier than a local one
  it('is under 50 KB gzipped', async () => {
    const { gzipSync } = await import('node:zlib');
    expect(gzipSync(layers).length).toBeLessThan(50 * 1024);
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
