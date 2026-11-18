// The map toolbar's toggle buttons say what they open and whether it is open:
// aria-expanded + aria-controls on each, pointing at the surface's real id.
// No fake menus: the popovers hold plain buttons, the chosen base map pressed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const html = read('index.template.html');
const tagOf = (id: string) => html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] ?? '';

const TOGGLES: Record<string, string> = {
  'map-about': 'map-about-panel',
  'map-basemap': 'map-basemap-popover',
  'map-download': 'map-download-popover',
  'map-filter': 'map-filter-panel',
  'map-locate': 'locate-sheet',
};

describe('map toolbar toggles', () => {
  for (const [btn, target] of Object.entries(TOGGLES)) {
    it(`#${btn} has aria-expanded and aria-controls="${target}"`, () => {
      const tag = tagOf(btn);
      expect(tag).toContain('aria-expanded="false"');
      expect(tag).toContain(`aria-controls="${target}"`);
    });
  }

  it('the panels built in script carry the ids the buttons point at', () => {
    expect(read('src/map.ts')).toMatch(/panel\.id = 'map-about-panel'/);
    expect(read('src/filter.ts')).toMatch(/panel\.id = 'map-filter-panel'/);
  });

  it('no menu roles or aria-haspopup on the viewer (they promise arrow-key menus it does not have)', () => {
    for (const f of ['index.template.html', 'src/map.ts', 'src/filter.ts', 'src/locate.ts']) {
      expect(read(f), f).not.toMatch(/aria-haspopup|role="menu|menuitem/);
    }
  });

  it('the base map picker marks the chosen map pressed', () => {
    expect(read('src/map.ts')).toMatch(/aria-pressed="\$\{b\.id === activeBasemap\}"/);
  });
});
