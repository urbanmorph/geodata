"""Tests for the zones in scripts/build_ward_index.py (no network).

A ward layer that carries a zone column (named zone/Zone/ZONE, or the column the layer's override already reads as
its zone) gets each ward's zone in the view-only sidecar, so the /view page can list wards zone by zone. Zones come
only from the layer's own column; nothing is invented.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_ward_zones.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_ward_index as w  # noqa: E402


def write(con, pq, rows: list[tuple]):
    """rows: (ward_no, ward_name, Zone)."""
    values = ', '.join(f"('{n}', '{nm}', {('NULL' if z is None else repr(z))})" for n, nm, z in rows)
    con.execute(f"COPY (SELECT * FROM (VALUES {values}) t(ward_no, ward_name, Zone)) TO '{pq}' (FORMAT parquet)")


@pytest.fixture
def layer(tmp_path, monkeypatch):
    con = duckdb.connect()
    pq = tmp_path / 'wards_test.parquet'
    monkeypatch.setattr(w, 'find_parquet', lambda layer: pq)
    monkeypatch.setattr(w, 'OSM_CACHE', tmp_path / 'none')
    return con, pq


def test_each_ward_carries_the_zone_from_a_column_named_zone(layer):
    con, pq = layer
    write(con, pq, [('1', 'Gota', '2'), ('2', 'Kharika', '1'), ('3', 'Chinhat', None)])
    idx = w.build_one(con, {'id': 'wards_test'}, {})
    assert idx['rows'] == [
        {'no': '1', 'name': 'Gota', 'zone': '2'},
        {'no': '2', 'name': 'Kharika', 'zone': '1'},
        {'no': '3', 'name': 'Chinhat'},                  # no zone in the source: none given
    ]


def test_a_layer_without_a_zone_column_gets_no_zones(layer):
    con, pq = layer
    con.execute(f"COPY (SELECT * FROM (VALUES ('1', 'Gota')) t(ward_no, ward_name)) TO '{pq}' (FORMAT parquet)")
    idx = w.build_one(con, {'id': 'wards_test'}, {})
    assert idx['rows'] == [{'no': '1', 'name': 'Gota'}]


def test_a_ward_split_across_zones_gets_no_zone(layer):
    con, pq = layer
    rows = [(str(n), f'W{n}', '1') for n in range(1, 20)] + [('0', 'Airport', '5'), ('0', 'Cantonment', '0')]
    write(con, pq, rows)
    by_no = {r['no']: r for r in w.build_one(con, {'id': 'wards_test'}, {})['rows']}
    assert 'zone' not in by_no['0']
    assert by_no['1']['zone'] == '1'


def test_zones_are_dropped_when_ward_numbers_repeat_across_many_features(layer):
    # Greater Bengaluru: five corporations each number their wards from 1, so a ward number names no single ward.
    con, pq = layer
    write(con, pq, [('1', 'A', 'Zone1'), ('1', 'B', 'Zone2'), ('2', 'C', 'Zone1'), ('2', 'D', 'Zone2')])
    rows = w.build_one(con, {'id': 'wards_test'}, {})['rows']
    assert all('zone' not in r for r in rows)


def test_the_override_s_zone_column_counts_as_the_zone(layer, monkeypatch):
    # Bhubaneswar: no column named zone, but the override already reads 'municipalzone' as the layer's zone.
    con, pq = layer
    con.execute(f"""COPY (SELECT * FROM (VALUES ('1', 'North Zone'), ('2', 'South-East Zone')) t(wardno, municipalzone))
                    TO '{pq}' (FORMAT parquet)""")
    monkeypatch.setitem(w.OVERRIDES, 'wards_test', ('wardno', 'municipalzone', 'Zone'))
    rows = w.build_one(con, {'id': 'wards_test'}, {})['rows']
    assert [r['zone'] for r in rows] == ['North Zone', 'South-East Zone']


def test_number_only_layers_with_osm_areas_also_carry_zones(layer, tmp_path, monkeypatch):
    con, pq = layer
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(f"""COPY (SELECT * FROM (VALUES
        ('1', 'A', ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))')),
        ('2', 'B', ST_GeomFromText('POLYGON((1 0,2 0,2 1,1 1,1 0))'))) t(wardnum, zone, geom)) TO '{pq}' (FORMAT parquet)""")
    (tmp_path / 'wards_test.json').write_text('{"fetched": "2026-11-12", "elements": []}')
    monkeypatch.setattr(w, 'OSM_CACHE', tmp_path)
    monkeypatch.setitem(w.OVERRIDES, 'wards_test', ('wardnum', None, None))
    rows = w.build_one(con, {'id': 'wards_test'}, {})['rows']
    assert rows == [{'no': '1', 'name': '', 'areas': [], 'zone': 'A'}, {'no': '2', 'name': '', 'areas': [], 'zone': 'B'}]
