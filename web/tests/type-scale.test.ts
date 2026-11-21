// One type scale for every bharatlas page: sizes come from the --fs-* tokens
// (shared/tokens.mjs), never a hand-picked px value, so text sizes line up
// across pages instead of drifting (171 raw sizes over 17 values before this).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: plain .mjs
import { TOKENS } from '../scripts/shared-chrome.mjs';
import { injectTokens } from '../../shared/tokens.mjs';

const SCALE = { xs: 12, sm: 13, base: 15, md: 16, lg: 18, xl: 22, '2xl': 24, '3xl': 32, '4xl': 44, display: 72 };
const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
// A size in the font shorthand too ("font: 500 13px/1.2 ..."), not only font-size.
const RAW_SIZE = /font-size:\s*[0-9.]+(px|rem|em)|font:[^;{}"]*?(?<![\w-])[0-9.]+(px|rem|em)/g;
const rawSizes = (src: string) => [...src.replace(/--fs-[a-z0-9]+: ?\d+px;?/g, '').matchAll(RAW_SIZE)].map((m) => m[0]);

describe('type scale', () => {
  it('TOKENS defines exactly the ten steps', () => {
    const defined = Object.fromEntries([...TOKENS.matchAll(/--fs-([a-z0-9]+): (\d+)px/g)].map((m) => [m[1], Number(m[2])]));
    expect(defined).toEqual(SCALE);
  });

  it('catches a size in the font shorthand', () => {
    expect(rawSizes('a { font: 500 13px/1.2 var(--font-sans); }')).toHaveLength(1);
    expect(rawSizes('a { font:15px/1.6 x; }')).toHaveLength(1);
    expect(rawSizes('a { font: 600 var(--fs-xs) var(--font-mono); }')).toEqual([]);
  });

  const files = [
    'src/map.ts', 'index.template.html', 'layers.template.html', 'about.template.html', 'docs.template.html', 'mcp.template.html',
    'preview.template.html', 'privacy.template.html', 'terms.template.html', 'releases.template.html', '404.template.html',
    'design.template.html', 'scripts/shared-chrome.mjs', 'scripts/design-page.mjs', 'functions/lib/render-view.ts',
    'functions/lib/not-found.ts', 'public/offline/index.html',
  ];
  for (const f of files) {
    it(`${f}: every font size is a scale token`, () => {
      const raw = rawSizes(read(f));
      expect(raw, raw.join(', ')).toEqual([]);
    });
  }

  it('collect uses the same ten steps, and no raw sizes in its CSS or inline styles', () => {
    const css = injectTokens(readFileSync(resolve(__dirname, '../../collect/src/styles.css'), 'utf8'));
    for (const [k, v] of Object.entries(SCALE)) expect(css).toContain(`--fs-${k}: ${v}px`);
    const raw = rawSizes(css);
    expect(raw, raw.join(', ')).toEqual([]);
    const app = readFileSync(resolve(__dirname, '../../collect/src/app.ts'), 'utf8');
    expect(app).not.toMatch(/font-size:\s*\d+px/);
  });
});
