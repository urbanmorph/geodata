import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The collect landing is the one indexable page (maps under /c/ are not):
// it needs a share image and says what it is to search engines.
const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
const robots = readFileSync(resolve(__dirname, '..', 'public', 'robots.txt'), 'utf8');

describe('collect landing head', () => {
  it('has a share image', () => {
    expect(html).toMatch(/<meta property="og:image" content="https:\/\/[^"]+\.png" \/>/);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it('describes itself as a free WebApplication by bharatlas', () => {
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    const ld = JSON.parse(m![1]);
    expect(ld).toMatchObject({
      '@type': 'WebApplication', name: 'collect', url: 'https://collect.bharatlas.com/',
      isAccessibleForFree: true, publisher: { name: 'bharatlas', url: 'https://bharatlas.com' },
    });
  });

  it('robots.txt has no em-dash', () => {
    expect(robots).not.toContain('—');
  });
});
