import { describe, it, expect } from 'vitest';
import { displayTitle, prettifyId } from '../src/layer-display';

// The /view map chrome currently shows the raw layer id ("wards_..."),
// truncated, which reads as broken on mobile. displayTitle resolves the same
// human title the edge uses (functions/lib/view-dataset.ts buildViewDataset):
// seo_title > label > name > prettified id. Keep the two in sync.

describe('prettifyId', () => {
  it('turns an underscored id into spaced words', () => {
    expect(prettifyId('lgd_states')).toBe('lgd states');
    expect(prettifyId('wards_bengaluru_bbmp_2022')).toBe('wards bengaluru bbmp 2022');
  });

  it('leaves an already-clean id alone', () => {
    expect(prettifyId('airports')).toBe('airports');
  });
});

describe('displayTitle (precedence mirrors the edge buildViewDataset title)', () => {
  it('prefers seo_title above everything', () => {
    expect(
      displayTitle(
        { id: 'wards_bengaluru_bbmp_2022', name: 'BBMP wards' },
        { seo_title: 'Bengaluru Ward Map', label: 'Wards' },
      ),
    ).toBe('Bengaluru Ward Map');
  });

  it('falls back to label when seo_title is absent', () => {
    expect(displayTitle({ id: 'lgd_states' }, { label: 'States (2024)' })).toBe('States (2024)');
  });

  it('falls back to the layer name when there is no level meta', () => {
    expect(displayTitle({ id: 'c_ab12', name: 'Goa Landuse Zones' })).toBe('Goa Landuse Zones');
  });

  it('falls back to the prettified id when nothing else is set', () => {
    expect(displayTitle({ id: 'wards_vadodara' })).toBe('wards vadodara');
  });

  it('treats blank / whitespace-only fields as absent and falls through', () => {
    expect(
      displayTitle({ id: 'wards_surat', name: 'Surat Wards' }, { seo_title: '   ', label: '' }),
    ).toBe('Surat Wards');
  });

  it('gives a ward layer a friendly title, never the raw id', () => {
    const title = displayTitle(
      { id: 'wards_ahmedabad', name: 'Ahmedabad Wards' },
      { seo_title: 'Ahmedabad Ward Map', label: 'Wards' },
    );
    expect(title).toBe('Ahmedabad Ward Map');
    expect(title).not.toContain('_');
  });
});
