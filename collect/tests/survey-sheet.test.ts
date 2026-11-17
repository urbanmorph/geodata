// collect wears bharatlas's "survey sheet" look (Direction A): the same edge,
// land, grid, shadow and mono tokens as bharatlas.com, read here from
// bharatlas's shared styles so the two can't drift; navy-edged controls with
// 4px corners; an offset shadow on the main action; grid paper behind pages.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: plain .mjs
import { TOKENS } from '../../web/scripts/shared-chrome.mjs';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
const darkOf = (s: string) => s.slice(s.indexOf('prefers-color-scheme: dark'));
const value = (s: string, t: string) => s.match(new RegExp(`${t}: ([^;]+);`))?.[1].trim();

describe('collect tokens match bharatlas', () => {
  for (const t of ['--bg', '--edge', '--land', '--grid']) {
    it(`${t}, light and dark`, () => {
      expect(value(css, t), `light ${t}`).toBe(value(TOKENS, t));
      expect(value(darkOf(css), t), `dark ${t}`).toBe(value(darkOf(TOKENS), t));
    });
  }
  it('--font-mono and the offset shadows', () => {
    for (const t of ['--font-mono', '--shadow', '--shadow-sm']) expect(value(css, t), t).toBe(value(TOKENS, t));
  });
});

describe('collect controls', () => {
  it('corners are 4px', () => {
    expect(value(css, '--radius')).toBe('4px');
  });
  it('buttons and inputs have the navy edge', () => {
    expect(css).toMatch(/button, \.btn \{[^}]*border: 1\.5px solid var\(--edge\)/);
    expect(css).toMatch(/input, textarea, select \{[^}]*border: 1\.5px solid var\(--edge\)/);
  });
  it('the main action casts the offset shadow', () => {
    expect(css).toMatch(/button\.primary, \.btn\.primary \{[^}]*box-shadow: var\(--shadow-sm\)/);
  });
  it('the top bar is edged in navy and pages sit on grid paper', () => {
    expect(css).toMatch(/\.topbar \{[^}]*border-bottom: 1\.5px solid var\(--edge\)/);
    expect(css).toMatch(/\nbody \{[^}]*background-image:[^}]*var\(--grid\)/);
  });
});

describe('collect over the map', () => {
  it('bottom sheets keep a navy top edge and the 4px corner', () => {
    expect(value(css, '--shadow-sheet')).toContain('var(--edge)');
    expect(css).not.toMatch(/border-radius: (18|14)px/);
  });
});

it("MapLibre's zoom buttons carry the navy edge and offset shadow", () => {
  expect(css).toMatch(/\.maplibregl-map \.maplibregl-ctrl-group:not\(:empty\) \{[^}]*border: 1\.5px solid var\(--edge\)[^}]*box-shadow: var\(--shadow-sm\)/);
});
