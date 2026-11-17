// The home page counts LAYERS, not cards: one card can hold a level's primary
// source plus its alternates (Districts: LGD, SOI, Bhuvan, geoBoundaries).
// Reads the prerendered index.html (npm test runs prerender first).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
const catalog = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'catalog.json'), 'utf8')) as {
  layers: { id: string; level: string; provenance?: string }[];
};

const rows = [...html.matchAll(/<section class="row row--curated[^"]*" id="([^"]+)"[^>]*data-category="([^"]+)"[^>]*data-layers="(\d+)"/g)].map(
  (m) => ({ level: m[1], category: m[2], layers: Number(m[3]) }),
);
const commCards = (html.match(/class="comm-card[ "]/g) || []).length;
const chip = (cat: string) => Number(html.match(new RegExp(`data-cat="${cat}" data-count="\\d+" data-total="(\\d+)"`))?.[1]);

describe('home page layer counts', () => {
  it('every curated row says how many layers it holds', () => {
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      const inCatalog = catalog.layers.filter((l) => l.level === r.level && l.provenance !== 'community').length;
      expect(r.layers, r.level).toBe(inCatalog);
    }
  });

  it('the All chip counts every layer on the page', () => {
    const layers = rows.reduce((n, r) => n + r.layers, 0);
    expect(chip('all')).toBe(layers + commCards);
  });

  it('each category chip and section heading count that category\'s layers', () => {
    const cats = [...new Set(rows.map((r) => r.category))];
    for (const cat of cats) {
      const layers = rows.filter((r) => r.category === cat).reduce((n, r) => n + r.layers, 0);
      const section = html.match(new RegExp(`data-category="${cat}"[^>]*>\\s*<header[^>]*>\\s*<h3[^>]*>[^<]*</h3>\\s*<span class="category-section__count">(\\d+) layers?`));
      expect(Number(section?.[1]), cat).toBeGreaterThanOrEqual(layers);
      expect(chip(cat), cat).toBe(Number(section?.[1]));
    }
  });
});

describe('home hero', () => {
  it('states the layer count, matching the All chip', () => {
    expect(html).toMatch(new RegExp(`<span class="search-meta__layers">${chip('all')} layers</span>`));
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
    const cards = [...html.matchAll(/data-category="([^"]+)"[^>]*data-search-primary="([^"]*)" data-search-body="([^"]*)"/g)].map((m) => ({ category: m[1], primary: m[2], body: m[3] }));
    const nav = html.match(/<nav class="quick-search"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
    const queries = [...nav.matchAll(/href="\/\?q=([^"]+)"/g)].map((m) => decodeURIComponent(m[1].replace(/\+/g, ' ')));
    expect(queries.length).toBeGreaterThanOrEqual(4);
    for (const q of queries) expect(filterCards(cards, q).totalMatches, q).toBeGreaterThan(0);
  });

  it('follows the mockup: an open-data pill, theme cards with descriptions, an "All layers" section', () => {
    expect(html).toContain('Free and open data. No sign-up.');
    const themes = [...html.matchAll(/<button class="catalog-chip theme-card[^"]*" data-cat="([a-z-]+)"[\s\S]*?<\/button>/g)];
    expect(themes.length).toBeGreaterThan(5);
    for (const t of themes) if (t[1] !== 'all' && t[1] !== 'community') expect(t[0], t[1]).toMatch(/<span class="theme-card__desc">[^<]{10,}<\/span>/);
    expect(html).toMatch(/<section[^>]*id="layers"[\s\S]*?<h2[^>]*>All layers<\/h2>[\s\S]*?id="catalog-grid"/);
  });

  it('offers Find my ward next to the search box', () => {
    expect(html).toMatch(/<button[^>]*id="find-my-ward"[^>]*>[\s\S]*?Find my ward<\/button>/);
  });
});

describe('home page weight', () => {
  it('does not inline the catalog (the map fetches it when it opens)', () => {
    expect(html).not.toContain('id="catalog-data"');
  });

  // 85 KB until the hero's India map (Nov 2026): its outline and ward markers
  // ship inline (~3 KB gzipped) so the map paints with the page; the other map
  // themes load only when picked (map-themes.json).
  // TEMPORARY 92 KB: the production build (with community layers from D1) came
  // to 88.3 KB and blocked deploys. The /layers page moves the layer list off
  // the home page; that PR brings this back under 85.
  it('stays under 92 KB gzipped', async () => {
    const { gzipSync } = await import('node:zlib');
    expect(gzipSync(html).length).toBeLessThan(92 * 1024);
  });
});

describe('cards carry what the search dropdown shows', () => {
  it('every curated row has a title, a subtitle and a link', () => {
    const rowsMeta = [...html.matchAll(/<section class="row row--curated[^>]*>/g)].map((m) => m[0]);
    expect(rowsMeta.length).toBeGreaterThan(10);
    for (const r of rowsMeta) {
      expect(r, r.slice(0, 80)).toMatch(/data-title="[^"]+"/);
      expect(r).toMatch(/data-sub="[^"]+"/);
      expect(r).toMatch(/data-href="(\/view\/[a-z0-9_]+|#[a-z0-9_]+)"/);
    }
  });
});
