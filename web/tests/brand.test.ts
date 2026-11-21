import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PALETTE,
  THEME,
  themeDecls,
  brandMarkSvg,
  wordmarkHtml,
  faviconSvg,
  collectFaviconSvg,
  WORDMARK_CSS,
} from '../../shared/brand.mjs';

// WCAG 2.x relative luminance + contrast ratio.
function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(ch[0]) + 0.7152 * lin(ch[1]) + 0.0722 * lin(ch[2]);
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const root = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('palette', () => {
  it('uses India colours: saffron, India green, chakra navy', () => {
    expect(PALETTE.saffron).toBe('#F28C28');
    expect(PALETTE.green).toBe('#12804A');
    expect(PALETTE.navy).toBe('#0B1B3F');
  });

  it('never puts white text on saffron (fails AA); navy on saffron passes', () => {
    expect(contrast('#FFFFFF', PALETTE.saffron)).toBeLessThan(3);
    expect(contrast(PALETTE.navy, PALETTE.saffron)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('theme tokens meet WCAG AA', () => {
  const bg = { light: '#ffffff', dark: '#0a0a0a' } as const;
  for (const mode of ['light', 'dark'] as const) {
    const t = THEME[mode];
    it(`${mode}: link text, wordmark ink and button text`, () => {
      expect(contrast(t['--accent'], bg[mode])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--brand-ink'], bg[mode])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--on-accent-fill'], t['--accent-fill'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--on-accent-fill'], t['--accent-fill-hover'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--accent-strong'], bg[mode])).toBeGreaterThanOrEqual(3);
    });
  }

  it('themeDecls renders one CSS declaration per token', () => {
    const css = themeDecls('light');
    for (const [k, v] of Object.entries(THEME.light)) expect(css).toContain(`${k}: ${v};`);
  });
});

describe('logo and wordmark', () => {
  it('draws three stacked layers: saffron on top, white, green below', () => {
    const svg = brandMarkSvg();
    const fills = [...svg.matchAll(/fill="(#[0-9A-F]{6})"/g)].map((m) => m[1]);
    expect(fills).toEqual([PALETTE.green, '#FFFFFF', PALETTE.saffron]);
    expect(svg).toContain('aria-hidden="true"');
  });

  it('sizes the mark', () => {
    expect(brandMarkSvg(20)).toMatch(/width="20" height="20"/);
  });

  it('keeps the word "bharatlas" whole and in one colour (no split span)', () => {
    const html = wordmarkHtml();
    expect(html).toContain('<span class="brand-name">bharatlas</span>');
    expect(html).not.toContain('mark-accent');
    expect(html).toContain('href="/"');
  });

  it('adds an optional escaped tagline', () => {
    expect(wordmarkHtml({ tagline: "India's open atlas" })).toContain('<span class="tagline">India&#39;s open atlas</span>');
    expect(wordmarkHtml({ tagline: '<b>' })).toContain('&lt;b&gt;');
  });

  it('collect icon is the same mark plus a map-pin badge, so the two apps differ', () => {
    const svg = collectFaviconSvg();
    expect(svg).toContain(PALETTE.saffron);
    expect(svg).toContain('class="pin"');
    expect(svg).not.toBe(faviconSvg());
  });

  it('favicon is a standalone SVG of the same mark', () => {
    const svg = faviconSvg();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain(PALETTE.saffron);
  });
});

describe('every surface uses the brand (no leftover violet)', () => {
  const files = [
    'web/scripts/shared-chrome.mjs',
    'web/functions/lib/render-view.ts',
    'web/functions/lib/og-template.ts',
    'web/functions/_middleware.ts',
    'web/mcp.template.html',
    'web/public/favicon.svg',
    'web/public/offline/index.html',
    'web/public/og-default.svg',
    'web/public/og-about.svg',
    'web/public/og-preview.svg',
    'collect/src/styles.css',
    'collect/src/app.ts',
    'collect/src/sw/sw.js',
    'collect/public/favicon.svg',
  ];
  for (const f of files) {
    it(f, () => {
      expect(read(f)).not.toMatch(/#(4f46e5|6366f1|818cf8|4338ca|312e81|a5b4fc|c7d2fe)\b|rgba\(79, ?70, ?229/i);
    });
  }

  it('the static favicon matches the generated one', () => {
    expect(read('web/public/favicon.svg').trim()).toBe(faviconSvg());
    expect(read('collect/public/favicon.svg').trim()).toBe(collectFaviconSvg());
  });

  it('collect uses the brand saffron for buttons with navy text', () => {
    const css = read('collect/src/styles.css');
    expect(THEME.light['--accent-fill']).toBe(PALETTE.saffron);
    expect(THEME.light['--on-accent-fill']).toBe(PALETTE.navy);
    expect(css).toMatch(/button\.primary, \.btn\.primary \{[^}]*background: var\(--accent-fill\); color: var\(--on-accent-fill\)/);
    for (const l of css.split('\n').filter((x) => x.includes('var(--accent-fill)'))) expect(l).not.toMatch(/color: ?#fff\b/);
  });

  it('buttons on the saffron fill use navy text, not white', () => {
    for (const f of ['web/index.template.html', 'web/preview.template.html', 'web/docs.template.html', 'web/mcp.template.html', 'web/functions/lib/render-view.ts', 'web/scripts/shared-chrome.mjs']) {
      const lines = read(f).split('\n').filter((l) => l.includes('var(--accent-fill)'));
      for (const l of lines) expect(l, `${f}: ${l.trim()}`).not.toMatch(/color: ?#fff\b/);
    }
  });
});

describe('wordmark weight', () => {
  it('is heavy (800) everywhere the name is set', () => {
    expect(WORDMARK_CSS).toContain('font-weight: 800');
    const css = read('collect/src/styles.css');
    expect(css).toMatch(/\.topbar \.brand \{[^}]*font-weight: 800/);
    expect(css).toMatch(/\.topbar \.collect-name \{[^}]*font-weight: 800/);
    // collect's one header (landing, link-problem page, 404).
    expect(read('collect/src/topbar.ts')).toContain('<span class="collect-name">collect</span>');
  });
});

describe('content pages share one type scale (shared-chrome page classes)', () => {
  for (const page of ['about', 'docs', 'mcp', 'privacy', 'terms', 'preview']) {
    it(`${page}: a .page-title heading and no page-local title or uppercase-h2 styles`, () => {
      const t = read(`web/${page}.template.html`);
      expect(t).toMatch(/<h1 class="page-title"/);
      expect(t).not.toMatch(/\.page-title \{|\.hero \{|text-transform: uppercase; letter-spacing: \.08em; color: var\(--muted\); margin: var\(--sp-7\)/);
    });
  }
});
