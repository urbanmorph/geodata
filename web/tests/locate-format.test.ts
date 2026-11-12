import { describe, it, expect } from 'vitest';
import { pickFeatureName, wardTitle } from '../src/locate-format';

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

// A located ward is titled by its number, from the city's ward-index sidecar (which column holds the number, and
// for "Ward 91 Khairatabad" values how to read it), with the layer's own name or the OSM areas under it.
describe('wardTitle', () => {
  const JAIPUR = { numberCol: 'wardcode', nameLabel: null,
    rows: [{ no: '102', name: '', areas: ['Malviya Nagar', 'Jawahar Nagar'] }, { no: '5', name: '', areas: [] }] };
  const AHMEDABAD = { numberCol: 'sourcewardcode', nameLabel: 'Area', rows: [{ no: '22', name: 'India colony' }] };
  const HYDERABAD = { numberCol: 'Name', numberFrom: '^ward\\s+(\\d+)', nameLabel: 'Area', rows: [{ no: '91', name: 'Khairatabad' }] };
  const PATNA = { numberCol: 'wardname', nameLabel: null, rows: [{ no: 'Ward 22C', name: '', areas: [] }] };

  it('titles the ward by its number, not the town that also carries a name', () => {
    expect(wardTitle({ townname: 'Greater Jaipur', ward_lgd_name: 'Jaipur (M Corp.) (Part) - Ward No.102', wardcode: 102 }, JAIPUR))
      .toEqual({ title: 'Ward 102', sub: 'Areas (OpenStreetMap): Malviya Nagar, Jawahar Nagar' });
    expect(wardTitle({ wardcode: 5 }, JAIPUR)).toEqual({ title: 'Ward 5', sub: '' });
  });

  it('gives the layer\'s own name, read the Hyderabad way where the number sits in a name', () => {
    expect(wardTitle({ sourcewardcode: 22, sourcewardname: 'India colony' }, AHMEDABAD)).toEqual({ title: 'Ward 22', sub: 'India colony' });
    expect(wardTitle({ Name: 'Ward 91 Khairatabad' }, HYDERABAD)).toEqual({ title: 'Ward 91', sub: 'Khairatabad' });
    expect(wardTitle({ wardname: 'Ward 22C' }, PATNA)).toEqual({ title: 'Ward 22C', sub: '' });
  });

  it('without a sidecar, or a number it cannot place, it gives way to the generic picker', () => {
    expect(wardTitle({ wardcode: 102 }, null)).toBeNull();
    expect(wardTitle({ other: 1 }, JAIPUR)).toBeNull();
  });
});

describe('pickFeatureName skips a town, city or corporation name and corporation strings', () => {
  it('takes the ward number over "Greater Jaipur" and "Jaipur (M Corp.) (Part) - Ward No.102"', () => {
    expect(pickFeatureName({ townname: 'Greater Jaipur', ward_lgd_name: 'Jaipur (M Corp.) (Part) - Ward No.102', wardcode: 102 })).toBe('Ward 102');
    expect(pickFeatureName({ ulbname: 'Patna', wardname: 'Ward 7' })).toBe('Ward 7');
  });
});
