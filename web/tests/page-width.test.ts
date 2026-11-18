// Every page shares one column width, so the logo, nav and footer stay put
// when you move between pages. Reading pages keep a 720px line length inside it.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const web = resolve(__dirname, '..');
const chrome = readFileSync(resolve(web, 'scripts/shared-chrome.mjs'), 'utf8');
const pages = [...readdirSync(web).filter((f) => f.endsWith('.template.html'))];

describe('one page width', () => {
  it('the shared styles set the column to 1120px', () => {
    expect(chrome).toMatch(/:root \{ --page-max: 1120px; \}/);
  });
  for (const f of pages) {
    it(`${f} does not set its own width`, () => {
      expect(readFileSync(resolve(web, f), 'utf8')).not.toMatch(/--page-max:/);
    });
  }
  it('reading text keeps its 720px measure', () => {
    // The sheet itself spans the column (like /docs); only its text is held to 720px.
    expect(chrome).not.toMatch(/\.prose \{ max-width/);
    expect(chrome).toMatch(/\.prose :is\(p, ul, ol, dl\) \{ max-width: 720px; \}/);
    expect(chrome).toMatch(/\.page main :is\(p, ul, ol\) \{ max-width: 720px; \}/);
  });
});

it('table cells wrap long paths, so tables fit a phone', () => {
  expect(chrome).toMatch(/\.page td \{[^}]*overflow-wrap: anywhere/);
});

it('on phones every page keeps 16px sides, the same as the header logo', () => {
  expect(chrome).toMatch(/body\.page \{ padding: 0 16px 60px; \}/);
  expect(readFileSync(resolve(web, 'index.template.html'), 'utf8')).toMatch(/@media \(max-width: 640px\) \{\s*body \{ padding: 0 16px 60px; \}/);
});
