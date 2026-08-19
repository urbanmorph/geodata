import { describe, it, expect } from 'vitest';
import { distillAdminCtx, mergeAdminCtx, representativeCoord } from '../src/geo/admin-ctx';

// A trimmed copy of the real /api/v1/locate `results` shape (Bengaluru point).
const RESULTS = {
  boundaries: [
    { level: 'state', feature: { properties: { STNAME: 'KARNATAKA' } } },
    { level: 'district', feature: { properties: { dtname: 'Bengaluru Urban' } } },
    { level: 'subdistrict', feature: { properties: { sdtname: 'Bengaluru East' } } },
    { level: 'block', feature: { properties: { block_name: 'BENGALURU EAST' } } },
  ],
  people: [
    { level: 'parliament_constituency', feature: { properties: { pc_name: 'BANGALORE NORTH' } } },
    { level: 'assembly_constituency', feature: { properties: { ac_name: 'K.R.Pura' } } },
    { level: 'high_court', feature: { properties: { name: 'Karnataka High Court' } } },
  ],
  environment: [
    { level: 'seismic_zone', feature: { properties: { seismic_zo: 'Seismic Zone-II' } } },
  ],
};

describe('distillAdminCtx', () => {
  it('flattens locate results to a small named admin context', () => {
    expect(distillAdminCtx(RESULTS)).toEqual({
      state: 'KARNATAKA',
      district: 'Bengaluru Urban',
      subdistrict: 'Bengaluru East',
      block: 'BENGALURU EAST',
      parliament_constituency: 'BANGALORE NORTH',
      assembly_constituency: 'K.R.Pura',
      high_court: 'Karnataka High Court',
      seismic_zone: 'Seismic Zone-II',
    });
  });

  it('keeps only the levels actually present', () => {
    expect(distillAdminCtx({ boundaries: [RESULTS.boundaries[0]] })).toEqual({ state: 'KARNATAKA' });
  });

  it('returns null when nothing resolves', () => {
    expect(distillAdminCtx({})).toBeNull();
    expect(distillAdminCtx({ boundaries: [] })).toBeNull();
    expect(distillAdminCtx(null)).toBeNull();
    expect(distillAdminCtx({ boundaries: [{ level: 'state', feature: { properties: {} } }] })).toBeNull();
  });

  it('ignores unknown levels', () => {
    expect(distillAdminCtx({ misc: [{ level: 'zzz', feature: { properties: { name: 'x' } } }] })).toBeNull();
  });
});

describe('mergeAdminCtx', () => {
  it('flattens admin levels into properties', () => {
    expect(mergeAdminCtx({ name: 'x' }, JSON.stringify({ state: 'KA', district: 'BU' }))).toEqual({
      name: 'x', state: 'KA', district: 'BU',
    });
  });
  it('author fields win on key collision', () => {
    expect(mergeAdminCtx({ state: 'my state' }, JSON.stringify({ state: 'KA' }))).toEqual({ state: 'my state' });
  });
  it('passes properties through when there is no enrichment or bad JSON', () => {
    expect(mergeAdminCtx({ name: 'x' }, null)).toEqual({ name: 'x' });
    expect(mergeAdminCtx({ name: 'x' }, 'not json')).toEqual({ name: 'x' });
  });
});

describe('representativeCoord', () => {
  it('returns a point coordinate', () => {
    expect(representativeCoord({ type: 'Point', coordinates: [77.71, 12.98] })).toEqual([77.71, 12.98]);
  });
  it('returns the first vertex of a line', () => {
    expect(representativeCoord({ type: 'LineString', coordinates: [[77.7, 12.9], [77.8, 13.0]] })).toEqual([77.7, 12.9]);
  });
  it('returns the first vertex of a polygon', () => {
    expect(representativeCoord({ type: 'Polygon', coordinates: [[[77.7, 12.9], [77.8, 12.9], [77.8, 13.0], [77.7, 12.9]]] })).toEqual([77.7, 12.9]);
  });
  it('digs into MultiPolygon', () => {
    expect(representativeCoord({ type: 'MultiPolygon', coordinates: [[[[78.1, 20.2], [78.2, 20.2]]]] })).toEqual([78.1, 20.2]);
  });
  it('returns null for malformed geometry', () => {
    expect(representativeCoord(null)).toBeNull();
    expect(representativeCoord({ type: 'Point', coordinates: [] })).toBeNull();
    expect(representativeCoord({})).toBeNull();
  });
});
