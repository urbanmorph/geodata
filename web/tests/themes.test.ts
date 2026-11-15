// Every theme card needs a description, including themes that only appear when
// community layers use them (the production build reads them from D1; a local
// build may not show them). Tested against the catalog, not a build's output.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { THEME_DESC } from '../scripts/themes.mjs';

const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../catalog.json'), 'utf8')) as { categories: Record<string, string> };

describe('theme descriptions', () => {
  it('cover every catalog category, plus All and Community', () => {
    for (const id of [...Object.keys(catalog.categories), 'all', 'community']) {
      expect(THEME_DESC[id], id).toMatch(/^.{10,80}$/);
    }
  });
});
