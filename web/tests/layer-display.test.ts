import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { displayTitle, layerHeading, prettifyId } from '../src/layer-display';

// The /view map chrome (top bar and About heading) shows the same title as the
// layer's /layers card: the level label, never a raw id, a pipeline line
// ("district · LGD · 785 rows") or the long SEO title (that one is for <title>).

describe('prettifyId', () => {
  it('turns an underscored id into spaced words', () => {
    expect(prettifyId('lgd_states')).toBe('lgd states');
    expect(prettifyId('wards_bengaluru_bbmp_2022')).toBe('wards bengaluru bbmp 2022');
  });

  it('leaves an already-clean id alone', () => {
    expect(prettifyId('airports')).toBe('airports');
  });
});

describe('displayTitle: the card label, not the SEO title', () => {
  it('prefers the label over the seo_title', () => {
    expect(
      displayTitle(
        { id: 'wards_bengaluru_gba', name: 'GBA wards' },
        { seo_title: 'Bengaluru Ward Map: 369 wards (GBA 2025)', label: 'Greater Bengaluru Wards (2025)' },
      ),
    ).toBe('Greater Bengaluru Wards (2025)');
  });

  it('falls back to the layer name when there is no level meta', () => {
    expect(displayTitle({ id: 'c_ab12', name: 'Goa Landuse Zones' })).toBe('Goa Landuse Zones');
  });

  it('falls back to the prettified id when nothing else is set', () => {
    expect(displayTitle({ id: 'wards_vadodara' })).toBe('wards vadodara');
  });

  it('treats blank / whitespace-only fields as absent and falls through', () => {
    expect(displayTitle({ id: 'wards_surat', name: 'Surat Wards' }, { label: '  ' })).toBe('Surat Wards');
  });
});

describe('layerHeading: title and a short meta line, from the catalog', () => {
  const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../catalog.json'), 'utf8'));
  const heading = (id: string) => layerHeading(catalog.layers.find((l: { id: string }) => l.id === id), catalog.level_meta);

  it('a built-in level gets its card label and count noun', () => {
    const h = heading('lgd_districts');
    expect(h.title).toBe('Districts (2024)');
    expect(h.meta).toBe('785 districts · LGD');
  });

  it('an alternate source of a level reads as that level, with its own source', () => {
    const h = heading('gb_adm4');
    expect(h.title).toBe('Blocks (2024)');
    expect(h.meta).toMatch(/^7,143 [a-z -]+ · geoBoundaries$/);
  });

  it('a ward layer gets its card label, not the long SEO title', () => {
    const h = heading('wards_bengaluru_gba');
    expect(h.title).toBe('Greater Bengaluru Wards (2025)');
    expect(h.meta).toBe('369 wards · OpenCity');
  });

  it('never shows a raw id or the word "rows", for any layer', () => {
    for (const l of catalog.layers) {
      const h = layerHeading(l, catalog.level_meta);
      expect(h.title, l.id).not.toContain('_');
      expect(h.meta, l.id).not.toMatch(/\brows\b/);
    }
  });

  it('leaves the count out when it is unknown', () => {
    expect(layerHeading({ id: 'x_y', level: null, source: 'OpenCity', rows: null, name: 'X' }, {}).meta).toBe('OpenCity');
  });
});
