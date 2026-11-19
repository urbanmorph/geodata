import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lastmodLine, STATIC } from '../functions/sitemap.xml';

describe('lastmodLine', () => {
  it('emits a <lastmod> from an ISO date or datetime', () => {
    expect(lastmodLine('2024-03-15')).toBe('\n    <lastmod>2024-03-15</lastmod>');
    expect(lastmodLine('2024-03-15T08:30:00Z')).toBe('\n    <lastmod>2024-03-15</lastmod>');
  });

  it('emits nothing when fetched_at is missing or unparseable', () => {
    for (const v of [undefined, null, '', 'today', '2024', '15-03-2024']) {
      expect(lastmodLine(v as string | null | undefined)).toBe('');
    }
  });
});

describe('the served sitemap', () => {
  // functions/sitemap.xml.ts overrides the prerendered public/sitemap.xml, so
  // every top-level page the prerender lists must be in the function's list too.
  it('lists every top-level page the prerendered sitemap lists', () => {
    const prerendered = readFileSync(resolve(__dirname, '../public/sitemap.xml'), 'utf8');
    const pages = [...prerendered.matchAll(/<loc>(https:\/\/bharatlas\.com\/[a-z]*)<\/loc>/g)].map((m) => m[1]);
    expect(pages).toEqual(expect.arrayContaining(['https://bharatlas.com/layers', 'https://bharatlas.com/releases']));
    expect(STATIC.map((u) => u.loc)).toEqual(expect.arrayContaining(pages));
  });
});
