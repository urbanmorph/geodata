import { describe, it, expect } from 'vitest';
import { guessType, inferSchema } from '../src/import/infer';
import { parseCSV, parseGeoJSON } from '../src/import/parse';

describe('guessType', () => {
  it('detects number, date, select, paragraph, text', () => {
    expect(guessType(['1', '2', '3']).type).toBe('number');
    expect(guessType(['2021-01-01', '2022-05-09']).type).toBe('date');
    const sel = guessType(['Good', 'Bad', 'Good', 'Bad', 'Good', 'Bad']);
    expect(sel.type).toBe('select');
    expect(sel.options).toEqual(['Good', 'Bad']);
    expect(guessType(['x'.repeat(120)]).type).toBe('paragraph');
    expect(guessType(['Kaveri footpath', 'MG Road', 'Church St']).type).toBe('text');
  });
  it('falls back to text on empty', () => {
    expect(guessType(['', '  ']).type).toBe('text');
  });
});

describe('inferSchema', () => {
  it('CSV: point geometry, coordinate columns dropped, first col required', () => {
    const p = parseCSV('name,condition,height_m,lng,lat\nA,Good,3,77.6,12.9\nB,Bad,5,77.7,12.8\nC,Good,4,77.8,12.7\nD,Bad,6,77.9,12.6\n');
    const inf = inferSchema(p, 'csv');
    expect(inf.geometry).toEqual(['point']);
    expect(inf.fields.map((f) => f.key)).toEqual(['name', 'condition', 'height_m']); // lng/lat excluded
    expect(inf.fields[0].required).toBe(true);
    expect(inf.fields.find((f) => f.key === 'condition')?.type).toBe('select');
    expect(inf.fields.find((f) => f.key === 'height_m')?.type).toBe('number');
    expect(inf.mapping).toMatchObject({ name: 'name', condition: 'condition', height_m: 'height_m' });
  });
  it('GeoJSON: geometry taken from features', () => {
    const p = parseGeoJSON(JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[77, 12], [78, 12], [78, 13], [77, 12]]] }, properties: { name: 'Ward 1' } },
    ] }));
    expect(inferSchema(p, 'geojson').geometry).toEqual(['polygon']);
  });
  it('reads every row, not just the first 50, so later values are not refused', () => {
    // Pedaluru survey (Oct 2026): rows were grouped, Group 4 started at row 51,
    // and a choice list guessed from the first 50 rows refused all 38 of them.
    const rows = Array.from({ length: 88 }, (_, i) => `P${i},Group ${1 + Math.floor(i / 25)},77.6,12.9`);
    const inf = inferSchema(parseCSV(`name,group,lng,lat\n${rows.join('\n')}\n`), 'csv');
    const group = inf.fields.find((f) => f.key === 'group');
    expect(group?.type).toBe('select');
    expect(group?.options).toEqual(['Group 1', 'Group 2', 'Group 3', 'Group 4']);
  });

  it('a link column becomes a Link field, not a choice list', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `P${i},https://drive.google.com/drive/folders/${i % 2 ? 'a' : 'b'},77.6,12.9`);
    const inf = inferSchema(parseCSV(`name,photo,lng,lat\n${rows.join('\n')}\n`), 'csv');
    expect(inf.fields.find((f) => f.key === 'photo')?.type).toBe('url');
  });
});
