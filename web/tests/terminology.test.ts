// The site's words (owner, 2026-11-17): "layer" and "theme" in visible copy;
// "category" only in the API, MCP and code; no "catalog" anywhere a reader sees
// it (catalog.json stays the internal file name).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const web = resolve(__dirname, '..');
const visibleText = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

const pages = [...readdirSync(web).filter((f) => f.endsWith('.template.html')), 'submit.html'];

describe('no "catalog" in what visitors read', () => {
  for (const f of pages) {
    it(f, () => {
      const hits = visibleText(readFileSync(resolve(web, f), 'utf8')).match(/[^.\n]{0,40}\bcatalogu?e?\b[^.\n]{0,40}/gi) ?? [];
      expect(hits).toEqual([]);
    });
  }
  it('collect says bharatlas, not catalog', () => {
    for (const f of ['../collect/src/app.ts', '../collect/src/landing.ts', '../collect/src/create/wizard.ts', '../collect/src/geo/layer-picker.ts']) {
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
