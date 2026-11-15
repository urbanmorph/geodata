import { describe, it, expect } from 'vitest';
import { wardLayersAt, resolveLocateLayers, FALLBACK_WARD_LAYER, wardFallbackNeeded, mergeLocateResults } from '../functions/lib/ward-locate';
import { WARD_BBOXES } from '../functions/lib/ward-bboxes';
import { DEFAULT_LOCATE_LAYERS } from '../functions/lib/locate';

// Controlled fixture so the logic tests don't depend on the generated table.
// alpha and beta overlap; gamma is far away. [west, south, east, north].
const FIX = {
  wards_alpha: [77.0, 12.0, 78.0, 13.0],
  wards_beta: [77.5, 12.5, 78.5, 13.5],
  wards_gamma: [80.0, 13.0, 80.5, 13.5],
} as const;

const DEFAULTS = ['lgd_states', 'lgd_districts', 'bharatviz_pincodes'] as const;

describe('wardLayersAt', () => {
  it('returns the one ward layer whose bbox contains the point', () => {
    expect(wardLayersAt(77.2, 12.2, FIX, 0)).toEqual(['wards_alpha']);
  });

  it('returns every covering layer when bboxes overlap, sorted', () => {
    expect(wardLayersAt(77.6, 12.6, FIX, 0)).toEqual(['wards_alpha', 'wards_beta']);
  });

  it('returns nothing when the point is outside every ward bbox', () => {
    expect(wardLayersAt(90, 30, FIX, 0)).toEqual([]);
  });

  it('is inclusive on the bbox edge', () => {
    expect(wardLayersAt(77.0, 12.0, FIX, 0)).toContain('wards_alpha');
  });

  it('applies a small margin so a point just outside still matches', () => {
    // 0.005 west of alpha's edge: inside the default margin, still a hit.
    expect(wardLayersAt(76.995, 12.5, FIX, 0.01)).toEqual(['wards_alpha']);
    // well outside the margin: no hit.
    expect(wardLayersAt(76.5, 12.5, FIX, 0.01)).toEqual([]);
  });
});

describe('resolveLocateLayers', () => {
  it('respects an explicit layers list verbatim and never auto-adds wards', () => {
    expect(resolveLocateLayers('lgd_states, wards_chennai', 77.6, 12.6, DEFAULTS, FIX, 0))
      .toEqual(['lgd_states', 'wards_chennai']);
  });

  it('trims and drops blanks in an explicit list', () => {
    expect(resolveLocateLayers(' lgd_states , , lgd_districts ', 0, 0, DEFAULTS, FIX, 0))
      .toEqual(['lgd_states', 'lgd_districts']);
  });

  it('on the default path appends the covering ward layer(s), defaults first', () => {
    expect(resolveLocateLayers(null, 77.2, 12.2, DEFAULTS, FIX, 0))
      .toEqual([...DEFAULTS, 'wards_alpha']);
  });

  it('treats an empty / whitespace param as the default path', () => {
    expect(resolveLocateLayers('', 77.6, 12.6, DEFAULTS, FIX, 0))
      .toEqual([...DEFAULTS, 'wards_alpha', 'wards_beta']);
    expect(resolveLocateLayers('   ', 77.6, 12.6, DEFAULTS, FIX, 0))
      .toEqual([...DEFAULTS, 'wards_alpha', 'wards_beta']);
  });

  it('dedupes so a ward already in defaults is not repeated', () => {
    expect(resolveLocateLayers(null, 77.2, 12.2, ['lgd_states', 'wards_alpha'], FIX, 0))
      .toEqual(['lgd_states', 'wards_alpha']);
  });

  it('default path with no city ward layer falls back to the national SBM wards', () => {
    // "Ward number of my location" is the top search; SBM covers ~3,300 towns.
    expect(resolveLocateLayers(null, 90, 30, DEFAULTS, FIX, 0)).toEqual([...DEFAULTS, FALLBACK_WARD_LAYER]);
    expect(FALLBACK_WARD_LAYER).toBe('sbm_wards');
  });

  it('does not add the fallback where a city ward layer covers the point', () => {
    expect(resolveLocateLayers(null, 77.2, 12.2, DEFAULTS, FIX, 0)).not.toContain(FALLBACK_WARD_LAYER);
  });

  it('never adds the fallback to an explicit layers list', () => {
    expect(resolveLocateLayers('lgd_states', 90, 30, DEFAULTS, FIX, 0)).toEqual(['lgd_states']);
  });
});

