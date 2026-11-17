// Direction A, "survey sheet": one set of tokens drives every page. Grid paper
// behind the page, 1.5px navy edges, 4px corners, a navy offset shadow on actions,
// and a system monospace for map-sheet labels. Light and dark.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: plain .mjs
import { TOKENS } from '../scripts/shared-chrome.mjs';

const page = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');

describe('survey-sheet tokens', () => {
  it('define paper, land, edge, grid, shadow and mono, in light and dark', () => {
    for (const t of ['--land', '--edge', '--grid', '--shadow', '--font-mono']) {
      expect(TOKENS, t).toContain(`${t}:`);
    }
    const dark = TOKENS.slice(TOKENS.indexOf('prefers-color-scheme: dark'));
    for (const t of ['--land', '--edge', '--grid']) expect(dark, `dark ${t}`).toContain(`${t}:`);
  });
  it('lay grid paper behind the whole window (on html, not body\'s column)', () => {
    expect(TOKENS).toMatch(/\bhtml \{[^}]*background-image:[^}]*var\(--grid\)/);
  });
  it('keep a hover / selected tint distinct from white panels', () => {
    const light = TOKENS.slice(0, TOKENS.indexOf('prefers-color-scheme: dark'));
    const val = (t: string) => light.match(new RegExp(`${t}: (#[0-9a-fA-F]{6})`))![1].toLowerCase();
    expect(val('--bg-card')).not.toBe(val('--bg-elevated'));
  });
  it('give actions a navy offset shadow and 4px corners', () => {
    expect(TOKENS).toMatch(/\.btn--fill \{[^}]*box-shadow: var\(--shadow\)/);
    expect(TOKENS).toMatch(/\.btn \{[^}]*border-radius: var\(--radius-sm\)/);
  });
  it('edge the header with the navy line, not a grey hairline', () => {
    expect(TOKENS).toMatch(/\.site-header \{[^}]*border-bottom: 1\.5px solid var\(--edge\)/);
  });
});

describe('home page', () => {
  const html = page('index.html');
  it('puts the India map beside the hero', () => {
    expect(html).toMatch(/class="home-hero"[\s\S]*data-india-map[\s\S]*<\/section>/);
    expect(readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8')).toContain("import('./india-map')");
  });
  it('draws a map symbol on every theme in the legend', () => {
    const cards = [...html.matchAll(/<a class="theme-card"[\s\S]*?<\/a>/g)].map((m) => m[0]);
    expect(cards.length).toBeGreaterThan(5);
    for (const c of cards) expect(c).toMatch(/<svg class="legend-glyph"/);
  });
});
