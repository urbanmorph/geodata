// One source for the built-in level labels, units and descriptions: the home
// and /layers cards (prerender) and the /view page meta (edge) read the same
// entries, so a label fixed once is fixed everywhere.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LEVEL_META } from '../../shared/level-meta.mjs';
import { resolveLevelMeta, type CatalogLayer } from '../functions/lib/view-dataset';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('shared LEVEL_META', () => {
  it('covers the admin ladder and every built-in level', () => {
    for (const l of ['country', 'state', 'district', 'subdistrict', 'block', 'panchayat', 'village', 'pincode', 'health_facility']) {
      expect(LEVEL_META[l]?.label, l).toBeTruthy();
    }
  });

  it('every entry has a label, a unit and a description, and its meta text fits a search snippet', () => {
    for (const [k, m] of Object.entries(LEVEL_META)) {
      expect(m.label, k).toBeTruthy();
      expect(m.unit, k).toBeTruthy();
      expect(m.description, k).toBeTruthy();
      expect((m.seo_description ?? m.description).length, k).toBeLessThanOrEqual(158);
    }
  });

  it('the /view page resolves a built-in level to the shared entry', () => {
    const layer: CatalogLayer = { id: 'lgd_states', level: 'state', source: 'LGD', rows: 36 };
    expect(resolveLevelMeta(layer, undefined)).toBe(LEVEL_META.state);
  });

  it('neither prerender nor the /view page keeps its own copy', () => {
    for (const f of ['scripts/prerender.mjs', 'functions/lib/view-dataset.ts']) {
      const src = read(f);
      expect(src, f).toMatch(/from '\.\.\/\.\.\/(\.\.\/)?shared\/level-meta\.mjs'/);
      expect(src, f).not.toContain("'States (2024)'");
    }
  });
});
