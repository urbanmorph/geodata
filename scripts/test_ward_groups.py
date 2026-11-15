"""Ward numbers that restart per sub-body (Greater Bengaluru: 5 corporations,
each numbering from 1; 369 wards, 112 distinct numbers). Keyed by number
alone, the sidecar merged them into 112 rows named after whichever corporation
came first. Grouped layers key by (group, number) and carry the group.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_ward_groups.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_ward_index as w  # noqa: E402


@pytest.fixture
def gba(tmp_path, monkeypatch):
    con = duckdb.connect()
    pq = tmp_path / 'wards_bengaluru_gba.parquet'
    con.execute(f"""COPY (SELECT * FROM (VALUES
        ('1', 'Kempapura', 'North'), ('2', 'Byatarayanapura', 'North'),
        ('1', 'Malleshwaram', 'West'), ('1', 'Shivajinagar', 'Central')
    ) t(ward_id, ward_name, Corporation)) TO '{pq}' (FORMAT parquet)""")
    monkeypatch.setattr(w, 'find_parquet', lambda layer: pq)
    monkeypatch.setattr(w, 'OSM_CACHE', tmp_path / 'none')
    return con


def test_every_ward_is_listed_once_per_corporation(gba):
    idx = w.build_one(gba, {'id': 'wards_bengaluru_gba'}, {})
    rows = {(r['group'], r['no']): r['name'] for r in idx['rows']}
    assert rows == {('Central', '1'): 'Shivajinagar', ('North', '1'): 'Kempapura',
                    ('North', '2'): 'Byatarayanapura', ('West', '1'): 'Malleshwaram'}
    assert idx['groupCol'] == 'Corporation' and idx['groupLabel'] == 'Corporation'


def test_rows_sort_by_group_then_number(gba):
    idx = w.build_one(gba, {'id': 'wards_bengaluru_gba'}, {})
    assert [(r['group'], r['no']) for r in idx['rows']] == [
        ('Central', '1'), ('North', '1'), ('North', '2'), ('West', '1')]


def test_ungrouped_layers_have_no_group(tmp_path, monkeypatch):
    con = duckdb.connect()
    pq = tmp_path / 'x.parquet'
    con.execute(f"COPY (SELECT '5' AS ward_no, 'Ameerpet' AS ward_name) TO '{pq}' (FORMAT parquet)")
    monkeypatch.setattr(w, 'find_parquet', lambda layer: pq)
    idx = w.build_one(con, {'id': 'wards_test'}, {})
    assert 'groupCol' not in idx and 'group' not in idx['rows'][0]
