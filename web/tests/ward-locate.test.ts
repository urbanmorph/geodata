import { describe, it, expect } from 'vitest';
import { wardLayersAt, resolveLocateLayers } from '../functions/lib/ward-locate';
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

  it('default path with no covering ward returns just the defaults', () => {
    expect(resolveLocateLayers(null, 90, 30, DEFAULTS, FIX, 0)).toEqual([...DEFAULTS]);
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

  it('leaves the default set unchanged where no city ward covers the point', () => {
    // Rural point in interior Madhya Pradesh — no city ward layer there.
    expect(resolveLocateLayers(null, 78.5, 23.5, DEFAULT_LOCATE_LAYERS))
      .toEqual([...DEFAULT_LOCATE_LAYERS]);
  });
});
