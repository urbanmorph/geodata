"""Rows of the two Scheduled Areas layers: what each feature is, and what it says about its sources.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_scheduled_areas.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_scheduled_areas as s  # noqa: E402


def test_a_village_row_carries_both_sources_and_its_basis():
    v = {'lgd_village': '501', 'census_2011': '501', 'state': 'GUJARAT', 'district': 'Bharuch',
         'subdistrict': 'Jhagadia', 'village': 'Achhalia', 'basis': 'both', 'order_refs': 'GJ-CO109-1977',
         'pesa_gp': 'Achhalia', 'pesa_block': 'Jhagadia', 'pesa_join': 'code'}
    r = s.village_row(v)
    assert r['feature'] == 'village' and r['lgd_layer'] == 'lgd_villages' and r['lgd_code'] == '501'
    assert (r['in_orders'], r['in_pesa_list'], r['basis']) == (True, True, 'both')
    assert r['mapped'] is True


def test_a_listed_unit_with_no_boundary_is_kept_without_geometry_and_says_why():
    u = {'state': 'Madhya Pradesh', 'unit_level': 'other', 'unit_name': 'Patwari circle No. 12',
         'parent_district': 'Chhindwara', 'parent_subdistrict_or_block': 'Pandurna', 'order_ref': 'C.O.192 item 17',
         'match': 'needs_list', 'candidates': ''}
    r = s.unmapped_order_row(u)
    assert r['mapped'] is False and r['lgd_layer'] == '' and r['in_orders'] is True and r['in_pesa_list'] is False
    assert 'no boundary' in r['why_unmapped']


def test_a_pesa_village_with_no_polygon_is_kept_with_its_panchayat():
    p = {'state': 'Madhya Pradesh', 'district': 'Barwani', 'block': 'Pati', 'gp_code': '1', 'gp_name': 'Khadkivan',
         'village_code': '478517', 'village_name': 'Khadakivan', 'is_pesa': 'Yes'}
    r = s.unmapped_pesa_row(p)
    assert (r['mapped'], r['in_pesa_list'], r['in_orders'], r['basis']) == (False, True, False, 'pesa_only')
    assert r['lgd_code'] == '478517' and r['pesa_gp'] == 'Khadkivan'


def test_why_unmapped_names_the_reason():
    assert 'not matched' in s.why_unmapped('review')
    assert 'two or more' in s.why_unmapped('ambiguous')
    assert 'no boundary' in s.why_unmapped('needs_list')


def test_the_catalog_entry_is_cc0_curated_and_its_notes_name_the_sources_without_em_dashes():
    summ = {'rows': 10, 'mapped': 7, 'sizes': {f: 1 for f in s.EXT}, 'names': {f: f'x.{f}' for f in s.EXT}}
    for layer in ('scheduled_areas_fifth', 'scheduled_areas_sixth'):
        e = s.catalog_entry(layer, summ, '2026-11-27T00:00:00+00:00', 'https://data.bharatlas.com')
        assert (e['licence'], e['provenance'], e['category']) == ('CC0-1.0', 'curated', 'boundaries')
        assert '—' not in e['notes'] and '3 listed' in e['notes']
        assert set(s.EXT) <= set(e)
    assert 'eGramSwaraj' in s.notes('scheduled_areas_fifth', summ)
    assert 'Paragraph 20' in s.notes('scheduled_areas_sixth', summ)


def test_the_pesa_layer_names_its_requester_and_the_sixth_schedule_names_none():
    summ = {'rows': 1, 'mapped': 1, 'sizes': {f: 1 for f in s.EXT}, 'names': {f: f'x.{f}' for f in s.EXT}}
    fifth = s.catalog_entry('scheduled_areas_fifth', summ, '2026-11-28T00:00:00+00:00', 'https://r2')
    sixth = s.catalog_entry('scheduled_areas_sixth', summ, '2026-11-28T00:00:00+00:00', 'https://r2')
    assert fifth['requested_by'] == {'name': 'Sandilya MV'} and 'requested_by' not in sixth
