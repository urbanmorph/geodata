// Every theme card needs a description, including themes that only appear when
// community layers use them (the production build reads them from D1; a local
// build may not show them). Tested against the catalog, not a build's output.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { THEME_DESC, THEME_GLYPH } from '../scripts/themes.mjs';

const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../catalog.json'), 'utf8')) as { categories: Record<string, string> };

describe('theme descriptions', () => {
  it('cover every catalog category, plus All and Community', () => {
    for (const id of [...Object.keys(catalog.categories), 'all', 'community']) {
      expect(THEME_DESC[id], id).toMatch(/^.{10,80}$/);
    }
  });
});

// The legend's map symbols (Direction A, survey sheet): every theme has one,
// a closed shape in the 28-unit box, and no two themes share a symbol.
describe('theme symbols', () => {
  const ids = [...Object.keys(catalog.categories), 'all', 'community'];
  it('cover every theme', () => {
    for (const id of ids) expect(THEME_GLYPH[id], id).toMatchObject({ d: expect.stringMatching(/^M/), fill: expect.any(String) });
  });
  it('are all different', () => {
    const ds = ids.map((id) => THEME_GLYPH[id].d);
    expect(new Set(ds).size).toBe(ds.length);
  });
});

