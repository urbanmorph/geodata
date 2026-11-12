"""Tests for scripts/fetch_osm_areas.py and the areas in scripts/build_ward_index.py (no network).

Area names come from OpenStreetMap suburb, neighbourhood and quarter places, placed in the ward that contains
them. They go in the view-only ward-index sidecar, never in the layer or its downloads.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_osm_areas.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_ward_index as w  # noqa: E402
import fetch_osm_areas as f  # noqa: E402


def test_the_query_asks_for_named_suburbs_neighbourhoods_and_quarters_in_the_box():
    q = f.overpass_query((75.6, 26.7, 76.0, 27.1))           # (west, south, east, north)
    assert '(26.7,75.6,27.1,76.0)' in q                     # Overpass wants south, west, north, east
    assert '"place"~"^(suburb|neighbourhood|quarter)$"' in q
    assert 'out center tags' in q


def test_places_prefer_the_english_name_take_a_way_s_centre_and_skip_the_unnamed():
    answer = {'elements': [
        {'type': 'node', 'lat': 26.91, 'lon': 75.78, 'tags': {'place': 'suburb', 'name': 'राजा पार्क', 'name:en': 'Raja Park'}},
        {'type': 'way', 'center': {'lat': 26.85, 'lon': 75.80}, 'tags': {'place': 'neighbourhood', 'name': 'Malviya Nagar'}},
        {'type': 'node', 'lat': 26.90, 'lon': 75.70, 'tags': {'place': 'quarter'}},
        {'type': 'relation', 'tags': {'place': 'suburb', 'name': 'No centre'}},
    ]}
    assert f.places(answer) == [
        {'name': 'Raja Park', 'kind': 'suburb', 'lat': 26.91, 'lon': 75.78},
        {'name': 'Malviya Nagar', 'kind': 'neighbourhood', 'lat': 26.85, 'lon': 75.80},
    ]


def test_a_cached_answer_is_used_and_no_request_is_made(tmp_path, monkeypatch):
    (tmp_path / 'wards_x.json').write_text(json.dumps({'bbox': [1, 2, 3, 4], 'fetched': '2026-11-12', 'elements': []}))
    monkeypatch.setattr(f, 'CACHE', tmp_path)
    monkeypatch.setattr(f, 'ask', lambda q: pytest.fail('asked Overpass for a cached city'))
    assert f.fetch_one('wards_x', (1, 2, 3, 4)) == 'cached'


@pytest.fixture
def two_wards(tmp_path):
    """Ward 1 is the square (0,0)-(1,1), ward 2 the square (1,0)-(2,1)."""
    pq = tmp_path / 'wards_test.parquet'
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute(f"""COPY (SELECT * FROM (VALUES
        ('1', ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))')),
        ('2', ST_GeomFromText('POLYGON((1 0,2 0,2 1,1 1,1 0))'))) t(ward_no, geom)) TO '{pq}' (FORMAT parquet)""")
    return con, pq


def test_each_area_goes_to_the_ward_that_contains_it_suburbs_first_then_by_name(two_wards):
    con, pq = two_wards
    pts = [
        {'name': 'Zeta Nagar', 'kind': 'neighbourhood', 'lat': 0.5, 'lon': 0.5},
        {'name': 'Alpha Colony', 'kind': 'neighbourhood', 'lat': 0.6, 'lon': 0.4},
        {'name': 'Big Suburb', 'kind': 'suburb', 'lat': 0.2, 'lon': 0.2},
        {'name': 'Big Suburb', 'kind': 'neighbourhood', 'lat': 0.3, 'lon': 0.3},   # the same name twice: once
        {'name': 'East Side', 'kind': 'quarter', 'lat': 0.5, 'lon': 1.5},
        {'name': 'Outside', 'kind': 'suburb', 'lat': 5, 'lon': 5},
    ]
    assert w.areas_by_ward(con, pq, 'ward_no', pts) == {
        '1': ['Big Suburb', 'Alpha Colony', 'Zeta Nagar'],
        '2': ['East Side'],
    }


def test_a_number_only_layer_with_osm_areas_gets_a_sidecar_with_the_areas_apart_from_the_layer_s_own_names(two_wards, tmp_path, monkeypatch):
    con, pq = two_wards
    cache = tmp_path / 'osm'
    cache.mkdir()
    (cache / 'wards_test.json').write_text(json.dumps({'fetched': '2026-11-12', 'elements': [
        {'type': 'node', 'lat': 0.5, 'lon': 0.5, 'tags': {'place': 'suburb', 'name': 'Raja Park'}}]}))
    monkeypatch.setattr(w, 'OSM_CACHE', cache)
    monkeypatch.setitem(w.OVERRIDES, 'wards_test', ('ward_no', None, None))
    monkeypatch.setattr(w, 'find_parquet', lambda layer: pq)
    idx = w.build_one(con, {'id': 'wards_test', 'fetched_at': '2026-05-26'}, {})
    assert idx['nameLabel'] is None                                   # the layer's own names: none, as published
    assert idx['rows'] == [{'no': '1', 'name': '', 'areas': ['Raja Park']}, {'no': '2', 'name': '', 'areas': []}]
    assert idx['areasSource'] == {'name': 'OpenStreetMap contributors', 'licence': 'ODbL-1.0', 'fetched': '2026-11-12'}


def test_without_an_osm_answer_a_number_only_layer_still_gets_no_sidecar(two_wards, tmp_path, monkeypatch):
    con, pq = two_wards
    monkeypatch.setattr(w, 'OSM_CACHE', tmp_path / 'none')
    monkeypatch.setitem(w.OVERRIDES, 'wards_test', ('ward_no', None, None))
    monkeypatch.setattr(w, 'find_parquet', lambda layer: pq)
    assert w.build_one(con, {'id': 'wards_test'}, {}) is None


def test_junk_names_are_dropped_and_numbers_in_names_sort_as_numbers(two_wards):
    con, pq = two_wards
    pts = [{'name': n, 'kind': 'neighbourhood', 'lat': 0.5, 'lon': 0.5}
           for n in ("friend's house", "meow's hose", 'Sector 10', 'Sector 2', 'Sector 11', 'RBI staff quarter')]
    assert w.areas_by_ward(con, pq, 'ward_no', pts) == {'1': ['RBI staff quarter', 'Sector 2', 'Sector 10', 'Sector 11']}
    assert f.junk("friend's house") and f.junk('a place') and not f.junk("St. Mary's Colony") and not f.junk('Sector 2')
