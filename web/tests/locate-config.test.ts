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

  it('returns null for a layer with no config and no ward match', () => {
    expect(resolveLocateConfig({ id: 'lgd_states', level: 'state' })).toBeNull();
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
