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
      const section = html.match(new RegExp(`data-category="${cat}"[^>]*>\\s*<header[^>]*>\\s*<h2[^>]*>[^<]*</h2>\\s*<span class="category-section__count">(\\d+) layers?`));
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

  it('links the most downloaded layers as quick links under the search', () => {
    const nav = html.match(/<nav class="popular"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
    const links = [...nav.matchAll(/href="\/view\/([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const id of links) expect(catalog.layers.some((l) => l.id === id), id).toBe(true);
  });

  it('offers Find my ward next to the search box', () => {
    expect(html).toMatch(/<button[^>]*id="find-my-ward"[^>]*>[\s\S]*?Find my ward<\/button>/);
  });
});
