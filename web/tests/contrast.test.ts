import { describe, it, expect } from 'vitest';
import { TOKENS } from '../scripts/shared-chrome.mjs';

// WCAG 2.x relative luminance + contrast ratio — pure, from the spec.
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(ch[0]) + 0.7152 * lin(ch[1]) + 0.0722 * lin(ch[2]);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Pull the design-token hex values out of the shared TOKENS CSS string, so a
// future palette tweak that drops a colour below threshold fails CI here.
function tokenScope(scope: 'light' | 'dark'): Record<string, string> {
  const dark = TOKENS.match(/prefers-color-scheme:\s*dark[^{]*\{\s*:root\s*\{([^}]*)\}/);
  const light = TOKENS.match(/:root\s*\{([^}]*)\}/);
  const body = (scope === 'dark' ? dark : light)?.[1] ?? '';
  const map: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{3,6})/g)) map[m[1]] = m[2];
  return map;
}

const WHITE = '#ffffff';
const AA_TEXT = 4.5; // normal-size text
const AA_UI = 3; // UI components / large text (1.4.11, 1.4.3 large)

describe('WCAG contrast util', () => {
  it('matches known reference ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrast('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5); // canonical AA grey
  });
});

describe('design tokens meet WCAG 2.2 AA (light)', () => {
  const t = tokenScope('light');

  it('foreground + secondary text on backgrounds', () => {
    expect(contrast(t['--fg'], t['--bg'])).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(t['--muted'], t['--bg'])).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(t['--muted-strong'], t['--bg'])).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(t['--muted'], t['--bg-card'])).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('accent link/label text on white and on cards', () => {
    expect(contrast(t['--accent'], t['--bg'])).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(t['--accent'], t['--bg-card'])).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('white text on filled accent buttons', () => {
    expect(contrast(WHITE, t['--accent-fill'])).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('focus outline is visible against the background', () => {
    expect(contrast(t['--accent-strong'], t['--bg'])).toBeGreaterThanOrEqual(AA_UI);
  });
});

describe('design tokens meet WCAG 2.2 AA (dark)', () => {
  const t = tokenScope('dark');

  it('foreground + secondary text on backgrounds', () => {
    expect(contrast(t['--fg'], t['--bg'])).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(t['--muted'], t['--bg'])).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(t['--muted-strong'], t['--bg'])).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('accent link/label text on background', () => {
    expect(contrast(t['--accent'], t['--bg'])).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('white text on filled accent buttons', () => {
    expect(contrast(WHITE, t['--accent-fill'])).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
