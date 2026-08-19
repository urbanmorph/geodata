import { describe, it, expect } from 'vitest';
import { toGeoJSON, toCSV, toKML } from '../src/export/formats';

const FIELDS = ['name', 'cond', 'tags'];
const FEATURES = [
  {
    geometry: { type: 'Point', coordinates: [77.61, 12.98] },
    properties: { name: 'MG Road', cond: 'Good', tags: ['a', 'b'], _status: 'published', _contributor: 'Ravi', _admin_ctx: { state: 'KARNATAKA', district: 'Bengaluru Urban' } },
  },
  {
    geometry: { type: 'LineString', coordinates: [[77.60, 12.97], [77.62, 12.99]] },
    properties: { name: 'Church St, "the edge"', cond: 'Blocked', _status: 'pending', _contributor: null, _admin_ctx: null },
  },
];

describe('toGeoJSON', () => {
  it('emits a FeatureCollection with tidy properties (no _internal keys)', () => {
    const fc = JSON.parse(toGeoJSON(FEATURES, FIELDS));
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [77.61, 12.98] });
    expect(fc.features[0].properties).toMatchObject({
      name: 'MG Road', cond: 'Good', tags: ['a', 'b'], contributor: 'Ravi', status: 'published', state: 'KARNATAKA', district: 'Bengaluru Urban',
    });
    expect(fc.features[0].properties._status).toBeUndefined();
    expect(fc.features[0].properties._admin_ctx).toBeUndefined();
  });
});

describe('toCSV', () => {
  it('has a header + one row per feature, with representative lng/lat', () => {
    const rows = toCSV(FEATURES, FIELDS).split('\n');
    expect(rows[0]).toBe('lng,lat,geometry_type,name,cond,tags,contributor,source,status,state,district');
    expect(rows[1]).toBe('77.61,12.98,Point,MG Road,Good,a|b,Ravi,,published,KARNATAKA,Bengaluru Urban');
    expect(rows).toHaveLength(3);
  });
  it('quotes cells with commas/quotes and uses the line first vertex', () => {
    const row = toCSV([FEATURES[1]], FIELDS).split('\n')[1];
    expect(row.startsWith('77.6,12.97,LineString,')).toBe(true);
    expect(row).toContain('"Church St, ""the edge"""');
  });
});

describe('toKML', () => {
  it('wraps features as placemarks with matching geometry + escaped names', () => {
    const kml = toKML(FEATURES, FIELDS, 'Footpath survey');
    expect(kml).toContain('<name>Footpath survey</name>');
    expect(kml).toContain('<Point><coordinates>77.61,12.98</coordinates></Point>');
    expect(kml).toContain('<LineString><coordinates>77.6,12.97 77.62,12.99</coordinates></LineString>');
    expect(kml).toContain('Church St, &quot;the edge&quot;');
    expect(kml).toContain('<Data name="cond"><value>Good</value></Data>');
  });
});
