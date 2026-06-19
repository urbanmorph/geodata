import { describe, it, expect } from 'vitest';
import { resolveLocateConfig } from '../src/locate-config';

// Decides whether the "Find my location" item shows on a layer, its short
// toolbar label, and the spatial mode. Explicit per-layer config (curated
// level_meta / baked community) wins; for Step 1a ward layers are auto-enabled
// as a built-in so the feature lights up without a catalog change.

describe('resolveLocateConfig', () => {
  it('auto-enables ward layers as contains (1a built-in)', () => {
    expect(resolveLocateConfig({ id: 'wards_bengaluru_bbmp_2022', level: 'wards_bengaluru_bbmp_2022' }))
      .toEqual({ label: 'My ward', mode: 'contains' });
    expect(resolveLocateConfig({ id: 'wards_ahmedabad' }))
      .toEqual({ label: 'My ward', mode: 'contains' });
  });

  it('auto-enables admin + zone layers by their level (1b built-ins)', () => {
    expect(resolveLocateConfig({ id: 'lgd_districts', level: 'district' })).toEqual({ label: 'My district', mode: 'contains' });
    expect(resolveLocateConfig({ id: 'lgd_villages', level: 'village' })).toEqual({ label: 'My village', mode: 'contains' });
    expect(resolveLocateConfig({ id: 'lgd_panchayats', level: 'panchayat' })).toEqual({ label: 'My panchayat', mode: 'contains' });
    expect(resolveLocateConfig({ id: 'lgd_assembly', level: 'assembly_constituency' })).toEqual({ label: 'My MLA', mode: 'contains' });
    expect(resolveLocateConfig({ id: 'lgd_parliament', level: 'parliament_constituency' })).toEqual({ label: 'My MP', mode: 'contains' });
    expect(resolveLocateConfig({ id: 'seismic_zones', level: 'seismic_zone' })).toEqual({ label: 'Seismic zone', mode: 'contains' });
    expect(resolveLocateConfig({ id: 'bm_eco_zones', level: 'eco_zone' })).toEqual({ label: 'Eco-zone', mode: 'contains' });
  });

  it('does NOT enable state (too obvious) or unmapped levels', () => {
    expect(resolveLocateConfig({ id: 'lgd_states', level: 'state' })).toBeNull();
    expect(resolveLocateConfig({ id: 'airports', level: 'airport' })).toBeNull();
  });

  it('level_meta.locate_label still overrides a level built-in', () => {
    expect(resolveLocateConfig({ id: 'lgd_districts', level: 'district' }, { locate_label: 'Find your district' }))
      .toEqual({ label: 'Find your district', mode: 'contains' });
  });

  it('returns null for a layer with no config and no ward match', () => {
    expect(resolveLocateConfig({ id: 'datagov_pincodes', level: 'pincode' })).toBeNull();
  });

  it('uses an explicit level_meta.locate_label (contains by default)', () => {
    expect(resolveLocateConfig({ id: 'seismic_zones', level: 'seismic_zone' }, { locate_label: 'Which zone?' }))
      .toEqual({ label: 'Which zone?', mode: 'contains' });
  });

  it('honours locate_mode=nearest', () => {
    expect(resolveLocateConfig({ id: 'health_facilities' }, { locate_label: 'Nearby', locate_mode: 'nearest' }))
      .toEqual({ label: 'Nearby', mode: 'nearest' });
  });

  it('explicit config wins over the ward built-in', () => {
    expect(resolveLocateConfig({ id: 'wards_x' }, { locate_label: 'Find your ward', locate_mode: 'contains' }))
      .toEqual({ label: 'Find your ward', mode: 'contains' });
  });

  it('treats a blank/whitespace label as absent', () => {
    expect(resolveLocateConfig({ id: 'lgd_states' }, { locate_label: '   ' })).toBeNull();
    expect(resolveLocateConfig({ id: 'wards_x' }, { locate_label: '' }))
      .toEqual({ label: 'My ward', mode: 'contains' });
  });
});
