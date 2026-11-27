"""The Fifth Schedule village table: each village's two official sources and the basis they give.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_build_scheduled_areas.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_scheduled_areas as b  # noqa: E402

VILLAGES = [
    {'id': 1, 'code': '501', 'dist': 10, 'sub': 100, 'block': 1000, 'gp': 'g1'},
    {'id': 2, 'code': '502', 'dist': 10, 'sub': 100, 'block': 1000, 'gp': 'g2'},
    {'id': 3, 'code': '503', 'dist': 10, 'sub': 101, 'block': 1001, 'gp': 'g3'},
    {'id': 4, 'code': '504', 'dist': 11, 'sub': 110, 'block': 1100, 'gp': 'g4'},
]


def test_a_notified_area_unit_covers_every_village_inside_it():
    units = [{'lgd_layer': 'lgd_subdistricts', 'lgd_ids': '100', 'order_ref': 'CO-1 item 2', 'match': 'exact'}]
    got = b.order_villages(units, VILLAGES)
    assert sorted(got) == [1, 2] and got[1] == ['CO-1 item 2']


def test_named_villages_and_area_units_add_up_and_keep_every_reference():
    units = [{'lgd_layer': 'lgd_districts', 'lgd_ids': '11', 'order_ref': 'CO-1 item 1', 'match': 'exact'},
             {'lgd_layer': 'lgd_villages', 'lgd_ids': '3', 'order_ref': 'GO-6 Ann I', 'match': 'code'},
             {'lgd_layer': 'lgd_villages', 'lgd_ids': '4', 'order_ref': 'GO-6 Ann II', 'match': 'fuzzy'}]
    got = b.order_villages(units, VILLAGES)
    assert sorted(got) == [3, 4] and got[4] == ['CO-1 item 1', 'GO-6 Ann II']


def test_a_unit_that_is_not_a_confident_match_covers_nothing():
    units = [{'lgd_layer': 'lgd_villages', 'lgd_ids': '1', 'order_ref': 'x', 'match': 'review'},
             {'lgd_layer': 'lgd_villages', 'lgd_ids': '1;2', 'order_ref': 'y', 'match': 'ambiguous'}]
    assert b.order_villages(units, VILLAGES) == {}


def test_pesa_villages_join_by_lgd_or_census_code():
    pesa = [{'village_code': '503', 'gp_name': 'G3', 'is_pesa': 'Yes'},
            {'village_code': '999', 'gp_name': 'G9', 'is_pesa': 'Yes'},
            {'village_code': '501', 'gp_name': 'G1', 'is_pesa': 'No'}]
    got, unmatched = b.pesa_villages(pesa, VILLAGES)
    assert list(got) == [3] and [u['village_code'] for u in unmatched] == ['999']


def test_basis_says_which_lists_name_the_village():
    assert b.basis(True, True) == 'both'
    assert b.basis(True, False) == 'order_only'
    assert b.basis(False, True) == 'pesa_only'


NAMED = [
    {'id': 21, 'state': 'MADHYA PRADESH', 'district': 'Betul', 'block_name': 'CHICHOLI', 'gp_name': 'PALASPANI',
     'name': 'Palaspani'},
    {'id': 22, 'state': 'MADHYA PRADESH', 'district': 'Betul', 'block_name': 'CHICHOLI', 'gp_name': 'KUMHI',
     'name': 'Palaspani'},
    {'id': 23, 'state': 'MADHYA PRADESH', 'district': 'Seoni', 'block_name': 'KURAI', 'gp_name': 'X', 'name': 'Khawasa'},
]


def test_a_pesa_village_without_a_known_code_is_matched_by_name_inside_its_panchayat():
    rows = [{'state': 'Madhya Pradesh', 'district': 'Betul', 'block': 'Chicholi', 'gp_name': 'Palaspani',
             'village_name': 'Palaspani', 'village_code': '9001'}]
    got = b.pesa_by_name(rows, NAMED)
    assert got == {21: rows[0]}


def test_a_name_seen_in_two_panchayats_is_not_guessed_without_the_panchayat():
    rows = [{'state': 'Madhya Pradesh', 'district': 'Betul', 'block': 'Chicholi', 'gp_name': 'Unknown GP',
             'village_name': 'Palaspani', 'village_code': '9002'}]
    assert b.pesa_by_name(rows, NAMED) == {}


def test_an_exclusion_removes_area_coverage_but_not_a_village_named_on_its_own():
    units = [{'lgd_layer': 'lgd_subdistricts', 'lgd_ids': '100', 'order_ref': 'tahsil', 'match': 'exact'},
             {'lgd_layer': 'lgd_villages', 'lgd_ids': '2', 'order_ref': 'GO list', 'match': 'code'}]
    excluded = {1, 2}
    got = b.order_villages(units, VILLAGES, excluded)
    assert got == {2: ['GO list']}


def test_exclusions_expand_to_villages_and_skip_probable_matches():
    ex = [{'lgd_layer': 'lgd_blocks', 'ids': ['1000'], 'confidence': 'matched'},
          {'lgd_layer': 'lgd_villages', 'ids': ['3'], 'confidence': 'probable'},
          {'lgd_layer': 'lgd_panchayats', 'ids': ['g4'], 'confidence': 'matched'}]
    assert b.excluded_villages(ex, VILLAGES) == {1, 2, 4}


def test_each_sixth_schedule_unit_is_given_its_council():
    assert b.council('Assam', 'Kokrajhar', 'district') == 'Bodoland Territorial Council'
    assert b.council('Assam', 'Udalguri', 'village') == 'Bodoland Territorial Council'
    assert b.council('Assam', 'Dima Hasao', 'district') == 'Dima Hasao Autonomous Council'
    assert b.council('Assam', 'West Karbi Anglong', 'district') == 'Karbi Anglong Autonomous Council'
    assert b.council('Meghalaya', 'Ri-Bhoi', 'district') == 'Khasi Hills Autonomous District Council'
    assert b.council('Meghalaya', 'West Jaintia Hills', 'district') == 'Jaintia Hills Autonomous District Council'
    assert b.council('Meghalaya', 'North Garo Hills', 'district') == 'Garo Hills Autonomous District Council'
    assert b.council('Tripura', 'Dhalai', 'village') == 'Tripura Tribal Areas Autonomous District Council'


def test_villages_added_to_bodoland_belong_to_its_council():
    assert b.council('Assam', 'Udalguri (added villages)', 'village') == 'Bodoland Territorial Council'
