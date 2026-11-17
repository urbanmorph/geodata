// Reading pages are set out as a ledger: each section's heading in a left
// column, its text beside it at a 720px measure, so the sheet uses the full
// page column without long lines. Phones stack it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const web = resolve(__dirname, '..');
const read = (f: string) => readFileSync(resolve(web, f), 'utf8');
const chrome = read('scripts/shared-chrome.mjs');
const mainOf = (html: string) => html.slice(html.indexOf('<main'), html.indexOf('</main>'));

describe('the shared ledger', () => {
  it('a section is a two-column grid: a 200px heading column, then text up to 720px', () => {
    expect(chrome).toMatch(/main\.sheet > section \{[^}]*display: grid;[^}]*grid-template-columns: 200px minmax\(0, 720px\)/);
    expect(chrome).toMatch(/main\.sheet > section > h2 \{[^}]*grid-column: 1/);
    expect(chrome).toMatch(/main\.sheet > section > :not\(h2\) \{[^}]*grid-column: 2/);
    expect(chrome).toMatch(/main\.sheet > section > \.wide \{[^}]*grid-column: 1 \/ -1/);
  });
  it('phones stack it into one column', () => {
    expect(chrome).toMatch(/@media \(max-width: 760px\) \{[^@]*main\.sheet > section \{ grid-template-columns: 1fr; \}/);
  });
  it('labelled lists put the label beside its text', () => {
    expect(chrome).toMatch(/\.pairs > li \{[^}]*display: grid/);
  });
});

for (const page of ['about', 'privacy', 'terms']) {
  describe(`/${page}`, () => {
    const main = mainOf(read(`${page}.template.html`));
    it('every heading opens a section, and nothing sits between sections', () => {
      const h2s = main.match(/<h2[\s>]/g) ?? [];
      const sections = main.match(/<section>/g) ?? [];
      expect(h2s.length).toBeGreaterThan(3);
      expect(sections.length).toBe(h2s.length);
      expect(main).not.toMatch(/<\/section>\s*<(p|ul|dl|div)[\s>]/);
      for (const s of main.split('<section>').slice(1)) expect(s.trimStart().startsWith('<h2')).toBe(true);
    });
  });
}

describe('/about reformatted', () => {
  const main = mainOf(read('about.template.html'));
  it('the three tools side by side, who uses it as a grid of four', () => {
    expect(main).toMatch(/<ul class="compare wide">(\s*<li>[\s\S]*?<\/li>){3}\s*<\/ul>/);
    expect(main).toMatch(/<ul class="cards wide">(\s*<li>[\s\S]*?<\/li>){4}\s*<\/ul>/);
  });
  it('what you can do today: eight labelled items in two columns', () => {
    const list = main.match(/<ul class="pairs pairs--verbs wide">([\s\S]*?)<\/ul>/)?.[1] ?? '';
    expect(list.match(/<li><span class="k">/g)?.length).toBe(8);
  });
  it('on phones the verb labels sit above their text', () => {
    const css = read('about.template.html');
    expect(css).toMatch(/@media \(max-width: 760px\) \{[^@]*\.prose \.pairs--verbs > li \{ grid-template-columns: 1fr; \}/);
  });
  it('the FAQ is question beside answer and keeps all 8 answers open', () => {
    expect(main).toMatch(/<dl class="faq wide">/);
    expect(main.match(/<dt[\s>]/g)?.length).toBe(8);
    expect(main).not.toMatch(/<details/);
  });
});

describe('/privacy labelled', () => {
  const main = mainOf(read('privacy.template.html'));
  it('each item in its lists carries a label', () => {
    const items = main.match(/<ul class="pairs">([\s\S]*?)<\/ul>/g)?.join('') ?? '';
    expect(items.match(/<li>/g)?.length).toBeGreaterThanOrEqual(14);
    expect(items.match(/<li><span class="k">/g)?.length).toBe(items.match(/<li>/g)?.length);
  });
});
