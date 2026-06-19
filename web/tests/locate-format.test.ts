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

  it('prefers the feature own name over a parent admin name', () => {
    // assembly constituency: st_name + dist_name come before the real ac_name
    expect(pickFeatureName({
      OBJECTID: 1, st_name: 'KARNATAKA', dist_name: 'BANGALORE',
      ac_no: 162, ac_name: 'Shivajinagar', pc_name: 'BANGALORE CENTRAL',
    })).toBe('Shivajinagar');
    // parliament: st_name before pc_name
    expect(pickFeatureName({ st_name: 'KARNATAKA', pc_no: 25, pc_name: 'BANGALORE CENTRAL' })).toBe('BANGALORE CENTRAL');
    // village: parent admin names before vil_name
    expect(pickFeatureName({ stname: 'KARNATAKA', dtname: 'BANGALORE', sdtname: 'Bangalore South', vil_name: 'Begur' })).toBe('Begur');
  });

  it('falls back to a parent-style name only when it IS the feature (district/state layers)', () => {
    expect(pickFeatureName({ OBJECTID: 55, dtname: 'Bengaluru Urban', stname: 'KARNATAKA' })).toBe('Bengaluru Urban');
    expect(pickFeatureName({ st_name: 'Karnataka', st_code: 29 })).toBe('Karnataka');
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
