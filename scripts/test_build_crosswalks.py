"""Tests for scripts/build_crosswalks.py (no network).

The Census 2011 <-> LGD crosswalk pairs each LGD unit's code with the Census 2011 code its own LGD layer carries,
and derives the relation (1:1, split, merge) from how the pairs repeat.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_build_crosswalks.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_crosswalks as bc  # noqa: E402


def test_census_2011_codes_are_told_apart_from_codes_given_to_units_made_later():
    district = bc.LEVELS['districts']['status']
    assert district('572') == 'census2011'          # Bengaluru Urban
    assert district('640') == 'census2011'
    assert district('790') == 'post2011'            # Tenkasi (2019): the source numbers new districts past 640
    assert district('') == 'missing' and district(None) == 'missing' and district('000') == 'missing'
    state = bc.LEVELS['states']['status']
    assert state('29') == 'census2011' and state('37') == 'post2011'   # Andhra Pradesh after 2014 carries 37
    sub = bc.LEVELS['subdistricts']['status']
    assert sub('05873') == 'census2011' and sub('05925') == 'post2011' and sub(' ') == 'missing'
    village = bc.LEVELS['villages']['status']
    assert village('645603') == 'census2011' and village('800143') == 'post2011' and village('70920') == 'census2011'
    block = bc.LEVELS['blocks']['status']
    assert block('295720110') == 'census2011'
    assert block('367810248') == 'post2011'         # district part 781 is past 640
    assert block('Urban') == 'missing' and block('295720000') == 'missing'


def pairs(*rows):
    return [{'lgd_code': lgd, 'census2011_code': c, 'name': n} for lgd, c, n in rows]


def test_relations_come_from_how_the_pairs_repeat():
    status = bc.LEVELS['blocks']['status']
    rows = bc.derive(pairs(
        (5761, '295720110', 'BENGALURU NORTH'),     # one 2011 block, two LGD blocks: split
        (7371, '295720110', 'YELAHANKA'),
        (5759, '295720113', 'ANEKAL'),              # 1:1
        (5759, '295720113', 'ANEKAL'),              # a second polygon of the same pair counts as a feature
        (9001, '295720120', 'A'),                   # two 2011 blocks, one LGD block: merge
        (9001, '295720121', 'A'),
        (9100, 'Urban', 'URBAN'),                   # no Census 2011 code
        (0, '295720130', 'NO LGD'),                 # no LGD code
        (9200, '367810248', 'NEW'),                 # a code given after 2011
    ), status)
    by = {(r['lgd_code'], r['census2011_code']): r for r in rows}
    assert by[(5761, '295720110')]['relation'] == 'split'
    assert by[(5761, '295720110')]['lgd_units_for_2011_code'] == 2
    assert by[(7371, '295720110')]['relation'] == 'split'
    assert by[(5759, '295720113')]['relation'] == '1:1'
    assert by[(5759, '295720113')]['features'] == 2
    assert by[(9001, '295720120')]['relation'] == 'merge'
    assert by[(9001, '295720120')]['census2011_codes_for_lgd_unit'] == 2
    assert by[(9100, 'Urban')]['relation'] == 'no 2011 code'
    assert by[(9100, 'Urban')]['census2011_code'] == 'Urban'          # kept as carried, never cleaned
    assert by[(0, '295720130')]['relation'] == 'no LGD code'
    assert by[(9200, '367810248')]['relation'] == 'post-2011 code'
    assert len(rows) == 8
    assert [r['lgd_code'] for r in rows] == sorted(r['lgd_code'] for r in rows)


def test_split_and_merge_together():
    status = bc.LEVELS['districts']['status']
    rows = bc.derive(pairs((1, '101', 'a'), (2, '101', 'b'), (2, '102', 'b')), status)
    rel = {(r['lgd_code'], r['census2011_code']): r['relation'] for r in rows}
    assert rel == {(1, '101'): 'split', (2, '101'): 'split+merge', (2, '102'): 'merge'}


def test_the_name_is_the_most_common_one_and_context_columns_ride_along():
    status = bc.LEVELS['districts']['status']
    rows = bc.derive([
        {'lgd_code': 525, 'census2011_code': '572', 'name': 'Bengaluru Urban', 'state_lgd': 29},
        {'lgd_code': 525, 'census2011_code': '572', 'name': 'Bangalore', 'state_lgd': 29},
        {'lgd_code': 525, 'census2011_code': '572', 'name': 'Bengaluru Urban', 'state_lgd': 29},
    ], status)
    assert rows[0]['name'] == 'Bengaluru Urban' and rows[0]['state_lgd'] == 29


def test_write_level_writes_csv_and_parquet_and_rewrites_nothing_when_unchanged(tmp_path):
    rows = bc.derive(pairs((1, '0101', 'a'), (2, '102', 'b')), bc.LEVELS['districts']['status'])
    assert bc.write_level(tmp_path, 'districts', rows) is True
    csv_bytes = (tmp_path / 'cw_districts.csv').read_bytes()
    pq_bytes = (tmp_path / 'cw_districts.parquet').read_bytes()
    assert csv_bytes.splitlines()[0].startswith(b'lgd_code,name,census2011_code,code_status,relation')
    path = tmp_path / 'cw_districts.parquet'
    got = duckdb.sql(f"SELECT census2011_code, lgd_code FROM '{path}' ORDER BY 2").fetchall()
    assert got == [('0101', 1), ('102', 2)]          # leading zeros survive
    assert bc.write_level(tmp_path, 'districts', rows) is False
    assert (tmp_path / 'cw_districts.csv').read_bytes() == csv_bytes
    assert (tmp_path / 'cw_districts.parquet').read_bytes() == pq_bytes
