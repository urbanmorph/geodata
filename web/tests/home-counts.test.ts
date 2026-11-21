// The home page counts LAYERS, not cards: one card can hold a level's primary
// source plus its alternates (Districts: LGD, SOI, Bhuvan, geoBoundaries).
// Reads the prerendered index.html and layers.html (npm test runs prerender
// first). The rows live on /layers; the home page's theme cards count them.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
const list = readFileSync(resolve(__dirname, '..', 'layers.html'), 'utf8');
const catalog = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'catalog.json'), 'utf8')) as {
  layers: { id: string; level: string; provenance?: string }[];
};

// A row's theme is that of the section it sits in.
const rows = list.split('<section class="category-section"').slice(1).flatMap((sec) => {
  const category = sec.match(/^ id="[^"]+" data-category="([^"]+)"/)![1];
  return [...sec.matchAll(/<section class="row row--curated[^"]*" id="([^"]+)"[^>]*data-layers="(\d+)"/g)].map(
    (m) => ({ level: m[1], category, layers: Number(m[2]) }),
  );
});
const commCards = (list.match(/class="comm-card[ "]/g) || []).length;
const seeAll = () => Number(html.match(/href="\/layers">See all (\d+) layers<\/a>/)?.[1]);
// A theme's count on the home page: the sum of its cards, one per realm it has
// layers in (<a class="theme-card" href="/layers#<realm>-X">…<span class="count">N</span>).
const chip = (cat: string) => [...html.matchAll(new RegExp(`href="/layers#[a-z]+-${cat}">[\\s\\S]*?<span class="count">(\\d+)</span>`, 'g'))]
  .reduce((n, m) => n + Number(m[1]), 0);

describe('home page layer counts', () => {
  it('every curated row says how many layers it holds', () => {
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      const inCatalog = catalog.layers.filter((l) => l.level === r.level && l.provenance !== 'community').length;
      expect(r.layers, r.level).toBe(inCatalog);
    }
  });

  it('"See all N layers" counts every layer on /layers', () => {
    const layers = rows.reduce((n, r) => n + r.layers, 0);
    expect(seeAll()).toBe(layers + commCards);
  });

  it('each category chip and section heading count that category\'s layers', () => {
    const cats = [...new Set(rows.map((r) => r.category))];
    for (const cat of cats) {
      const layers = rows.filter((r) => r.category === cat).reduce((n, r) => n + r.layers, 0);
      // A theme can have a section in more than one realm (water below and on the ground).
      const sections = [...list.matchAll(new RegExp(`data-category="${cat}"[^>]*>\\s*<header[^>]*>\\s*<h3[^>]*>[^<]*</h3>\\s*<span class="category-section__count">(\\d+) layers?`, 'g'))];
      const total = sections.reduce((n, m) => n + Number(m[1]), 0);
      expect(sections.length, cat).toBeGreaterThan(0);
      expect(total, cat).toBeGreaterThanOrEqual(layers);
      expect(chip(cat), cat).toBe(total);
    }
  });
});

describe('home hero', () => {
  it('states the layer count, matching "See all N layers"', () => {
    expect(html).toMatch(new RegExp(`<span class="search-meta__layers">${seeAll()} layers</span>`));
  });

  it('says when the data was last updated (newest layer fetch date)', () => {
    const newest = catalog.layers.map((l) => (l as { fetched_at?: string }).fetched_at || '').sort().pop()!.slice(0, 10);
    expect(html).toContain(`<span class="search-meta__updated">updated <time datetime="${newest}">`);
  });

  it('lists the most downloaded layers under "Most popular", with counts', () => {
    const sec = html.match(/<section[^>]*id="popular"[^>]*>([\s\S]*?)<\/section>/)?.[1] || '';
    const items = [...sec.matchAll(/<a class="popular-item" href="\/view\/([a-z0-9_]+)"><span class="popular-item__name">[^<]+<\/span><span class="popular-item__count">[^<]+<\/span><\/a>/g)].map((m) => m[1]);
    expect(items.length).toBeGreaterThanOrEqual(6);
    for (const id of items) expect(catalog.layers.some((l) => l.id === id), id).toBe(true);
  });

  it('offers quick searches that each find at least one layer', async () => {
    const { filterCards } = await import('../src/catalog-filter');
    const index = JSON.parse(readFileSync(resolve(__dirname, '..', 'public', 'layer-index.json'), 'utf8')) as { p: string; b: string }[];
    const cards = index.map((e) => ({ primary: e.p, body: e.b }));
    const nav = html.match(/<nav class="quick-search"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
    const queries = [...nav.matchAll(/href="\/\?q=([^"]+)"/g)].map((m) => decodeURIComponent(m[1].replace(/\+/g, ' ')));
    expect(queries.length).toBeGreaterThanOrEqual(4);
    for (const q of queries) expect(filterCards(cards, q).totalMatches, q).toBeGreaterThan(0);
  });

  it('says it is open, and describes every theme card it links to /layers', () => {
    expect(html).toContain('Free and open data. No sign-up.');
    // A theme with cards in two realms describes itself once, in its own realm.
    const themes = [...html.matchAll(/<a class="theme-card" href="\/layers(?:#[a-z]+-|\?q=)([a-z-]+)">[\s\S]*?<\/a>/g)];
    expect(themes.length).toBeGreaterThan(5);
    for (const cat of new Set(themes.map((t) => t[1]))) {
      if (cat === 'community') continue;
      const described = themes.filter((t) => t[1] === cat && /<span class="theme-card__desc">[^<]{10,}<\/span>/.test(t[0]));
      expect(described.length, cat).toBe(1);
    }
  });

  it('offers Find my ward next to the search box', () => {
    expect(html).toMatch(/<button[^>]*id="find-my-ward"[^>]*>[\s\S]*?Find my ward<\/button>/);
  });
});

describe('home page weight', () => {
  it('does not inline the catalog (the map fetches it when it opens)', () => {
    expect(html).not.toContain('id="catalog-data"');
  });
  // The weight budget itself is in tests/layers-page.test.ts (lean home, < 85 KB).
});

describe('the search index carries what the search dropdown shows', () => {
  it('every entry has a title, a subtitle and a link', () => {
    const index = JSON.parse(readFileSync(resolve(__dirname, '..', 'public', 'layer-index.json'), 'utf8')) as { t: string; s: string; h: string }[];
    expect(index.length).toBeGreaterThan(10);
    for (const e of index) {
      expect(e.t, JSON.stringify(e).slice(0, 80)).toBeTruthy();
      expect(e.s).toBeTruthy();
      expect(e.h).toMatch(/^(\/view\/[a-z0-9_]+|\/layers#[a-z0-9_]+|\/c\/[A-Za-z0-9_-]+)$/);
    }
  });
});