describe('WARD_BBOXES (generated table) is well-formed', () => {
  it('is non-empty and every entry is a valid wards_* bbox', () => {
    const keys = Object.keys(WARD_BBOXES);
    expect(keys.length).toBeGreaterThan(20);
    for (const [id, b] of Object.entries(WARD_BBOXES)) {
      expect(id.startsWith('wards_')).toBe(true);
      expect(b).toHaveLength(4);
      expect(b.every((n) => Number.isFinite(n))).toBe(true);
      expect(b[0]).toBeLessThan(b[2]); // west < east
      expect(b[1]).toBeLessThan(b[3]); // south < north
    }
  });

  it('resolves a central Bengaluru point to both ward vintages', () => {
    const hits = wardLayersAt(77.5946, 12.9716, WARD_BBOXES);
    expect(hits).toContain('wards_bengaluru_gba');
    expect(hits).toContain('wards_bengaluru_bbmp_2022');
  });

  it('resolves a Chennai point to the Chennai wards and not Bengaluru', () => {
    const hits = wardLayersAt(80.2707, 13.0827, WARD_BBOXES);
    expect(hits).toContain('wards_chennai');
    expect(hits).not.toContain('wards_bengaluru_gba');
  });

  it('returns nothing over open sea', () => {
    expect(wardLayersAt(88.0, 15.0, WARD_BBOXES)).toEqual([]);
  });
});

describe('default locate layer set (real wiring)', () => {
  it('appends the covering Bengaluru wards to the real default set', () => {
    const ids = resolveLocateLayers(null, 77.5946, 12.9716, DEFAULT_LOCATE_LAYERS);
    for (const d of DEFAULT_LOCATE_LAYERS) expect(ids).toContain(d);
    expect(ids).toContain('wards_bengaluru_gba');
    expect(ids).toContain('wards_bengaluru_bbmp_2022');
    expect(new Set(ids).size).toBe(ids.length); // no dupes
  });

  it('adds only the national SBM wards where no city ward covers the point', () => {
    // Interior Madhya Pradesh: no city ward layer there, so the SBM fallback.
    expect(resolveLocateLayers(null, 78.5, 23.5, DEFAULT_LOCATE_LAYERS))
      .toEqual([...DEFAULT_LOCATE_LAYERS, FALLBACK_WARD_LAYER]);
  });
});

describe('second-pass ward fallback', () => {
  const ward = (id: string) => ({ layer_id: id, feature: { properties: {} } });
  it('is needed when city ward layers were asked but found no ward (Jaipur Heritage)', () => {
    expect(wardFallbackNeeded(null, ['lgd_states', 'wards_jaipur'], { boundaries: [ward('lgd_states')] })).toBe(true);
  });
  it('is not needed when a city ward layer answered', () => {
    expect(wardFallbackNeeded(null, ['wards_indore'], { 'city-wards': [ward('wards_indore')] })).toBe(false);
  });
  it('is not needed when the fallback was already asked, or for an explicit layers list', () => {
    expect(wardFallbackNeeded(null, ['sbm_wards'], { boundaries: [] })).toBe(false);
    expect(wardFallbackNeeded('wards_jaipur', ['wards_jaipur'], { boundaries: [] })).toBe(false);
  });
  it('merges a second locate result into the first, by group', () => {
    const merged = mergeLocateResults(
      { boundaries: [ward('lgd_states')] }, { 'city-wards': [ward('sbm_wards')], boundaries: [ward('x')] });
    expect(merged).toEqual({ boundaries: [ward('lgd_states'), ward('x')], 'city-wards': [ward('sbm_wards')] });
  });
});
