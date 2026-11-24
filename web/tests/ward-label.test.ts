// surface_at's summary went from sub-district to constituency and left the ward out, though
// the place section had it (owner, 24 Nov 2026). Every ward layer names its columns
// differently; shared/ward_columns.json says which is which, for the ward pages
// (scripts/build_ward_index.py) and for this summary line. Values below are real rows.
import { describe, it, expect } from 'vitest';
import { wardLine } from '../functions/lib/ward-label';
import { SURFACE_PROFILE } from '../functions/lib/surface';
import type { ProfileEntry } from '../functions/lib/profile';

describe('wardLine', () => {
  it('number and name from the layer\'s own columns, with its corporation where numbers restart', () => {
    expect(wardLine('wards_bengaluru_gba', { Corporation: 'East', ward_id: '49', ward_name: 'Shivanasamudra Ward' }))
      .toBe('Ward 49, Shivanasamudra Ward (East Corporation)');
    expect(wardLine('wards_delhi', { Ward_Name: 'CHANDNI CHOWK', Ward_No: '72' })).toBe('Ward 72, CHANDNI CHOWK');
  });
  it('a layer that packs both into one column', () => {
    expect(wardLine('wards_hyderabad', { ward: '127-RANGAREDDY NAGAR' })).toBe('Ward 127, RANGAREDDY NAGAR');
  });
  it('a number-only source says the number; a corporation string is never taken for a name', () => {
    expect(wardLine('wards_jaipur', { wardcode: '12', ward_lgd_name: 'Jaipur (M Corp.)' })).toBe('Ward 12');
    expect(wardLine('wb_amrut_wards', { Ward_No: 6, Name: 'Purulia' })).toBe('Ward 6');
  });
  it('a zone-only source names the zone as a zone, once', () => {
    expect(wardLine('wards_bhubaneshwar', { wardno: 'W27', municipalzone: 'South-West Zone' })).toBe('Ward W27, South-West Zone');
    expect(wardLine('wards_coimbatore', { '2011WardNumbers': 51, Zone: 'Cental Zone' })).toBe('Ward 51, Cental Zone');
    expect(wardLine('wards_madurai', { sourcewardcode: '3', zone: 'North' })).toBe('Ward 3, North zone');
  });
  it('a number column that already says "Ward" is not said twice', () => {
    expect(wardLine('wards_patna', { wardname: 'Ward 28' })).toBe('Ward 28');
    expect(wardLine('sbm_wards', { wardcode: 'Ward No. 6', wardname: 'WARD NO. 06' })).toBe('Ward 6');
  });
  it('values read as the rest of the summary reads them: spaces collapsed, 49.0 as 49', () => {
    expect(wardLine('wards_pune_2025', { AdminNo: 7, Field: 'Aundh  Baner' })).toBe('Ward office 7, Aundh Baner');
    expect(wardLine('wards_vijayawada', { WARD_NO: 49.0 })).toBe('Ward 49');
  });
  it('a parsed name the ward pages would reject is left out', () => {
    expect(wardLine('wards_hyderabad', { ward: '12-Ward No 12' })).toBe('Ward 12');
  });
  it('the national ward map, and a unit with its own name', () => {
    expect(wardLine('sbm_wards', { wardcode: '8', wardname: 'Jali Dodmane' })).toBe('Ward 8, Jali Dodmane');
    expect(wardLine('wards_pune_2025', { AdminNo: 5, Field: 'Kasba' })).toBe('Ward office 5, Kasba');
  });
  it('a layer kept out of the summary (historical, or a copy of another), or a row with neither: nothing', () => {
    expect(wardLine('wards_bengaluru_bbmp_2022', { KGISWardNo: '116', KGISWardName: 'Doddakanahalli' })).toBeNull();
    expect(wardLine('wards_hyderabad_osm', { Name: 'Ward 91 Khairatabad' })).toBeNull();
    expect(wardLine('wards_delhi', {})).toBeNull();
  });
  it('a layer the file does not list: the shared heuristic columns', () => {
    expect(wardLine('wards_newcity', { ward_no: '3', ward_name: 'Old Town' })).toBe('Ward 3, Old Town');
  });
});

describe('surface_at\'s ward rows', () => {
  it('say the ward in the summary', () => {
    const row = SURFACE_PROFILE.expandable!.row('wards_delhi');
    const entry = { layer_id: 'wards_delhi', match: 'contains', status: 'found', features: [{ Ward_Name: 'CHANDNI CHOWK', Ward_No: '72' }] } as unknown as ProfileEntry;
    expect(row.say?.(entry)).toBe('Ward 72, CHANDNI CHOWK');
    expect(row.say?.({ ...entry, status: 'none_within_radius', features: [] } as unknown as ProfileEntry)).toBeFalsy();
  });
});
