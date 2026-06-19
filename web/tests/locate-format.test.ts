import { describe, it, expect } from 'vitest';
import { pickFeatureName } from '../src/locate-format';

// The locate result sheet needs a human title out of a generic feature's
// properties (column names vary per layer). pickFeatureName is best-effort:
// prefer a *name* column, then a ward number, then the first usable string.

describe('pickFeatureName', () => {
  it('prefers a name column', () => {
    expect(pickFeatureName({ KGISWardNo: 150, KGISWardName: 'Shanthala Nagar' })).toBe('Shanthala Nagar');
    expect(pickFeatureName({ stname: 'Karnataka', stcode: 29 })).toBe('Karnataka');
  });

  it('falls back to a ward/number column as "Ward N"', () => {
    expect(pickFeatureName({ KGISWardNo: 150 })).toBe('Ward 150');
    expect(pickFeatureName({ ward_no: '42' })).toBe('Ward 42');
  });

  it('falls back to the first usable string value', () => {
    expect(pickFeatureName({ district: 'Bengaluru Urban', area_sqkm: 709 })).toBe('Bengaluru Urban');
  });

  it('ignores geometry/id/shape junk and blanks', () => {
    expect(pickFeatureName({ OBJECTID: 7, geometry: 'x', name: 'Hosur Road' })).toBe('Hosur Road');
    expect(pickFeatureName({ _lat: 12.9, _lng: 77.6, name: '  ' , place: 'Indiranagar' })).toBe('Indiranagar');
  });

  it('returns a sane fallback for an empty / unnamed feature', () => {
    expect(pickFeatureName({})).toBe('Found');
    expect(pickFeatureName({ OBJECTID: 7 })).toBe('Found');
  });
});
