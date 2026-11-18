// Design audit (Nov 2026), round 2: the medium and low findings left after
// #308, #310 and #311, as checks so the fixes stay fixed. Reads the built pages
// (npm test prerenders first) and sources.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { basePadding } from '../src/map-padding';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const mobileBlock = (css: string) => css.slice(css.lastIndexOf('@media (max-width: 640px)'));

describe('M1. Base map and Download open as full-width bottom sheets on phones', () => {
  const mobile = mobileBlock(read('index.template.html'));
  const popover = mobile.match(/\.map-popover \{([^}]*)\}/)?.[1] ?? '';
  it('lifts the desktop 320 px cap, so the sheet spans the screen like About and Filter', () => {
    expect(popover).toMatch(/max-width: none/);
    expect(popover).toMatch(/left: 0; right: 0/);
  });
  it('has the same grab handle as the Filter sheet', () => {
    expect(mobile).toMatch(/\.map-popover::before \{[^}]*width: 36px; height: 4px/);
  });
});

describe('/layers "compare sources" and the Filter hint use plain words', () => {
  const layers = read('layers.html');
  const altRows = [...layers.matchAll(/<div class="alt__row[^"]*">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  it('counts features in the layer\'s own noun, never "rows", and no em-dash', () => {
    expect(altRows.length).toBeGreaterThan(5);
    for (const r of altRows) {
      expect(r).not.toMatch(/\brows\b/);
      expect(r).not.toContain('—');
    }
    expect(layers).toMatch(/<span class="meta">7,143 community-development blocks · /);
  });
  it('the Filter panel explains what it downloads without naming the storage', () => {
    expect(read('src/filter.ts')).not.toMatch(/streamed from R2|parquet pages/);
  });
});

describe('L10. the first map fit is centred on phones', () => {
  it('desktop keeps room under the top bar controls', () => {
    expect(basePadding(false)).toEqual({ top: 60, bottom: 20, left: 20, right: 20 });
  });
  it('phones pad top and bottom alike (the bottom toolbar already sits below the map)', () => {
    const p = basePadding(true);
    expect(p.top).toBe(p.bottom);
  });
});
