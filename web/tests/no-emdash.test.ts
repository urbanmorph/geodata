// Visible copy uses commas, colons, periods and parentheses, never an em-dash
// (owner style rule), on bharatlas.com and on collect. Comments may keep
// theirs: only string literals and visible page text count.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const web = resolve(__dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(resolve(web, dir)).flatMap((f) => (statSync(resolve(web, dir, f)).isDirectory() ? walk(`${dir}/${f}`) : [`${dir}/${f}`]));
const files = [
  ...readdirSync(resolve(web, 'src')).filter((f) => /\.(ts|mjs)$/.test(f)).map((f) => `src/${f}`),
  'functions/lib/render-view.ts',
  'functions/lib/view-dataset.ts',
  'functions/lib/licenses.ts',
  'functions/lib/nearby.ts',
  'functions/api/submit.ts',
  '../shared/format.mjs',
  'scripts/prerender.mjs',
  'scripts/design-page.mjs',
  ...walk('../collect/src').filter((f) => /\.(ts|js)$/.test(f)),
];
const templates = [...readdirSync(web).filter((f) => f.endsWith('.template.html')), '../collect/index.html', '../collect/c.html', '../collect/404.html'];

/** The code with comments removed, so only strings and code remain. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');

/** What a visitor reads: no comments, styles, scripts or tags. */
const visible = (html: string) =>
  html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');

describe('no em-dash in visible strings', () => {
  for (const f of files) {
    it(f, () => {
      const hits = code(readFileSync(resolve(web, f), 'utf8')).split('\n').filter((l) => l.includes('—'));
      expect(hits).toEqual([]);
    });
  }
  for (const f of templates) {
    it(`${f} (page text)`, () => {
      const hits = visible(readFileSync(resolve(web, f), 'utf8')).split('\n').filter((l) => l.includes('—'));
      expect(hits).toEqual([]);
    });
  }
  it('collect CSS content text', () => {
    const css = readFileSync(resolve(web, '../collect/src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.match(/content:\s*"[^"]*—[^"]*"/g) ?? []).toEqual([]);
  });
});
