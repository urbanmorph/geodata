import { describe, it, expect } from 'vitest';
import { toGeoJSON, toCSV, toKML } from '../src/export/formats';

const FIELDS = ['name', 'cond', 'tags'];
const FEATURES = [
  {
    geometry: { type: 'Point', coordinates: [77.61, 12.98] },
    properties: { name: 'MG Road', cond: 'Good', tags: ['a', 'b'], _status: 'published', _contributor: 'Ravi', _admin_ctx: { state: 'KARNATAKA', district: 'Bengaluru Urban' }, _created_at: '2026-10-24T06:00:00.000Z', _captured_at: '2026-10-24T05:10:00.000Z' },
  },
  {
    geometry: { type: 'LineString', coordinates: [[77.60, 12.97], [77.62, 12.99]] },
    properties: { name: 'Church St, "the edge"', cond: 'Blocked', _status: 'pending', _contributor: null, _admin_ctx: null, _created_at: '2026-10-24T07:00:00.000Z', _captured_at: null },
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
      added_at: '2026-10-24T05:10:00.000Z', // the capture time when the phone sent one
    });
    expect(fc.features[1].properties.added_at).toBe('2026-10-24T07:00:00.000Z'); // else when it was saved
    expect(fc.features[0].properties._status).toBeUndefined();
    expect(fc.features[0].properties._admin_ctx).toBeUndefined();
  });
});

describe('toCSV', () => {
  it('has a header + one row per feature, with representative lng/lat', () => {
    const rows = toCSV(FEATURES, FIELDS).split('\n');
    expect(rows[0]).toBe('lng,lat,geometry_type,name,cond,tags,contributor,source,status,added_at,state,district');
    expect(rows[1]).toBe('77.61,12.98,Point,MG Road,Good,a|b,Ravi,,published,2026-10-24T05:10:00.000Z,KARNATAKA,Bengaluru Urban');
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

describe('photos, notes and areas in downloads', () => {
  const sq = [[77.6, 12.97], [77.601, 12.97], [77.601, 12.971], [77.6, 12.971], [77.6, 12.97]];
  const feats = [
    {
      geometry: { type: 'Point', coordinates: [77.6, 12.97] },
      properties: {
        kind: 'Plastic', pic: ['ph_aaaaaaaaaaaa'], _status: 'published',
        _photos: [{ field: 'pic', id: 'ph_aaaaaaaaaaaa', url: 'https://collect.test/api/collect/v1/photos/ph_aaaaaaaaaaaa' }],
        _ai: { status: 'done', review: 'accepted', description: 'Bags by a wall.', tags: ['plastic', 'wall'], model: 'm1' },
      },
    },
    { geometry: { type: 'Polygon', coordinates: [sq] }, properties: { kind: 'Farm', _ai: { status: 'done', description: 'not checked yet' } } },
  ];

  it('gives photo links, accepted notes in their own columns, and an area in square metres', () => {
    const fc = JSON.parse(toGeoJSON(feats, ['kind', 'pic']));
    expect(fc.features[0].properties).toMatchObject({
      pic: ['https://collect.test/api/collect/v1/photos/ph_aaaaaaaaaaaa'],
      photo_description: 'Bags by a wall.', photo_tags: 'plastic | wall', photo_notes_model: 'm1',
    });
    expect(fc.features[1].properties.photo_description).toBeUndefined(); // not accepted
    expect(fc.features[1].properties.area_sq_m).toBeGreaterThan(12000);
    const csv = toCSV(feats, ['kind', 'pic']).split('\n');
    expect(csv[0]).toContain('photo_description');
    expect(csv[0]).toContain('area_sq_m');
    expect(csv[1]).toContain('https://collect.test/api/collect/v1/photos/ph_aaaaaaaaaaaa');
  });
});
