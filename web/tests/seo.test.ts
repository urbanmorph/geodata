import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function metaContent(html: string, name: string, attr = 'name'): string | null {
  const m = html.match(new RegExp(`<meta\\s+${attr}="${name}"[^>]*content="([^"]+)"`));
  return m ? m[1] : null;
}

describe('SEO — meta description length budget (Google truncates ~158)', () => {
  // Targeting the Google snippet ceiling. Below 158 ensures the
  // description displays in full on the SERP without "...".
  const MAX = 158;

  it('home description ≤ 158 chars', () => {
    const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
    const desc = metaContent(html, 'description');
    expect(desc).not.toBeNull();
    expect(desc!.length, `home desc: ${desc!.length} chars: "${desc}"`).toBeLessThanOrEqual(MAX);
  });

  it('about description ≤ 158 chars', () => {
    const html = readFileSync(resolve(__dirname, '..', 'about.html'), 'utf8');
    const desc = metaContent(html, 'description');
    expect(desc).not.toBeNull();
    expect(desc!.length, `about desc: ${desc!.length} chars: "${desc}"`).toBeLessThanOrEqual(MAX);
  });

  it('preview description ≤ 158 chars', () => {
    const html = readFileSync(resolve(__dirname, '..', 'preview.html'), 'utf8');
    const desc = metaContent(html, 'description');
    expect(desc).not.toBeNull();
    expect(desc!.length, `preview desc: ${desc!.length} chars: "${desc}"`).toBeLessThanOrEqual(MAX);
  });
});

describe('SEO — every prerendered page has an h1', () => {
  for (const page of ['index.html', 'about.html', 'preview.html']) {
    it(`${page} has a non-empty <h1>`, () => {
      const html = readFileSync(resolve(__dirname, '..', page), 'utf8');
      const m = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
      expect(m, `${page} missing <h1>`).not.toBeNull();
      expect(m![1].trim().length, `${page} <h1> is empty`).toBeGreaterThan(0);
    });
  }
});
