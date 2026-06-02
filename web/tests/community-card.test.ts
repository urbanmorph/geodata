import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs import resolves at test time, no type defs
import { communityCardActions, dlProxyUrl, renderCommunityActions } from '../scripts/community-card.mjs';

const R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev';
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
const fmtBytes = (n: number) => `${Math.round(n / 1024)} KB`;

describe('dlProxyUrl', () => {
  it('routes non-pmtiles R2 urls through the counting proxy', () => {
    expect(dlProxyUrl(`${R2}/community/x/x.parquet`, 'parquet')).toBe('/api/dl/community/x/x.parquet');
    expect(dlProxyUrl(`${R2}/community/x/x.geojson`, 'geojson')).toBe('/api/dl/community/x/x.geojson');
  });

  it('leaves pmtiles as a direct R2 url (the viewer range-reads it)', () => {
    expect(dlProxyUrl(`${R2}/community/x/x.pmtiles`, 'pmtiles')).toBe(`${R2}/community/x/x.pmtiles`);
  });
});

describe('communityCardActions — unbaked submission', () => {
  const sub = { id: 'x9', r2_key: 'community/x9/goa.geojson', format: 'geojson', bytes: 1687231 };

  it('opens the lightweight /preview viewer on the raw file', () => {
    const a = communityCardActions(sub, null);
    expect(a.baked).toBe(false);
    expect(a.viewUrl).toBe(`/preview?url=${encodeURIComponent('/api/r2/community/x9/goa.geojson')}`);
  });

  it('offers a single raw download via the same-origin R2 proxy', () => {
    const a = communityCardActions(sub, null);
    expect(a.downloads).toEqual([
      { fmt: 'geojson', url: '/api/r2/community/x9/goa.geojson', size: 1687231, raw: true },
    ]);
  });
});

describe('communityCardActions — baked submission', () => {
  const sub = { id: 'x9', r2_key: 'community/x9/goa.geojson', format: 'geojson', bytes: 1687231 };
  const baked = {
    id: 'c_x9',
    provenance: 'community',
    parquet: { url: `${R2}/community/x9/x9.parquet`, bytes: 900000 },
    geojson: { url: `${R2}/community/x9/x9.geojson`, bytes: 1687231 },
    kml: { url: `${R2}/community/x9/x9.kml`, bytes: 1500000 },
  };

  it('opens the full curated viewer at /view/c_<id>', () => {
    const a = communityCardActions(sub, baked);
    expect(a.baked).toBe(true);
    expect(a.viewUrl).toBe('/view/c_x9');
  });

  it('surfaces the multi-format download strip from the catalog entry', () => {
    const a = communityCardActions(sub, baked);
    expect(a.downloads).toEqual([
      { fmt: 'parquet', url: '/api/dl/community/x9/x9.parquet', size: 900000 },
      { fmt: 'geojson', url: '/api/dl/community/x9/x9.geojson', size: 1687231 },
      { fmt: 'kml', url: '/api/dl/community/x9/x9.kml', size: 1500000 },
    ]);
  });

  it('keeps a baked pmtiles as a direct R2 url and orders it after parquet', () => {
    const a = communityCardActions(sub, {
      ...baked,
      pmtiles: { url: `${R2}/community/x9/x9.pmtiles`, bytes: 4200000 },
    });
    expect(a.downloads.map((d: { fmt: string }) => d.fmt)).toEqual(['parquet', 'pmtiles', 'geojson', 'kml']);
    const pmt = a.downloads.find((d: { fmt: string }) => d.fmt === 'pmtiles');
    expect(pmt.url).toBe(`${R2}/community/x9/x9.pmtiles`);
  });
});

describe('renderCommunityActions — visual parity markup', () => {
  const sub = { id: 'x9', r2_key: 'community/x9/goa.geojson', format: 'geojson', bytes: 1687231 };
  const baked = {
    id: 'c_x9',
    parquet: { url: `${R2}/community/x9/x9.parquet`, bytes: 900000 },
    geojson: { url: `${R2}/community/x9/x9.geojson`, bytes: 1687231 },
    kml: { url: `${R2}/community/x9/x9.kml`, bytes: 1500000 },
  };

  // The whole point: a community "View map" reads as the SAME control as a
  // curated row — the .btn-primary pill — in both baked and unbaked states.
  it('baked card uses the .btn-primary View pill → /view/c_<id> + dl-inline strip', () => {
    const html = renderCommunityActions(sub, baked, { esc, fmtBytes });
    expect(html).toContain('class="btn-primary comm-card__view"');
    expect(html).toContain('href="/view/c_x9"');
    expect(html).toContain('class="dl-inline"');
    expect(html).toContain('/api/dl/community/x9/x9.parquet');
    expect(html).not.toContain('/preview?url=');
  });

  it('unbaked card uses the SAME .btn-primary View pill → /preview + single raw download', () => {
    const html = renderCommunityActions(sub, null, { esc, fmtBytes });
    expect(html).toContain('class="btn-primary comm-card__view"');
    expect(html).toContain('/preview?url=');
    expect(html).toContain('class="btn comm-card__dl"');
    expect(html).toMatch(/href="\/api\/r2\/community\/x9\/goa\.geojson"[^>]*download=/);
  });
});
