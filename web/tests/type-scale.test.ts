// One type scale for every bharatlas page: sizes come from the --fs-* tokens
// (shared-chrome TOKENS), never a hand-picked px value, so text sizes line up
// across pages instead of drifting (171 raw sizes over 17 values before this).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: plain .mjs
import { TOKENS } from '../scripts/shared-chrome.mjs';

const SCALE = { xs: 12, sm: 13, base: 15, md: 16, lg: 18, xl: 22, '2xl': 24, '3xl': 32, '4xl': 44, display: 72 };
const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('type scale', () => {
  it('TOKENS defines exactly the ten steps', () => {
    const defined = Object.fromEntries([...TOKENS.matchAll(/--fs-([a-z0-9]+): (\d+)px/g)].map((m) => [m[1], Number(m[2])]));
    expect(defined).toEqual(SCALE);
  });

  const files = ['src/map.ts', 'index.template.html', 'about.template.html', 'docs.template.html', 'mcp.template.html', 'preview.template.html', 'privacy.template.html', 'terms.template.html', 'scripts/shared-chrome.mjs', 'functions/lib/render-view.ts'];
  for (const f of files) {
    it(`${f}: every font size is a scale token`, () => {
      const css = read(f).replace(/--fs-[a-z0-9]+: \d+px;?/g, '');
      const raw = [...css.matchAll(/font-size:\s*([0-9.]+(px|rem|em))|font:\s*([0-9.]+px)/g)].map((m) => m[0]);
      expect(raw, raw.join(', ')).toEqual([]);
    });
  }

  it('collect uses the same ten steps, and no raw sizes in its CSS or inline styles', () => {
    const css = readFileSync(resolve(__dirname, '../../collect/src/styles.css'), 'utf8');
    for (const [k, v] of Object.entries(SCALE)) expect(css).toContain(`--fs-${k}: ${v}px`);
    const body = css.replace(/--fs-[a-z0-9]+: \d+px;?/g, '');
    const raw = [...body.matchAll(/font-size:\s*[0-9.]+(px|rem|em)|font:[^;]*?\b[0-9.]+px/g)].map((m) => m[0]);
    expect(raw, raw.join(', ')).toEqual([]);
    const app = readFileSync(resolve(__dirname, '../../collect/src/app.ts'), 'utf8');
    expect(app).not.toMatch(/font-size:\s*\d+px/);
  });
});
