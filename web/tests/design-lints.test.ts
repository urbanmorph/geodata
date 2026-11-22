// The rules on /design, enforced on both sites' sources: corners come from the
// radius scale, fonts from the two family tokens, buttons from the button
// classes, and forced colours keep actions and focus visible. Shrinking
// allowlists name what is left to migrate (phase 2); add nothing to them.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { FONT, SPACE } from '../../shared/tokens.mjs';
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

// Spacing, borders, shadows, layers and motion come from the token scales.
// These read every CSS declaration of those kinds in the stylesheets and the
// CSS inside templates. Each exception below names why the token cannot
// apply; the lists only shrink.
const CSS_SOURCES = SOURCES.filter((f) => !/\.ts$/.test(f) || f === 'web/functions/lib/render-view.ts')
  .filter((f) => !f.endsWith('.js') && f !== 'shared/tokens.mjs');
// Not checked: pages that cannot read var() (the 404 fallback in functions and
// collect's offline worker inline literal values from the module), and the
// inline styles set from TypeScript in web/src and collect/src (phase 2).
const decls = (src: string, prop: RegExp) =>
  [...src.matchAll(/(?<![\w-])([a-z-]+)\s*:\s*([^;{}"'`]+)/g)]
    .filter((m) => prop.test(m[1]) && !m[2].includes('$'))
    .map((m) => m[2].trim().replace(/\s*!important$/, ''));
const lint = (name: string, prop: RegExp, bad: (v: string) => boolean) =>
  describe(name, () => {
    for (const f of CSS_SOURCES) {
      const found = decls(read(f), prop);
      if (!found.length) continue;
      it(f, () => expect(found.filter(bad)).toEqual([]));
    }
  });

// The spacing scale in px, and the px values with no step, each with its reason.
const SP = new Set(Object.values(SPACE).map((v) => parseInt(v)));
// Odd insets: with a 1 or 1.5 px edge they land a control, key or badge on its
// size (44 px targets); the nearest step would move it by a pixel.
const INSET = 'an inset that, with its edge, lands a control on its size';
// Page rhythm between sections: between 24, 32 and 48 px with no step.
const RHYTHM = 'page rhythm between sections, off the step scale';
const OFF_SCALE_SPACE: Record<string, string> = {
  '1px': INSET, '1.5px': 'the theme grid overlapping its cells’ 1.5 px edges', '3px': INSET, '5px': INSET,
  '7px': INSET, '9px': INSET, '11px': INSET, '13px': INSET, '22px': 'the collect empty state and usage-row gap',
  '28px': RHYTHM, '36px': RHYTHM, '40px': RHYTHM, '44px': RHYTHM, '56px': RHYTHM, '60px': RHYTHM, '64px': RHYTHM, '80px': RHYTHM,
};
lint('spacing comes from the --sp-* scale', /^(margin|padding|gap|row-gap|column-gap)(-[a-z-]+)?$/, (v) =>
  [...v.matchAll(/(?<![\w.-])-?(\d+(?:\.\d+)?)px\b/g)].some((m) => SP.has(Number(m[1])) || !OFF_SCALE_SPACE[`${m[1]}px`]));

// A drawn border or outline is a --border-* token unless it is one of these.
const BORDER_EXCEPTIONS: Record<string, string> = {
  '2px solid var(--line)': 'a spinner track or a quote rule on one side, not an edge',
  '3px solid var(--line)': 'collect spinner track',
  '2px solid color-mix(in srgb, var(--fg) 18%, transparent)': 'the map spinner track over tiles',
  '1.5px solid color-mix(in srgb, var(--fg) 18%, transparent)': 'the inline loader spinner track',
  '1.5px solid color-mix(in srgb, var(--accent-fill) 55%, var(--bg))': 'the saffron edge on the ward answer card',
  '1px solid var(--edge)': 'a thin navy edge on a /design bar and a map legend swatch',
  '1px solid currentColor': 'a status pill edged in its own text colour',
  '2px solid var(--accent)': 'the locate ping ring',
  '3px solid var(--accent)': 'an accent bar on one side',
  '3px solid var(--warn)': 'a warning bar on one side',
  '3px solid var(--edge)': 'the rule between realms on /layers',
  '3px solid var(--accent-fill)': 'the saffron ring on a collect vertex handle',
  '4px solid var(--brand-green)': 'the green bar on the sister-site card on /layers',
  '4px dashed var(--accent)': 'the whole-page drop overlay',
  '2px dashed var(--edge)': 'the contribute drop zone',
  '1px dashed var(--line-bright)': 'the collect empty state',
  '1px dashed var(--accent)': 'the collect add-a-photo tile',
};
lint('borders come from the --border-* tokens', /^(border|border-(top|right|bottom|left)|outline)$/, (v) =>
  /\d(\.\d+)?px\s+(solid|dashed|dotted|double)/.test(v) && !BORDER_EXCEPTIONS[v]);

// Elevation is a --shadow-* token. An inset shadow is an inner border, allowed.
const SHADOW_EXCEPTIONS: Record<string, string> = {
  '0 -8px 24px rgba(0,0,0,0.10)': 'the map bottom sheets float over tiles: a soft lift, light',
  '0 -8px 24px rgba(0,0,0,0.18)': 'the map bottom sheets float over tiles: a soft lift, dark',
  '-8px 0 24px rgba(0,0,0,0.06)': 'the map side panel over tiles',
  '0 6px 20px rgba(0,0,0,0.12)': 'the hover popup over tiles',
  '6px 6px 0 var(--edge)': 'the search popover: one step above --shadow',
  '6px 6px 0 var(--brand-green)': 'the green offset under code blocks on reading pages',
  '0 0 0 1px var(--line-bright)': 'the MapLibre control group outline (its own markup, no border)',
  '0 0 0 3px color-mix(in srgb, var(--accent-fill) 40%, transparent)': 'the contribute drop zone focus halo',
};
// A comma list split at the top level only (not inside color-mix(...)).
const layers = (v: string) => {
  let depth = 0;
  return v.replace(/[(),]/g, (c) => (c === '(' ? (depth++, c) : c === ')' ? (depth--, c) : depth ? c : '\0')).split('\0').map((p) => p.trim());
};
lint('shadows come from the --shadow-* tokens', /^box-shadow$/, (v) =>
  layers(v).some((p) => p !== 'none' && !/^var\(--shadow[\w-]*\)$/.test(p) && !/^inset\b/.test(p) && !SHADOW_EXCEPTIONS[p]));

lint('stacking comes from the --z-* layers', /^z-index$/, (v) =>
  !/^(auto|0|-1|var\(--z-[\w-]+\)|calc\(var\(--z-[\w-]+\) [+-] \d\))$/.test(v));

// Times outside the --dur-* tokens: loops keep their own period (infinite).
const TIME_EXCEPTIONS: Record<string, string> = {
  '.06s': 'the press feedback on a collect button: faster than any token',
  '.26s': 'the collect sheet settling after a drag',
  '.001ms': 'reduced motion: finish at once',
  '0s': 'the quick-search reveal: no animation, only a delay',
  '1.5s': 'the quick-search reveal delay',
  '.65s': 'the second locate ping, half the 1.3 s loop',
};
lint('motion comes from the --dur-* and --ease tokens', /^(transition|animation)(-[a-z-]+)?$/, (v) =>
  /cubic-bezier\(/.test(v) || (!/\binfinite\b/.test(v) && [...v.matchAll(/(?<![\w-])(\d*\.?\d+m?s)\b/g)].some((m) => !TIME_EXCEPTIONS[m[1]])));

describe('the exception lists only shrink: each entry is still in use', () => {
  const all = (prop: RegExp) => CSS_SOURCES.flatMap((f) => decls(read(f), prop));
  it('spacing', () => {
    const used = all(/^(margin|padding|gap|row-gap|column-gap)(-[a-z-]+)?$/).join(' ');
    for (const v of Object.keys(OFF_SCALE_SPACE)) expect(used, v).toMatch(new RegExp(`(?<![\\w.-])-?${v.replace('.', '\\.')}`));
  });
  it('borders', () => {
    const used = new Set(all(/^(border|border-(top|right|bottom|left)|outline)$/));
    for (const v of Object.keys(BORDER_EXCEPTIONS)) expect(used.has(v), v).toBe(true);
  });
  it('shadows', () => {
    const used = new Set(all(/^box-shadow$/).flatMap(layers));
    for (const v of Object.keys(SHADOW_EXCEPTIONS)) expect(used.has(v), v).toBe(true);
  });
  it('times', () => {
    const used = all(/^(transition|animation)(-[a-z-]+)?$/).join(' ');
    for (const v of Object.keys(TIME_EXCEPTIONS)) expect(used, v).toMatch(new RegExp(`(?<![\\w.])${v.replace('.', '\\.')}\\b`));
  });
});

describe('motion names what it animates', () => {
  for (const f of SOURCES.filter((f) => /\.(html|css|mjs|ts)$/.test(f))) {
    it(`${relative(root, resolve(root, f))}: no "transition: all"`, () => {
      expect(read(f)).not.toMatch(/transition:\s*all\b/);
    });
  }
});
