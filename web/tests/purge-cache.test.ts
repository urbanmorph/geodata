// After a deploy, CI purges the pages Cloudflare would otherwise serve stale for
// up to a day (stale-while-revalidate=86400 in _headers): the prerendered pages,
// every /view/<id> (built from index.html) and the catalog/discovery files.
import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain .mjs script
import { purgeUrls, chunks } from '../scripts/purge-cache.mjs';

const catalog = { layers: [{ id: 'lgd_states' }, { id: 'wards_ahmedabad' }, { id: 'c_abc', provenance: 'community' }] };

describe('purgeUrls', () => {
  const urls: string[] = purgeUrls(catalog, 'https://bharatlas.com');

  it('covers every prerendered page and the data/discovery files', () => {
    for (const p of ['/', '/index.html', '/about', '/docs', '/preview', '/mcp', '/privacy', '/terms', '/catalog.json', '/sitemap.xml', '/llms.txt']) {
      expect(urls).toContain(`https://bharatlas.com${p}`);
    }
  });

  it('covers every layer page, community bakes included', () => {
    expect(urls).toContain('https://bharatlas.com/view/lgd_states');
    expect(urls).toContain('https://bharatlas.com/view/wards_ahmedabad');
    expect(urls).toContain('https://bharatlas.com/view/c_abc');
  });

  it('has no duplicates', () => {
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe('chunks', () => {
  it('splits into Cloudflare-sized batches (30 URLs per purge request)', () => {
    const c = chunks(Array.from({ length: 65 }, (_, i) => i), 30);
    expect(c.map((x: number[]) => x.length)).toEqual([30, 30, 5]);
  });
});
