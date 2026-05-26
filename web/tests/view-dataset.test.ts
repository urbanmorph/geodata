import { describe, it, expect } from 'vitest';
import { buildViewDataset, buildViewContent, resolveLevelMeta, type CatalogLayer } from '../functions/lib/view-dataset';

const layer: CatalogLayer = {
  id: 'lgd_villages',
  level: 'village',
  source: 'LGD',
  rows: 584615,
  licence: 'CC0-1.0',
};

const ORIGIN = 'https://bharatlas.com';

describe('buildViewDataset', () => {
  it('uses levelMeta.label as title; falls back to humanised id', () => {
    expect(buildViewDataset(layer, { label: 'Indian villages' }, ORIGIN).title).toBe('Indian villages');
    expect(buildViewDataset(layer, undefined, ORIGIN).title).toBe('lgd villages');
  });

  it('builds canonical + ogImage from origin + layer id', () => {
    const v = buildViewDataset(layer, undefined, ORIGIN);
    expect(v.canonical).toBe('https://bharatlas.com/view/lgd_villages');
    expect(v.ogImage).toBe('https://bharatlas.com/og/view/lgd_villages.png');
  });

  it('caps the meta description at 158 chars (Google SERP snippet ceiling)', () => {
    const longDesc = 'a'.repeat(300);
    const v = buildViewDataset(layer, { label: 'X', description: longDesc }, ORIGIN);
    expect(v.description.length).toBeLessThanOrEqual(158);
  });

  it('JSON-LD description is ≥50 chars even when source is shorter', () => {
    const v = buildViewDataset(
      { ...layer, rows: null },
      { label: 'X', description: 'short' }, // only 5 chars
      ORIGIN,
    );
    expect(v.ldDescription.length).toBeGreaterThanOrEqual(50);
    expect(v.jsonLd.description).toBe(v.ldDescription);
  });

  it('emits a BreadcrumbList JSON-LD with Home → Catalog → <layer>', () => {
    const v = buildViewDataset(layer, { label: 'Villages' }, ORIGIN);
    expect(v.breadcrumbJsonLd).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://bharatlas.com/' },
        { '@type': 'ListItem', position: 2, name: 'Catalog', item: 'https://bharatlas.com/' },
        { '@type': 'ListItem', position: 3, name: 'Villages', item: 'https://bharatlas.com/view/lgd_villages' },
      ],
    });
  });

  it('emits a Dataset JSON-LD with the required shape', () => {
    const v = buildViewDataset(layer, { label: 'Villages' }, ORIGIN);
    expect(v.jsonLd).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: 'Villages',
      url: 'https://bharatlas.com/view/lgd_villages',
      creator: { '@type': 'Organization', name: 'LGD' },
      spatialCoverage: { '@type': 'Place', name: 'India' },
    });
  });

  it('maps known licences to canonical URLs', () => {
    const cases: Array<[string, string]> = [
      ['CC0-1.0', 'https://creativecommons.org/publicdomain/zero/1.0/'],
      ['CC-BY-4.0', 'https://creativecommons.org/licenses/by/4.0/'],
      ['CC-BY-SA-4.0', 'https://creativecommons.org/licenses/by-sa/4.0/'],
      ['ODbL-1.0', 'https://opendatacommons.org/licenses/odbl/1-0/'],
    ];
    for (const [input, expected] of cases) {
      const v = buildViewDataset({ ...layer, licence: input }, undefined, ORIGIN);
      expect(v.jsonLd.license).toBe(expected);
    }
  });

  it('passes through unknown licences as-is', () => {
    const v = buildViewDataset({ ...layer, licence: 'WTFPL' }, undefined, ORIGIN);
    expect(v.jsonLd.license).toBe('WTFPL');
  });

  it('omits license when not provided', () => {
    const v = buildViewDataset({ ...layer, licence: undefined }, undefined, ORIGIN);
    expect(v.jsonLd.license).toBeUndefined();
  });
});

describe('resolveLevelMeta', () => {
  it('returns catalog level_meta by layer.id for external layers', () => {
    const ext = { wards_bengaluru_gba: { label: 'GBA Wards', unit: 'wards' } };
    const result = resolveLevelMeta({ ...layer, id: 'wards_bengaluru_gba', level: 'wards_bengaluru_gba' }, ext);
    expect(result?.label).toBe('GBA Wards');
  });

  it('falls back to builtin LEVEL_META by layer.level for curated layers', () => {
    const result = resolveLevelMeta(layer, undefined);
    expect(result?.label).toBe('Villages (2024)');
  });

  it('prefers catalog over builtin when both match', () => {
    const ext = { lgd_villages: { label: 'Custom Villages' } };
    const result = resolveLevelMeta(layer, ext);
    expect(result?.label).toBe('Custom Villages');
  });

  it('returns undefined for unknown layers with no catalog entry', () => {
    const result = resolveLevelMeta({ ...layer, id: 'unknown', level: 'unknown' }, undefined);
    expect(result).toBeUndefined();
  });
});

describe('buildViewContent', () => {
  it('returns an article with the layer title in an h1', () => {
    const html = buildViewContent(layer, { label: 'Indian villages' }, ORIGIN);
    expect(html).toContain('<h1');
    expect(html).toContain('Indian villages');
  });

  it('falls back to humanised id when no levelMeta', () => {
    const html = buildViewContent(layer, undefined, ORIGIN);
    expect(html).toContain('lgd villages');
  });

  it('includes feature count formatted with Indian locale', () => {
    const html = buildViewContent(layer, { label: 'Villages', unit: 'villages' }, ORIGIN);
    expect(html).toContain('5,84,615');
    expect(html).toContain('villages');
  });

  it('includes source and licence', () => {
    const html = buildViewContent(layer, undefined, ORIGIN);
    expect(html).toContain('LGD');
    expect(html).toContain('CC0-1.0');
  });

  it('includes description from levelMeta', () => {
    const html = buildViewContent(layer, { label: 'V', description: 'Revenue villages of India' }, ORIGIN);
    expect(html).toContain('Revenue villages of India');
  });

  it('includes download links when present', () => {
    const withDownloads: CatalogLayer = {
      ...layer,
      geojson: { url: 'https://r2.example.com/villages.geojson', bytes: 2048000 },
      kml: { url: 'https://r2.example.com/villages.kml', bytes: 1024000 },
    };
    const html = buildViewContent(withDownloads, undefined, ORIGIN);
    expect(html).toContain('GeoJSON');
    expect(html).toContain('KML');
    expect(html).toContain('href="https://r2.example.com/villages.geojson"');
  });

  it('escapes HTML entities in title', () => {
    const html = buildViewContent(
      { ...layer, id: 'test<script>' },
      { label: 'Test<script>alert(1)</script>' },
      ORIGIN,
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('includes canonical link to the view page', () => {
    const html = buildViewContent(layer, undefined, ORIGIN);
    expect(html).toContain(`${ORIGIN}/view/lgd_villages`);
  });

  it('omits count line when rows is null', () => {
    const noRows: CatalogLayer = { ...layer, rows: null };
    const html = buildViewContent(noRows, undefined, ORIGIN);
    expect(html).not.toContain('<strong>');
  });
});
