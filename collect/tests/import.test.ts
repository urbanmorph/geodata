import { describe, it, expect } from 'vitest';
import { parseGeoJSON, parseCSV, parseCSVRows } from '../src/import/parse';
import { autoMapping, buildRecords, errorsToCSV } from '../src/import/build';
import type { Field } from '../src/schema/validate-record';

const FIELDS: Field[] = [
  { key: 'name', label: 'Name of the place', type: 'text', required: true },
  { key: 'cond', label: 'Condition', type: 'select', options: ['Good', 'Bad'] },
];

describe('parseCSVRows', () => {
  it('handles quotes, embedded commas + newlines', () => {
    expect(parseCSVRows('a,b\n1,"x,y"\n2,"li\nne"')).toEqual([['a', 'b'], ['1', 'x,y'], ['2', 'li\nne']]);
  });
});

describe('parseGeoJSON / parseCSV', () => {
  it('reads a FeatureCollection', () => {
    const p = parseGeoJSON(JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [77.6, 12.9] }, properties: { name: 'A', cond: 'Good' } },
    ] }));
    expect(p.columns.sort()).toEqual(['cond', 'name']);
    expect(p.features[0].geometry).toEqual({ type: 'Point', coordinates: [77.6, 12.9] });
    expect(p.features[0].props).toEqual({ name: 'A', cond: 'Good' });
  });
  it('reads CSV headers + rows, geometry null', () => {
    const p = parseCSV('name,cond,lng,lat\nA,Good,77.6,12.9\n');
    expect(p.columns).toEqual(['name', 'cond', 'lng', 'lat']);
    expect(p.features).toHaveLength(1);
    expect(p.features[0].geometry).toBeNull();
  });
});

describe('autoMapping', () => {
  it('matches fields by key/label and finds lng/lat', () => {
    const m = autoMapping(FIELDS, ['Name of the place', 'cond', 'longitude', 'latitude']);
    expect(m.fields).toEqual({ name: 'Name of the place', cond: 'cond' });
    expect(m.lng).toBe('longitude');
    expect(m.lat).toBe('latitude');
  });
});

describe('buildRecords', () => {
  const geom = ['point'];
  it('builds a Point from lng/lat columns and validates fields', () => {
    const p = parseCSV('name,cond,lng,lat\nA,Good,77.6,12.9\nB,Nope,77.7,12.8\n');
    const r = buildRecords(p.features, autoMapping(FIELDS, p.columns), FIELDS, geom);
    expect(r.records).toHaveLength(1);
    expect(r.records[0].geometry).toEqual({ type: 'Point', coordinates: [77.6, 12.9] });
    expect(r.errors).toHaveLength(1); // "Nope" is not a valid Condition option
    expect(r.errors[0].error).toMatch(/cond/i);
  });
  it('flags out-of-India + missing geometry', () => {
    const p = parseCSV('name,lng,lat\nX,10,10\nY,,\n');
    const r = buildRecords(p.features, autoMapping(FIELDS, p.columns), FIELDS, geom);
    expect(r.records).toHaveLength(0);
    expect(r.errors.map((e) => e.error).join(' ')).toMatch(/India|no geometry/);
  });
  it('rejects a geometry type the collection does not allow', () => {
    const p = parseGeoJSON(JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[77.6, 12.9], [77.7, 12.8]] }, properties: { name: 'L' } },
    ] }));
    const r = buildRecords(p.features, autoMapping(FIELDS, p.columns), FIELDS, ['point']);
    expect(r.records).toHaveLength(0);
    expect(r.errors[0].error).toMatch(/not allowed/);
  });
});

describe('errorsToCSV', () => {
  it('produces a re-uploadable file with an _error column', () => {
    const csv = errorsToCSV([{ row: 0, error: 'bad', source: { name: 'A', lng: '10' } }]);
    expect(csv.split('\n')[0]).toBe('name,lng,why');
    expect(csv.split('\n')[1]).toBe('A,10,bad');
  });
});

describe('buildRecords with dates', () => {
  it('a Date field keeps the date part of a date-time cell instead of refusing the row', async () => {
    const { buildRecords } = await import('../src/import/build');
    const { parseCSV } = await import('../src/import/parse');
    const p = parseCSV('day,lng,lat\n2026-05-04 09:30,77.6,12.9\n');
    const r = buildRecords(p.features, { fields: { day: 'day' }, lng: 'lng', lat: 'lat' }, [{ key: 'day', label: 'Day', type: 'date' }], ['point']);
    expect(r.errors).toEqual([]);
    expect(r.records[0].properties).toEqual({ day: '2026-05-04' });
  });
});

import { buildRecords as build } from '../src/import/build';
import { parseCSV as csv, parseGeoJSON as gj } from '../src/import/parse';

describe('client_id on imported rows (a re-import adds nothing)', () => {
  const fields = [{ key: 'name', label: 'Name', type: 'text' as const }];
  const map = { fields: { name: 'name' }, lng: 'lng', lat: 'lat' };
  it('uses an id column when the file has one', () => {
    const out = build(csv('ID,name,lng,lat\nT-1,Neem,77.5,12.9\nT-2,Peepal,77.6,12.9').features, map, fields, ['point']);
    expect(out.records.map((r) => r.client_id)).toEqual(['T-1', 'T-2']);
  });
  it("uses a GeoJSON feature's own id", () => {
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 7, geometry: { type: 'Point', coordinates: [77.5, 12.9] }, properties: { name: 'a' } }] };
    expect(build(gj(JSON.stringify(fc)).features, { fields: { name: 'name' } }, fields, ['point']).records[0].client_id).toBe('7');
  });
  it('otherwise fingerprints the row: stable across runs, numbered when a row repeats', () => {
    const text = 'name,lng,lat\nNeem,77.5,12.9\nNeem,77.5,12.9\nPeepal,77.6,12.9';
    const a = build(csv(text).features, map, fields, ['point']).records.map((r) => r.client_id);
    const b = build(csv(text).features, map, fields, ['point']).records.map((r) => r.client_id);
    expect(a).toEqual(b);
    expect(a[0]).toMatch(/^row-[0-9a-f]{16}$/);
    expect(a[1]).toBe(`${a[0]}~2`);
    expect(new Set(a).size).toBe(3);
  });
});
