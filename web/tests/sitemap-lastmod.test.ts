import { describe, it, expect } from 'vitest';
import { sitemapXml } from '../functions/sitemap.xml';
import { STATIC_PAGES, releasePages, urlset, lastmodLine } from '../../shared/sitemap.mjs';

describe('sitemap lastmod', () => {
  it('emits a <lastmod> from an ISO date or datetime', () => {
    expect(lastmodLine('2026-05-25T17:02:55+00:00')).toBe('\n    <lastmod>2026-05-25</lastmod>');
    expect(lastmodLine('2026-05-25')).toBe('\n    <lastmod>2026-05-25</lastmod>');
  });
  it('emits nothing when fetched_at is missing or unparseable', () => {
    expect(lastmodLine(undefined)).toBe('');
    expect(lastmodLine(null)).toBe('');
    expect(lastmodLine('')).toBe('');
    expect(lastmodLine('not a date')).toBe('');
  });
});

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const index = { latest: { lgd_states: 'bharatlas-lgd_states-2026.12', wards_delhi: 'bharatlas-wards_delhi-2026.12' } };

describe('the served sitemap', () => {
  it('lists each dataset\'s release page (it left them out before 2026-11-22)', () => {
    const xml = sitemapXml({ releases: index, curated: [], community: [] });
    expect(locs(xml)).toEqual(expect.arrayContaining([
      'https://bharatlas.com/releases/lgd_states', 'https://bharatlas.com/releases/wards_delhi',
    ]));
  });

  it('lists everything the build-time sitemap lists, plus the layers and community pages', () => {
    const built = locs(urlset([...STATIC_PAGES, ...releasePages(index)]));
    const served = locs(sitemapXml({
      releases: index,
      curated: [{ id: 'lgd_states', fetched_at: '2026-05-25' }],
      community: [{ id: 'abc', created_at: '2026-10-01T00:00:00Z', updated_at: null }],
    }));
    expect(served).toEqual(expect.arrayContaining(built));
    expect(served).toEqual(expect.arrayContaining(['https://bharatlas.com/view/lgd_states', 'https://bharatlas.com/c/abc']));
  });

  it('still serves the static pages when the release index cannot be read', () => {
    const served = locs(sitemapXml({ releases: null, curated: [], community: [] }));
    expect(served).toEqual(expect.arrayContaining(['https://bharatlas.com/', 'https://bharatlas.com/releases']));
  });

  it('escapes and dates entries the same way as before', () => {
    const xml = sitemapXml({ releases: null, curated: [], community: [{ id: 'a&b', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-05T00:00:00Z' }] });
    expect(xml).toContain('<loc>https://bharatlas.com/c/a&amp;b</loc>\n    <lastmod>2026-10-05</lastmod>');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
  });
});
