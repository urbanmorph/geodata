// The rules on /design, enforced on both sites' sources: corners come from the
// radius scale, fonts from the two family tokens, buttons from the button
// classes, and forced colours keep actions and focus visible. Shrinking
// allowlists name what is left to migrate (phase 2); add nothing to them.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { FONT } from '../../shared/tokens.mjs';
// @ts-expect-error: plain .mjs
import { TOKENS } from '../scripts/shared-chrome.mjs';

const root = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const walk = (dir: string): string[] =>
  readdirSync(resolve(root, dir)).flatMap((f) => {
    const p = `${dir}/${f}`;
    return statSync(resolve(root, p)).isDirectory() ? walk(p) : [p];
  });
const SOURCES = [
  ...readdirSync(resolve(root, 'web')).filter((f) => f.endsWith('.template.html')).map((f) => `web/${f}`),
  ...walk('web/src'), ...walk('web/scripts'), ...walk('web/functions'), ...walk('shared'),
  ...walk('collect/src'), 'collect/index.html', 'collect/c.html', 'collect/404.html',
  'web/public/offline/index.html',
].filter((f) => /\.(html|ts|mjs|js|css)$/.test(f) && !f.endsWith('.d.mts') && !f.includes('/e2e/'));

describe('corners come from the radius scale', () => {
  // Each a reason the token cannot apply.
  const ALLOW: Record<string, string> = {
    'web/src/embed-snippet.ts': 'the iframe snippet is pasted into other sites, which have no tokens',
    'web/scripts/design-page.mjs': '/design draws each radius token by name (var(\${k}))',
  };
  const ok = (v: string) => v.trim().split(/\s+/).every((p) => /^(0|50%|var\(--radius-(sm|md|lg|xl|pill)\))$/.test(p));
  for (const f of SOURCES.filter((f) => !ALLOW[f] && f !== 'shared/tokens.mjs')) {
    const src = read(f);
    if (!/border-radius/.test(src)) continue;
    it(f, () => {
      const bad = [...src.matchAll(/border-radius:\s*([^;}"'`]+)/g)].map((m) => m[1]).filter((v) => !ok(v));
      expect(bad).toEqual([]);
    });
  }
});

describe('fonts come from --font-sans and --font-mono', () => {
  // SVGs rendered to PNG by resvg read a font-family attribute, not CSS variables.
  const ALLOW = new Set(['shared/tokens.mjs', 'web/functions/lib/og-template.ts']);
  const STACK = /system-ui|ui-sans-serif|ui-monospace|SFMono|Menlo|Consolas|"Segoe UI"/;
  for (const f of SOURCES.filter((f) => !ALLOW.has(f))) {
    it(f, () => {
      // A page that cannot import the module may carry an exact copy of the token.
      const src = read(f).split(`--font-sans: ${FONT['--font-sans']}`).join('').split(`--font-mono: ${FONT['--font-mono']}`).join('');
      expect(src.split('\n').filter((l) => STACK.test(l))).toEqual([]);
    });
  }
});

describe('buttons use the button classes', () => {
  // The system: .btn (+ --fill primary, --line secondary), .btn-sm (compact),
  // .tbtn (map toolbar), .link-btn (a button that reads as a link), .nav-cta
  // (Add a map), and layout wrappers named cta-*.
  const SYSTEM = new Set(['btn', 'btn--fill', 'btn--line', 'btn-sm', 'tbtn', 'link-btn', 'nav-cta', 'cta-row', 'cta-line', 'cta-hint']);
  // Phase 2 folds these into .btn / chips. Shrink only.
  const LEGACY = new Set([
    'filter-panel__btn', 'filter-panel__btn--primary', 'filter-bool__btn', 'map-popover__item--btn',
    'pop-btn', 'pop-btn--approve', 'pop-btn--reject', 'category-cta', 'locate-btn', 'btn-primary',
  ]);
  it('no other button-like class is defined or used', () => {
    const found = new Set<string>();
    for (const f of SOURCES) {
      const src = read(f);
      for (const m of src.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (/btn|cta|button/i.test(c)) found.add(c);
      for (const m of src.matchAll(/\.([a-z][\w-]*(?:btn|cta|button)[\w-]*)\s*[{,:.[ ]/gi)) found.add(m[1]);
    }
    const other = [...found].filter((c) => !SYSTEM.has(c) && !LEGACY.has(c) && !c.startsWith('maplibregl-') && !c.includes('$'));
    expect(other).toEqual([]);
  });
  it('legacy primaries follow the primary rule: saffron, navy text, the offset shadow', () => {
    const home = read('web/index.template.html');
    expect(home).toMatch(/\.filter-panel__btn--primary \{ background: var\(--accent-fill\); color: var\(--on-accent-fill\);[^}]*box-shadow: var\(--shadow-sm\)/);
    expect(read('collect/src/styles.css')).toMatch(/\.pop-btn--approve \{ background: var\(--accent-fill\); color: var\(--on-accent-fill\); box-shadow: var\(--shadow-sm\)/);
  });
  it('the legacy list only shrinks: each entry is still in use', () => {
    const all = SOURCES.map(read).join('\n');
    for (const c of LEGACY) expect(all, c).toContain(c);
  });
});

describe('forced colours keep actions, the current page and focus visible', () => {
  it('bharatlas.com', () => {
    const block = TOKENS.slice(TOKENS.indexOf('@media (forced-colors: active)'));
    expect(block).toMatch(/\.btn--fill[^{]*\{[^}]*background: Highlight/);
    expect(block).toMatch(/\.site-nav a\[aria-current\] \{[^}]*text-decoration: underline/);
    expect(block).toMatch(/:focus-visible \{[^}]*outline-color: Highlight/);
  });
  it('collect', () => {
    const css = read('collect/src/styles.css');
    const block = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(block).toMatch(/button\.primary[^{]*\{[^}]*background: Highlight/);
    expect(block).toMatch(/:focus-visible \{[^}]*outline-color: Highlight/);
  });
});

describe('numbers read the Indian way (5,84,615), in en-IN', () => {
  for (const f of SOURCES.filter((f) => /\.(ts|mjs|js)$/.test(f))) {
    it(f, () => {
      const src = read(f);
      expect(src).not.toMatch(/toLocaleString\((?!'en-IN')/);
      expect(src).not.toMatch(/NumberFormat\((?!'en-IN')/);
      expect(src).not.toContain("'en-US'");
    });
  }
});

describe('motion names what it animates', () => {
  for (const f of SOURCES.filter((f) => /\.(html|css|mjs|ts)$/.test(f))) {
    it(`${relative(root, resolve(root, f))}: no "transition: all"`, () => {
      expect(read(f)).not.toMatch(/transition:\s*all\b/);
    });
  }
});
