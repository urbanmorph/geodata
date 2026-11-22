import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { curatedMetadata, curatedCard, communityMetadata } from '../functions/lib/og-metadata';
import { buildViewDataset, layerLevelMeta } from '../functions/lib/view-dataset';

// An alternate source of a level (Bhuvan, PMGSY, geoBoundaries blocks next to
// LGD's) took the bare level label, so every sibling's card read "Blocks" and
// the cut-off subtitle hid the source. Its card now carries the /view title.
describe('curatedCard', () => {
  const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../catalog.json'), 'utf8'));
  const byId = (id: string) => catalog.layers.find((l: { id: string }) => l.id === id);
  const card = (id: string) => curatedCard(byId(id), catalog.level_meta, catalog.layers);
  const viewTitleOf = (id: string) =>
    buildViewDataset(byId(id), layerLevelMeta(byId(id), catalog.level_meta, catalog.layers), 'https://bharatlas.com').title;

  it("an alternate source's card title is its /view page title", () => {
    expect(card('bhuvan_blocks').title).toBe('Blocks from Bhuvan');
    for (const id of ['pmgsy_blocks', 'gb_adm4', 'soi_districts', 'bhuvan_states']) {
      expect(card(id).title, id).toBe(viewTitleOf(id));
    }
  });

  it("the level's primary layer keeps its level label", () => {
    expect(card('lgd_blocks').title).toBe('Blocks (2024)');
  });

  it('a layer with its own SEO title (a ward map) keeps the short label on its card', () => {
    const ward = catalog.layers.find((l: { id: string }) => /^wards_/.test(l.id) && catalog.level_meta[l.id]?.seo_title);
    expect(card(ward.id).title).toBe(catalog.level_meta[ward.id].label);
  });
});

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
