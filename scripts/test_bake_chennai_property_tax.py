"""Tests for scripts/bake_chennai_property_tax.py.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_chennai_property_tax.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_chennai_property_tax as b  # noqa: E402


@pytest.mark.parametrize('raw,num', [('N001', 1), ('N200', 200), (' N045 ', 45)])
def test_source_ward_number_is_the_number_after_n(raw, num):
    assert b.source_ward_no(raw) == num


@pytest.mark.parametrize('raw', ['', None, 'Total', 'N', 'X12'])
def test_rows_that_are_not_a_ward_have_no_number(raw):
    assert b.source_ward_no(raw) is None


@pytest.mark.parametrize('raw,num', [('168\n', 168), ('\n    5\n    ', 5)])
def test_polygon_ward_number_ignores_kml_whitespace(raw, num):
    assert b.polygon_ward_no(raw) == num


def test_join_needs_one_to_one_wards():
    assert b.join_problems({1: 'a', 2: 'b'}, {1: 'x', 2: 'y'}) == []
    probs = b.join_problems({1: 'a', 3: 'c'}, {1: 'x', 2: 'y'})
    assert 'figures for wards with no polygon: [3]' in probs
    assert 'polygons with no figures: [2]' in probs


def test_tile_fields_are_source_columns():
    cols = b.SOURCE_COLUMNS
    assert set(b.TILE_FIELDS) <= set(cols) | {'ward_no'}


def test_catalog_entry_carries_godl_credit_and_formats():
    e = b.catalog_entry(200, {f: 1 for f in b.EXT}, '2026-11-17', 'https://r2')
    assert e['id'] == 'property_tax_chennai_wards' and e['category'] == 'economy'
    assert e['licence'] == 'GODL-India' and e['fetched_at'] == '2026-11-17'
    assert 'Greater Chennai Corporation' in e['attribution']['primary']['name']
    assert e['choropleth']['column'] in b.SOURCE_COLUMNS
    for fmt, ext in b.EXT.items():
        assert e[fmt]['url'] == f'https://r2/{b.R2_PREFIX}/{b.BASENAME}.{ext}'


def test_shapefile_names_are_unique_dbf_names_for_every_column():
    names = list(b.SHP_NAMES.values())
    assert len({n.lower() for n in names}) == len(names)
    assert all(len(n) <= 10 and ' ' not in n for n in names)
    assert set(b.SOURCE_COLUMNS) <= set(b.SHP_NAMES)
    assert b.SHP_NAMES['2013-14 - Property Tax Collection (in crores) - Residential'] == 'RCOL_1314'
    assert b.SHP_NAMES['2017-18 - Property Tax Demand (in crores) - Commercial'] == 'CDEM_1718'
