import { describe, it, expect } from 'vitest';
import { renderViewPage } from '../functions/lib/render-view';
import type { SubmissionView } from '../functions/lib/submissions';

function row(over: Partial<SubmissionView> = {}): SubmissionView {
  return {
    id: 'rT0I6Kgo9X',
    created_at: '2026-05-20T10:00:00.000Z',
    updated_at: null,
    status: 'accepted',
    name: 'Mumbai bike lanes',
    description: 'Bike lane infrastructure for Mumbai',
    category: 'infrastructure',
    license: 'CC-BY-4.0',
    attribution: 'BBMP Open Data Portal',
    source_url: 'https://example.gov.in/data',
    is_original: 0,
    format: 'geojson',
    bytes: 1024,
    feature_count: 234,
    geometry_types: 'LineString,MultiLineString',
    r2_key: 'community/rT0I6Kgo9X/file.geojson',
    ...over,
  };
}

const ORIGIN = 'https://example.com';

describe('renderViewPage', () => {
  it('puts the submission name in the title', () => {
    const html = renderViewPage({ submission: row(), origin: ORIGIN, ratingsCount: 0, alreadyRated: false });
    expect(html).toMatch(/<title>Mumbai bike lanes · geodata<\/title>/);
  });

  it('emits a canonical URL pinned to bharatlas.com (not the request origin)', () => {
    const html = renderViewPage({ submission: row(), origin: ORIGIN, ratingsCount: 0, alreadyRated: false });
    // Canonical must be the public origin regardless of where the request
    // came from — guards against indexing localhost/dev URLs.
    expect(html).toContain('<link rel="canonical" href="https://bharatlas.com/c/rT0I6Kgo9X"');
  });

  it('emits OG + Twitter meta tags', () => {
    const html = renderViewPage({ submission: row(), origin: ORIGIN, ratingsCount: 0, alreadyRated: false });
    expect(html).toMatch(/property="og:title" content="Mumbai bike lanes"/);
    expect(html).toMatch(/name="twitter:card" content="summary"/);
  });

  it('emits a Dataset JSON-LD block with the right shape', () => {
    const html = renderViewPage({ submission: row(), origin: ORIGIN, ratingsCount: 0, alreadyRated: false });
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    const data = JSON.parse(m![1]);
    expect(data['@type']).toBe('Dataset');
    expect(data.name).toBe('Mumbai bike lanes');
    expect(data.license).toContain('creativecommons.org');
    expect(data.distribution).toHaveLength(1);
    expect(data.distribution[0].contentUrl).toMatch(/^https:\/\/bharatlas\.com\/api\/r2\/community\/rT0I6Kgo9X\/file\.geojson$/);
  });

  it('renders a download link routed via /api/r2', () => {
    const html = renderViewPage({ submission: row(), origin: ORIGIN, ratingsCount: 0, alreadyRated: false });
    // Relative path — browser resolves to current origin, no port leak in dev
    expect(html).toMatch(/href="\/api\/r2\/community\/rT0I6Kgo9X\/file\.geojson"/);
  });

  it('renders the "View on map" CTA that points at /preview with url param', () => {
    const html = renderViewPage({ submission: row(), origin: ORIGIN, ratingsCount: 0, alreadyRated: false });
    expect(html).toContain('href="/preview?url=');
    expect(html).toContain(encodeURIComponent('/api/r2/'));
  });

  it('renders up + down buttons with the current score', () => {
    const html = renderViewPage({ submission: row(), origin: ORIGIN, ratingsCount: 42, alreadyRated: false });
    expect(html).toMatch(/id="vote-up"/);
    expect(html).toMatch(/id="vote-down"/);
    expect(html).toMatch(/id="vote-score">42</);
  });

  it('escapes HTML in name / description / attribution', () => {
    const html = renderViewPage({
      submission: row({
        name: '<script>alert(1)</script>',
        description: 'a & b "c"',
        attribution: '<img onerror=x>',
      }),
      origin: ORIGIN,
      ratingsCount: 0,
      alreadyRated: false,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('&lt;img');
  });

  it('strips the header in embed mode', () => {
    const html = renderViewPage({
      submission: row(),
      origin: ORIGIN,
      ratingsCount: 0,
      alreadyRated: false,
      embed: true,
    });
    expect(html).not.toContain('<header');
  });

  it('shows "Original work by …" instead of a Source row when is_original=1', () => {
    const html = renderViewPage({
      submission: row({ is_original: 1, attribution: 'Jane Surveyor', source_url: '' }),
      origin: ORIGIN,
      ratingsCount: 0,
      alreadyRated: false,
    });
    expect(html).toContain('Original work by');
    expect(html).toContain('Jane Surveyor');
    // No source-URL row, no anchor tag pointing at example.gov.in.
    expect(html).not.toContain('example.gov.in');
  });

  it('shows a Method row when is_original=1 and source_url has text', () => {
    const html = renderViewPage({
      submission: row({ is_original: 1, source_url: 'Hand-digitized in QGIS, Aug 2025' }),
      origin: ORIGIN,
      ratingsCount: 0,
      alreadyRated: false,
    });
    expect(html).toMatch(/Method[\s\S]+Hand-digitized in QGIS/);
  });

  it('renders feature_count + bytes + format', () => {
    const html = renderViewPage({
      submission: row({ feature_count: 234, bytes: 1024 * 1024 + 500, format: 'geojson' }),
      origin: ORIGIN,
      ratingsCount: 0,
      alreadyRated: false,
    });
    expect(html).toContain('234');
    expect(html).toContain('MB');
    expect(html).toContain('geojson');
  });
});
