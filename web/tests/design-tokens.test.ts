// One token module (shared/tokens.mjs) for bharatlas.com and collect: the same
// names and values on both sites, and the pages' theme-color equal to the paper
// (--bg). The contrast of every pair is in contrast.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COLOR_ROLES, COLORS, SCALES, BREAKPOINTS, DESIGN_VERSION, DESIGN_CHANGELOG,
  tokensCss, injectTokens, TOKENS_MARKER,
} from '../../shared/tokens.mjs';
// @ts-expect-error: plain .mjs
import { TOKENS } from '../scripts/shared-chrome.mjs';

const root = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const MODES = ['light', 'dark'] as const;

describe('the token module', () => {
  it('has a version and a changelog whose newest entry is that version', () => {
    expect(DESIGN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(DESIGN_CHANGELOG[0].version).toBe(DESIGN_VERSION);
  });
  it('gives every colour role a light and a dark value', () => {
    for (const r of COLOR_ROLES) {
      expect(r.light, r.name).toBeTruthy();
      expect(r.dark, r.name).toBeTruthy();
    }
  });
  it('holds each scale the guide documents', () => {
    for (const k of ['FONT', 'FONT_SIZE', 'FONT_WEIGHT', 'LINE_HEIGHT', 'SPACE', 'RADIUS', 'BORDER', 'SHADOW', 'Z', 'MOTION', 'ICON']) {
      expect(Object.keys((SCALES as Record<string, object>)[k]).length, k).toBeGreaterThan(0);
    }
    expect(Object.keys(SCALES.FONT_WEIGHT)).toHaveLength(4);
    expect(BREAKPOINTS).toEqual({ sm: 640, md: 900, lg: 1100 });
  });
  it('spaces on a 4 px grid, with 2 px half steps named --sp-N-5, and gives buttons 4 px corners', () => {
    for (const [k, v] of Object.entries(SCALES.SPACE)) expect(parseInt(v as string) % 4, k).toBe(/-\d-5$/.test(k) ? 2 : 0);
    const px = Object.values(SCALES.SPACE).map((v) => parseInt(v as string));
    expect(px).toEqual([...px].sort((a, b) => a - b));
    expect(SCALES.RADIUS['--radius-sm']).toBe('4px');
  });
  it('uses hard offset shadows only (no blur)', () => {
    for (const v of Object.values(SCALES.SHADOW)) {
      const [, , blur] = (v as string).split(' ');
      expect(blur, v as string).toBe('0');
    }
  });
});

describe('bharatlas.com emits the module', () => {
  it('shared-chrome TOKENS starts from tokensCss()', () => {
    const css = tokensCss();
    expect(TOKENS).toContain(css.slice(0, css.indexOf('@media')).trim());
    const dark = TOKENS.slice(TOKENS.indexOf('prefers-color-scheme: dark'));
    for (const [k, v] of Object.entries(COLORS.dark)) if (v !== COLORS.light[k]) expect(dark, k).toContain(`${k}: ${v};`);
  });
  it('declares no token of its own in :root', () => {
    const declared = [...TOKENS.matchAll(/[\s{;](--[a-z0-9-]+):/g)].map((m) => m[1]);
    const known = new Set([...COLOR_ROLES.map((r) => r.name), ...Object.values(SCALES).flatMap((s) => Object.keys(s))]);
    expect(declared.filter((d) => !known.has(d))).toEqual([]);
  });
});

describe('collect emits the same tokens', () => {
  const css = read('collect/src/styles.css');
  it('its stylesheet holds the marker once and the build fills it from the module', () => {
    expect(css.split(TOKENS_MARKER)).toHaveLength(2);
    expect(read('collect/vite.config.ts')).toContain('injectTokens(');
    expect(injectTokens(css)).toContain(tokensCss());
  });
  it('defines no shared token name itself (so the two sites cannot drift)', () => {
    const shared = new Set([...COLOR_ROLES.map((r) => r.name), ...Object.values(SCALES).flatMap((s) => Object.keys(s))]);
    const own = [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).filter((n) => shared.has(n));
    expect(own).toEqual([]);
  });
  it('uses no retired collect name', () => {
    for (const n of ['--card', '--sheet', '--surface', '--line-strong', '--accent-solid', '--on-accent-solid', '--danger', '--amber', '--shadow-pop', '--ring']) {
      expect(css, n).not.toMatch(new RegExp(`var\\(${n}\\)`));
    }
  });
});

describe('pages that cannot import the module carry exact copies', () => {
  // The offline pages show with no network: bharatlas.com's static one and collect's, a string in its worker.
  for (const f of ['web/public/offline/index.html', 'collect/src/sw/sw.js']) {
    it(f, () => {
      const html = read(f);
      const light = html.match(/:root\{([^}]*)\}/)![1];
      const dark = html.match(/prefers-color-scheme: dark\)\{:root\{([^}]*)\}/)![1];
      const all = { ...Object.assign({}, ...Object.values(SCALES)), ...COLORS.light } as Record<string, string>;
      const decls = (s: string) => [...s.matchAll(/(--[a-z0-9-]+): ([^;]+)/g)].map((m) => [m[1], m[2].trim()]);
      expect(decls(light).length).toBeGreaterThan(5);
      for (const [k, v] of decls(light)) expect(v, k).toBe(all[k]);
      for (const [k, v] of decls(dark)) expect(v, k).toBe(COLORS.dark[k]);
    });
  }
});

describe('theme-color is the paper (--bg) in each theme', () => {
  const files = [
    ...['index', 'layers', 'about', 'docs', 'mcp', 'preview', 'privacy', 'terms', 'releases', '404', 'design'].map((p) => `web/${p}.template.html`),
    'collect/index.html', 'collect/c.html', 'collect/404.html',
  ];
  for (const f of files) {
    it(f, () => {
      const html = read(f);
      for (const mode of MODES) {
        const m = html.match(new RegExp(`<meta name="theme-color" content="(#[0-9a-fA-F]{6})" media="\\(prefers-color-scheme: ${mode}\\)"`));
        expect(m?.[1].toLowerCase(), `${f} ${mode}`).toBe(COLORS[mode]['--bg'].toLowerCase());
      }
    });
  }
});
