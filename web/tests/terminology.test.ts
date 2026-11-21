// The site's words (owner, 2026-11-17): "layer" and "theme" in visible copy;
// "category" only in the API, MCP and code; no "catalog" anywhere a reader sees
// it (catalog.json stays the internal file name).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const web = resolve(__dirname, '..');
const visibleText = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

const pages = [...readdirSync(web).filter((f) => f.endsWith('.template.html'))];

describe('no "catalog" in what visitors read', () => {
  for (const f of pages) {
    it(f, () => {
      const hits = visibleText(readFileSync(resolve(web, f), 'utf8')).match(/[^.\n]{0,40}\bcatalogu?e?\b[^.\n]{0,40}/gi) ?? [];
      expect(hits).toEqual([]);
    });
  }
  it('collect says bharatlas, not catalog (every source file and page)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(resolve(web, dir)).flatMap((f) => (statSync(resolve(web, dir, f)).isDirectory() ? walk(`${dir}/${f}`) : [`${dir}/${f}`]));
    const files = [...walk('../collect/src').filter((f) => /\.(ts|js)$/.test(f)), '../collect/index.html', '../collect/c.html', '../collect/404.html'];
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      // Wording, not code names: "the catalog", "to catalog", "bharatlas catalog"...
      const text = readFileSync(resolve(web, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
      expect(text, f).not.toMatch(/\b(the|to|this|open|public|bharatlas|→)\s+catalogu?e?\b/i);
    }
  });
});

describe('themes, not categories, in visible labels', () => {
  it('the contribute form asks for a theme', () => {
    expect(readFileSync(resolve(web, 'preview.template.html'), 'utf8')).toMatch(/<label for="f-cat">Theme /);
  });
});
