import { describe, it, expect } from 'vitest';
import { compassBearing, compass8, bearingLabel, pickContains } from '../functions/lib/locate-layer';
import type { LocateResponse } from '../functions/lib/locate';

// Pure helpers behind GET /api/v1/layers/{id}/locate. The endpoint composes
// the existing `locate` (contains, point-in-polygon over PMTiles) and `nearby`
// (nearest, parquet) engines; these helpers do the geometry-free bits:
// the compass bearing shown on a "nearest" result, and pulling a single layer's
// containing feature out of the aggregate locate response.

describe('compass8 — degrees to an 8-point compass label', () => {
  it('maps the cardinals', () => {
    expect(compass8(0)).toBe('N');
    expect(compass8(90)).toBe('E');
    expect(compass8(180)).toBe('S');
    expect(compass8(270)).toBe('W');
  });
  it('maps the intercardinals', () => {
    expect(compass8(45)).toBe('NE');
    expect(compass8(135)).toBe('SE');
    expect(compass8(225)).toBe('SW');
    expect(compass8(315)).toBe('NW');
  });
  it('wraps 360 back to N and normalises out-of-range / negative input', () => {
    expect(compass8(360)).toBe('N');
    expect(compass8(-90)).toBe('W');
    expect(compass8(720 + 90)).toBe('E');
  });
});

describe('compassBearing + bearingLabel — direction from point A to point B', () => {
  it('due north: same lng, higher lat', () => {
    expect(Math.round(compassBearing(12.9, 77.6, 13.0, 77.6))).toBe(0);
    expect(bearingLabel(12.9, 77.6, 13.0, 77.6)).toBe('N');
  });
  it('due east: same lat, higher lng', () => {
    expect(Math.round(compassBearing(12.9, 77.6, 12.9, 77.7))).toBe(90);
    expect(bearingLabel(12.9, 77.6, 12.9, 77.7)).toBe('E');
  });
  it('due south and due west', () => {
    expect(bearingLabel(13.0, 77.6, 12.9, 77.6)).toBe('S');
    expect(bearingLabel(12.9, 77.7, 12.9, 77.6)).toBe('W');
  });
  it('north-east when both lat and lng increase', () => {
    expect(bearingLabel(12.9, 77.6, 13.0, 77.7)).toBe('NE');
  });
});

describe('pickContains — single layer feature out of the aggregate locate', () => {
  const resp = (results: LocateResponse['results']): LocateResponse =>
    ({ point: { lat: 0, lng: 0 }, zoom: 14, results, queried_layers: [], timing_ms: 0 });

  it('returns the matching layer feature regardless of category grouping', () => {
    const r = resp({
      admin: [{ layer_id: 'lgd_districts', level: 'district', category: 'admin', feature: { properties: { d: 1 } } }],
      civic: [{ layer_id: 'wards_x', level: 'wards_x', category: 'civic', feature: { properties: { ward: '150' } } }],
    });
    expect(pickContains(r, 'wards_x')).toEqual({ properties: { ward: '150' } });
  });
  it('returns null when the layer is absent', () => {
    expect(pickContains(resp({}), 'wards_x')).toBeNull();
  });
});
