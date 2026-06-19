import { describe, it, expect } from 'vitest';
import { buildFeatureFilter, shareUrl, parseAtParam } from '../src/locate-actions';

describe('buildFeatureFilter', () => {
  it('matches a feature on all its scalar properties', () => {
    expect(buildFeatureFilter({ KGISWardNo: 150, KGISWardName: 'Shanthala Nagar' })).toEqual([
      'all',
      ['==', ['get', 'KGISWardNo'], 150],
      ['==', ['get', 'KGISWardName'], 'Shanthala Nagar'],
    ]);
  });

  it('skips non-scalar / object values', () => {
    const f = buildFeatureFilter({ name: 'X', bbox: [1, 2, 3, 4], meta: { a: 1 }, n: 7 }) as unknown[];
    expect(f).toEqual(['all', ['==', ['get', 'name'], 'X'], ['==', ['get', 'n'], 7]]);
  });

  it('returns null when there is nothing to match on (never match-all)', () => {
    expect(buildFeatureFilter({})).toBeNull();
    expect(buildFeatureFilter({ geom: [1, 2], meta: {} })).toBeNull();
  });
});

describe('shareUrl', () => {
  it('builds a /view/<id>?at= link at ~1m precision', () => {
    expect(shareUrl('https://bharatlas.com', 'wards_bengaluru_bbmp_2022', 12.97161, 77.59456))
      .toBe('https://bharatlas.com/view/wards_bengaluru_bbmp_2022?at=12.97161,77.59456');
  });
  it('encodes the layer id', () => {
    expect(shareUrl('https://bharatlas.com', 'c_a/b', 12.5, 77.5)).toContain('/view/c_a%2Fb?at=');
  });
});

describe('parseAtParam', () => {
  it('parses a valid in-India coord', () => {
    expect(parseAtParam('12.9716,77.5946')).toEqual({ lat: 12.9716, lng: 77.5946 });
  });
  it('rejects malformed / out-of-India / missing', () => {
    expect(parseAtParam(null)).toBeNull();
    expect(parseAtParam('12.9716')).toBeNull();
    expect(parseAtParam('abc,def')).toBeNull();
    expect(parseAtParam('51.5,-0.12')).toBeNull(); // London, outside India bbox
    expect(parseAtParam('12.9716,77.5946,5')).toBeNull();
  });
});
