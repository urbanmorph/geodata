import { describe, it, expect } from 'vitest';
import { aboutLayerHtml } from '../src/about-layer';

const layer = {
  id: 'wards_ahmedabad',
  source: 'OpenCity',
  licence: 'CC0-1.0',
  rows: 48,
  fetched_at: '2026-05-26T10:00:00Z',
  description: 'Ward boundaries of the Ahmedabad Municipal Corporation.',
  geojson: { url: 'https://r2/x.geojson', bytes: 226794 },
  parquet: { url: 'https://r2/x.parquet', bytes: 79257 },
};
const meta = { label: 'Ahmedabad Wards', seo_title: 'Ahmedabad Ward Map: 48 wards (AMC)', unit: 'wards' };
const wardIndex = { place: 'Ahmedabad', nameLabel: 'Area', rows: [{ no: '1', name: 'Gota' }, { no: '9', name: 'Naranpura' }] };

describe('aboutLayerHtml', () => {
  const html = aboutLayerHtml({ layer, meta });

  it('leads with the title and a one-line answer: count, source, licence, date', () => {
    expect(html).toContain('<h2 class="about-panel__title" id="about-title">Ahmedabad Ward Map: 48 wards (AMC)</h2>');
    expect(html).toMatch(/<strong>48<\/strong> wards/);
    expect(html).toContain('OpenCity');
    expect(html).toContain('<time datetime="2026-05-26">26 May 2026</time>');
  });

  it('shows the licence as a badge linked to its terms', () => {
    expect(html).toMatch(/<a class="lic-badge" href="https:\/\/creativecommons.org\/publicdomain\/zero\/1.0\/"[^>]*>CC0-1.0<\/a>/);
  });

  it('flags non-commercial licences', () => {
    const nc = aboutLayerHtml({ layer: { ...layer, licence: 'CC-BY-NC-4.0' }, meta });
    expect(nc).toContain('lic-badge lic-badge--nc');
    expect(nc).toContain('Non-commercial only');
  });

  it('lists every download with its size', () => {
    expect(html).toMatch(/href="https:\/\/r2\/x.geojson"[^>]*>[\s\S]*GeoJSON[\s\S]*221 KB/);
    expect(html).toMatch(/Parquet[\s\S]*77 KB/);
  });

  it('adds the ward list when the ward index is known', () => {
    expect(html).not.toContain('<table');
    const withWards = aboutLayerHtml({ layer, meta, wardIndex });
    expect(withWards).toContain('<table class="ward-index">');
    expect(withWards).toContain('Naranpura');
  });

  it('escapes data', () => {
    const bad = aboutLayerHtml({ layer: { ...layer, source: '<script>' }, meta });
    expect(bad).not.toContain('<script>');
  });
});
