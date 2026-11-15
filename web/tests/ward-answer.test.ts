import { describe, it, expect } from 'vitest';
import { parseWardQuery, wardAnswer, wardAnswerHtml, wardCities } from '../src/ward-answer';
import { WARD_PLACES } from '../functions/lib/ward-places';

// Ward layers with a ward-index sidecar, in catalogue order (current map first).
const places = {
  wards_ahmedabad: 'Ahmedabad',
  wards_bengaluru_gba: 'Bengaluru',
  wards_bengaluru_bbmp_2022: 'Bengaluru',
  wards_mumbai: 'Mumbai',
  wards_navi_mumbai: 'Navi Mumbai',
  wards_gurugram: 'Gurugram',
};

describe('parseWardQuery', () => {
  it('reads "ward 9 ahmedabad" and "ahmedabad ward no. 9"', () => {
    const want = { layerId: 'wards_ahmedabad', place: 'Ahmedabad', number: '9' };
    expect(parseWardQuery('ward 9 ahmedabad', places)).toEqual(want);
    expect(parseWardQuery('Ahmedabad ward no. 9', places)).toEqual(want);
    expect(parseWardQuery('ahmedabad ward number 9', places)).toEqual(want);
  });

  it('prefers the current map when a city has more than one', () => {
    expect(parseWardQuery('ward 25 bengaluru', places)?.layerId).toBe('wards_bengaluru_gba');
  });

  it('matches the longest city name (Navi Mumbai, not Mumbai)', () => {
    expect(parseWardQuery('navi mumbai ward 12', places)?.layerId).toBe('wards_navi_mumbai');
    expect(parseWardQuery('mumbai ward 12', places)?.layerId).toBe('wards_mumbai');
  });

  it('knows older city names', () => {
    expect(parseWardQuery('bangalore ward 25', places)?.layerId).toBe('wards_bengaluru_gba');
    expect(parseWardQuery('gurgaon ward 3', places)?.layerId).toBe('wards_gurugram');
    expect(parseWardQuery('bombay ward 1', places)?.layerId).toBe('wards_mumbai');
  });

  it('needs the word ward, a number and a known city', () => {
    expect(parseWardQuery('ahmedabad wards', places)).toBeNull();
    expect(parseWardQuery('ward 9', places)).toBeNull();
    expect(parseWardQuery('9 ahmedabad', places)).toBeNull();
    expect(parseWardQuery('ward 9 shimla', places)).toBeNull();
  });
});

describe('wardAnswer', () => {
  const index = { place: 'Ahmedabad', nameLabel: 'Area', rows: [{ no: '1', name: 'Gota' }, { no: '9', name: 'Naranpura' }, { no: '10', name: 'S. P. Stadium' }] };

  it('finds the ward name and the city total', () => {
    expect(wardAnswer(index, '9')).toEqual({ number: '9', name: 'Naranpura', total: 3 });
  });

  it('matches "09" to ward 9 and returns null for an unknown number', () => {
    expect(wardAnswer(index, '09')?.name).toBe('Naranpura');
    expect(wardAnswer(index, '99')).toBeNull();
  });

  it('does not guess when the number repeats across corporations (Greater Bengaluru)', () => {
    const gba = { place: 'Bengaluru', rows: [{ no: '25', name: 'A', group: 'Central' }, { no: '25', name: 'B', group: 'East' }] };
    expect(wardAnswer(gba, '25')).toBeNull();
  });
});

describe('wardCities', () => {
  it('maps every ward layer to its plain city name, current map first', () => {
    const c = wardCities();
    expect(Object.keys(c)).toEqual(Object.keys(WARD_PLACES));
    expect(c.wards_vizag).toBe('Visakhapatnam');
    expect(parseWardQuery('vizag ward 4', c)?.layerId).toBe('wards_vizag');
    expect(parseWardQuery('ward 3 bhubaneshwar', c)?.layerId).toBe('wards_bhubaneshwar');
    expect(parseWardQuery('ward 12 pune', c)?.layerId).toBe('wards_pune');
  });
});

describe('wardAnswerHtml', () => {
  it('leads with the answer and links the ward map', () => {
    const html = wardAnswerHtml({ layerId: 'wards_ahmedabad', place: 'Ahmedabad', number: '9' }, { number: '9', name: 'Naranpura', total: 48 });
    expect(html).toContain('Ward 9, Ahmedabad is <strong>Naranpura</strong>');
    expect(html).toContain('href="/view/wards_ahmedabad"');
    expect(html).toContain('1 of 48 wards');
  });

  it('escapes names from the data', () => {
    const html = wardAnswerHtml({ layerId: 'wards_x', place: 'X', number: '1' }, { number: '1', name: '<img src=x>', total: 1 });
    expect(html).not.toContain('<img');
  });
});
