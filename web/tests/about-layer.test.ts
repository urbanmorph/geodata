import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { aboutLayerHtml, downloadListHtml, wardTableHtml } from '../src/about-layer';

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
// The heading the map chrome shows (layerHeading): the card label and count noun.
const heading = { title: 'Ahmedabad Wards', unit: 'wards' };
const wardIndex = { place: 'Ahmedabad', nameLabel: 'Area', rows: [{ no: '1', name: 'Gota' }, { no: '9', name: 'Naranpura' }] };

describe('aboutLayerHtml', () => {
  const html = aboutLayerHtml({ layer, meta, heading });

  it('leads with the card title (not the SEO title) and a one-line answer: count, source, licence, date', () => {
    expect(html).toContain('<h2 class="about-panel__title" id="about-title">Ahmedabad Wards</h2>');
    expect(html).not.toContain('Ward Map');
    expect(html).toMatch(/<strong>48<\/strong> wards/);
    expect(html).toContain('OpenCity');
    expect(html).toContain('<time datetime="2026-05-26">26 May 2026</time>');
  });

  it('shows the licence as a badge linked to its terms', () => {
    expect(html).toMatch(/<a class="badge lic-badge" href="https:\/\/creativecommons.org\/publicdomain\/zero\/1.0\/"[^>]*>CC0-1.0<\/a>/);
  });

  it('flags non-commercial licences', () => {
    const nc = aboutLayerHtml({ layer: { ...layer, licence: 'CC-BY-NC-4.0' }, meta, heading });
    expect(nc).toContain('badge lic-badge lic-badge--nc');
    expect(nc).toContain('Non-commercial only');
  });

  it('lists every download with its size, through the download counter', () => {
    expect(html).toMatch(/href="\/api\/dl\/x.geojson"[^>]*>[\s\S]*GeoJSON[\s\S]*221 KB/);
    expect(html).toMatch(/Parquet[\s\S]*77 KB/);
  });

  it('adds the ward list when the ward index is known', () => {
    expect(html).not.toContain('<table');
    const withWards = aboutLayerHtml({ layer, meta, heading, wardIndex });
    expect(withWards).toContain('<table class="ward-index">');
    expect(withWards).toContain('Naranpura');
  });

  it('keeps the ward list in its own slot, so it can arrive later without re-rendering the panel', () => {
    expect(html).toContain('<div data-ward-slot></div>');
    expect(wardTableHtml(wardIndex)).toContain('<table class="ward-index">');
    expect(aboutLayerHtml({ layer, meta, heading, wardIndex })).toContain(`<div data-ward-slot>${wardTableHtml(wardIndex)}</div>`);
  });

  it('escapes data', () => {
    const bad = aboutLayerHtml({ layer: { ...layer, source: '<script>' }, meta, heading });
    expect(bad).not.toContain('<script>');
  });
});

describe('aboutLayerHtml: usage and downloads up front', () => {
  const html = aboutLayerHtml({ layer, meta, heading });
  it('has a usage line slot under the facts, filled live from /api/v1/usage', () => {
    expect(html).toMatch(/<p class="about-panel__facts">[\s\S]*?<\/p><p class="about-panel__usage" data-usage hidden><\/p>/);
    const map = readFileSync(resolve(__dirname, '../src/map.ts'), 'utf8');
    expect(map).toContain('/api/v1/usage?layer=');
    expect(map).toMatch(/usageLine\(/);
  });
  it('marks Parquet as the recommended download', () => {
    expect(html).toMatch(/Parquet <em class="dl-rec">recommended<\/em>/);
    expect(html.match(/dl-rec/g)).toHaveLength(1);
  });
});

// Audit M2: one download list on the map screen. The About panel and the
// Download menu render the same rows (format, size, what it opens in), with
// Parquet marked recommended in both.
describe('downloadListHtml: one list for the About panel and the Download menu', () => {
  const list = downloadListHtml(layer);
  it('each row has the format, its size and a use-case hint', () => {
    expect(list).toMatch(/<a class="map-popover__item" href="\/api\/dl\/x.parquet" download><span class="map-popover__fmt">Parquet <em class="dl-rec">recommended<\/em><\/span><span class="map-popover__size">77 KB<\/span><span class="map-popover__hint">analytics · DuckDB, pandas, R<\/span><\/a>/);
    expect(list).toContain('web maps, QGIS, Earth');
  });
  it('the About panel and the map menu both use it', () => {
    expect(aboutLayerHtml({ layer, meta, heading })).toContain(list);
    const map = readFileSync(resolve(__dirname, '../src/map.ts'), 'utf8');
    expect(map).toMatch(/downloadListHtml\(layer\)/);
  });
  it('the menu points to Filter only for a layer that has it (a parquet file)', () => {
    const map = readFileSync(resolve(__dirname, '../src/map.ts'), 'utf8');
    expect(map).toMatch(/layer\.parquet\?\.url\s*\?\s*`<div class="map-popover__foot">/);
  });
});
