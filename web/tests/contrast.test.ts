// WCAG 2.2 AA for every colour pair the token module allows, in both themes,
// on both sites (bharatlas.com and collect emit the same shared/tokens.mjs,
// see design-tokens.test.ts). A palette tweak that drops any pair below the
// line fails here: every text role on every surface role (4.5:1), text on the
// saffron fill (4.5:1), control edges and the focus ring on every surface (3:1).
import { describe, it, expect } from 'vitest';
import { COLOR_ROLES, COLORS, contrast } from '../../shared/tokens.mjs';

const AA_TEXT = 4.5; // normal-size text
const AA_UI = 3; // UI components / large text (1.4.11, 1.4.3 large)
const byKind = (k: string) => COLOR_ROLES.filter((r) => r.kind === k).map((r) => r.name);
const SURFACES = byKind('surface');

describe('WCAG contrast util', () => {
  it('matches known reference ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrast('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5); // canonical AA grey
  });
});

describe('every role has a kind the matrix checks', () => {
  it('text, surface, fill, on-fill, edge or decor', () => {
    for (const r of COLOR_ROLES) expect(['text', 'surface', 'fill', 'on-fill', 'edge', 'decor'], r.name).toContain(r.kind);
    expect(byKind('text').length).toBeGreaterThan(8);
    expect(SURFACES).toEqual(['--bg', '--bg-elevated', '--bg-card', '--land', '--accent-tint']);
  });
});

for (const mode of ['light', 'dark'] as const) {
  describe(`design tokens meet WCAG 2.2 AA (${mode})`, () => {
    const c = COLORS[mode];
    it('every text colour on every surface (status colours included)', () => {
      const fails: string[] = [];
      for (const t of byKind('text')) for (const s of SURFACES) {
        const r = contrast(c[t], c[s]);
        if (r < AA_TEXT) fails.push(`${t} on ${s}: ${r.toFixed(2)}`);
      }
      expect(fails).toEqual([]);
    });
    it('button text on the saffron fill and its hover', () => {
      for (const f of byKind('fill')) expect(contrast(c['--on-accent-fill'], c[f]), f).toBeGreaterThanOrEqual(AA_TEXT);
    });
    it('control edges and the focus ring on every surface', () => {
      for (const s of SURFACES) {
        expect(contrast(c['--edge'], c[s]), `--edge on ${s}`).toBeGreaterThanOrEqual(AA_UI);
        expect(contrast(c['--accent-strong'], c[s]), `focus on ${s}`).toBeGreaterThanOrEqual(AA_UI);
      }
    });
  });
}

describe('the rules the matrix implies', () => {
  it('white text on saffron fails, so it is never allowed', () => {
    expect(contrast('#ffffff', COLORS.light['--accent-fill'])).toBeLessThan(AA_UI);
  });
  it('hairlines are decoration: too faint to be the only edge of a control', () => {
    for (const mode of ['light', 'dark'] as const) {
      expect(contrast(COLORS[mode]['--line'], COLORS[mode]['--bg'])).toBeLessThan(AA_UI);
    }
  });
});
