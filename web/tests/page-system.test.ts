// One page system (shared-chrome TOKENS) for every content page, in the survey-
// sheet look: body.page sets the column, headings, code, code blocks, tables,
// notes and badges once; main.sheet puts reading pages on a white sheet with
// numbered sections. Pages keep only what is theirs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: plain .mjs
import { TOKENS } from '../scripts/shared-chrome.mjs';

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
const localCss = (f: string) => [...read(f).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('');

const PAGES = ['about', 'privacy', 'terms', 'mcp', 'docs', 'preview'];
const READING = ['about', 'privacy', 'terms', 'mcp'];

describe('page system tokens', () => {
  it('style the page column, code, code blocks, tables, notes and badges once', () => {
    for (const sel of ['body.page {', '.page code {', '.page pre {', '.page table {', '.note {', '.badge {']) {
      expect(TOKENS, sel).toContain(sel);
    }
  });
  it('put reading pages on a white sheet with numbered sections', () => {
    expect(TOKENS).toMatch(/main\.sheet \{[^}]*background: var\(--bg-elevated\)[^}]*border: 1\.5px solid var\(--edge\)/);
    expect(TOKENS).toMatch(/main\.sheet h2:not\(\.unnumbered\)::before \{[^}]*counter\(sheet-section\) \/ ""/);
  });
  it('number sections as decoration (alt text "") so screen readers read just the heading', () => {
    expect(TOKENS).toContain('counter(sheet-section) / ""');
  });
  it('keep their heading defaults below any page rule (:where)', () => {
    expect(TOKENS).toContain(':where(.page main) h2');
    expect(TOKENS).toContain(':where(.page main) h3');
  });
  it('put the phone overrides after the rules they override', () => {
    expect(TOKENS.lastIndexOf('body.page { padding: 0 14px 60px; }')).toBeGreaterThan(TOKENS.indexOf('body.page { max-width'));
  });
  it('underline links in definitions too (not colour alone)', () => {
    expect(TOKENS).toContain('main :is(p, li, dd) a');
  });
});

describe('content pages', () => {
  for (const p of PAGES) {
    it(`${p}: uses the page system and does not restyle what it provides`, () => {
      expect(read(`${p}.template.html`)).toMatch(/<body class="page"/);
      const css = localCss(`${p}.template.html`);
      for (const sel of [/(^|\n)\s*body \{[^}]*max-width/, /(^|\n)\s*code \{/, /(^|\n)\s*pre \{/, /(^|\n)\s*table \{/, /(^|\n)\s*h2 \{/, /\.cta--/, /\.badge \{/]) {
        expect(css, `${p} ${sel}`).not.toMatch(sel);
      }
    });
  }
  for (const p of READING) {
    it(`${p}: reads on the sheet`, () => {
      expect(read(`${p}.template.html`)).toMatch(/<main id="main" class="[^"]*\bsheet\b/);
    });
  }
  it('docs uses the shared buttons, not its own', () => {
    const docs = read('docs.template.html');
    expect(docs).not.toMatch(/class="cta[ "]/);
    expect(docs).toMatch(/class="btn btn--fill"/);
  });
});

// The layer map draws in the brand palette (survey sheet): India-green land,
// chakra-navy edges, saffron for the selected feature. No stray hex colours.
describe('map data colours', () => {
  it('come from PALETTE, once, for every map', () => {
    expect(read('src/map-paint.ts')).toMatch(/DATA_FILL = PALETTE\.green[\s\S]*DATA_LINE = PALETTE\.navy[\s\S]*DATA_SELECTED = PALETTE\.saffron/);
    for (const f of ['src/map.ts', 'src/preview.ts']) {
      const src = read(f);
      expect(src, f).toContain("from './map-paint'");
      expect(src, f).not.toMatch(/#0a58ca|#f59e0b/i);
    }
  });
});
