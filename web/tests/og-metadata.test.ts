import { describe, it, expect } from 'vitest';
import { curatedMetadata, communityMetadata } from '../functions/lib/og-metadata';

describe('curatedMetadata', () => {
  it('uses levelMeta.label as the title when available', () => {
    const m = curatedMetadata({
      layer: { id: 'lgd_villages', level: 'village', source: 'LGD', rows: 584615 },
      levelMeta: { label: 'Indian villages', unit: 'polygons' },
    });
    expect(m.title).toBe('Indian villages');
  });

  it('falls back to humanised layer id when no levelMeta', () => {
    const m = curatedMetadata({
      layer: { id: 'wards_chennai', level: 'wards_chennai', source: 'OpenCity', rows: 200 },
    });
    expect(m.title).toBe('wards chennai');
  });

  it('builds a subtitle with locale-formatted count + unit + source', () => {
    const m = curatedMetadata({
      layer: { id: 'lgd_villages', level: 'village', source: 'LGD', rows: 584615 },
      levelMeta: { label: 'X', unit: 'polygons' },
    });
    expect(m.subtitle).toBe('5,84,615 polygons · LGD');
  });

  it('uses "features" as default unit when levelMeta.unit is absent', () => {
    const m = curatedMetadata({
      layer: { id: 'x', level: 'x', source: 'LGD', rows: 10 },
      levelMeta: { label: 'X' },
    });
    expect(m.subtitle).toBe('10 features · LGD');
  });

  it('omits the count when rows is null (unknown)', () => {
    const m = curatedMetadata({
      layer: { id: 'x', level: 'x', source: 'LGD', rows: null },
      levelMeta: { label: 'X' },
    });
    expect(m.subtitle).toBe('LGD');
  });

  it('tags every curated card with "curated"', () => {
    const m = curatedMetadata({
      layer: { id: 'x', level: 'x', source: 'LGD', rows: 0 },
    });
    expect(m.tag).toBe('curated');
  });

  it('puts licence in the footer when present', () => {
    const m = curatedMetadata({
      layer: { id: 'x', level: 'x', source: 'LGD', rows: 0, licence: 'CC0-1.0' },
    });
    expect(m.footerLeft).toBe('licence · CC0-1.0');
  });

  it('omits the footer when no licence', () => {
    const m = curatedMetadata({
      layer: { id: 'x', level: 'x', source: 'LGD', rows: 0 },
    });
    expect(m.footerLeft).toBeUndefined();
  });
});

describe('communityMetadata', () => {
  it('uses submission.name as the title', () => {
    const m = communityMetadata({
      id: 'Xa9Kp7n',
      name: 'Bengaluru bike lanes',
      license: 'CC-BY-4.0',
      attribution: 'BBMP Open Data',
      feature_count: 287,
      format: 'geojson',
      geometry_types: 'MultiLineString',
      category: 'transport',
    });
    expect(m.title).toBe('Bengaluru bike lanes');
  });

  it('builds a subtitle combining count + geometry + category', () => {
    const m = communityMetadata({
      id: 'X',
      name: 'X',
      license: 'CC-BY-4.0',
      attribution: 'X',
      feature_count: 287,
      format: 'geojson',
      geometry_types: 'MultiLineString',
      category: 'transport',
    });
    expect(m.subtitle).toBe('287 features · MultiLineString · transport');
  });

  it('falls back to format when feature_count is null', () => {
    const m = communityMetadata({
      id: 'X', name: 'X', license: 'CC-BY-4.0', attribution: 'X',
      feature_count: null, format: 'parquet',
    });
    expect(m.subtitle).toBe('parquet');
  });

  it('tags every community card with "community"', () => {
    const m = communityMetadata({
      id: 'X', name: 'X', license: 'CC-BY-4.0', attribution: 'X',
      feature_count: 0, format: 'geojson',
    });
    expect(m.tag).toBe('community');
  });

  it('builds footerLeft as "attribution · licence"', () => {
    const m = communityMetadata({
      id: 'X', name: 'X', license: 'CC-BY-4.0',
      attribution: 'BBMP Open Data',
      feature_count: 0, format: 'geojson',
    });
    expect(m.footerLeft).toBe('BBMP Open Data · CC-BY-4.0');
  });
});
