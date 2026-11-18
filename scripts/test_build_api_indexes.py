"""Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_build_api_indexes.py -q"""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_api_indexes as ai  # noqa: E402
from stats_fixture import CountingCon, write_fixture  # noqa: E402


def test_layer_stats_match_the_per_column_output_in_two_scans(tmp_path):
    pq = write_fixture(tmp_path / 'f.parquet')
    con = CountingCon(pq)
    got = ai.compute_layer_stats(con, pq, 'x')
    assert con.scans == 2          # was 1 + 1 per column + 1 per groupable column (16)
    # What the per-column code wrote before (ties came back in any order then;
    # now they are ordered by value).
    col = {'row_count': 60}
    assert got == {'row_count': 60, 'columns': {
        'state': {'type': 'string', 'distinct': 3, **col, 'values': {'Alpha': 30, 'Beta': 20, 'Gamma': 10}},
        'state_code': {'type': 'number', 'distinct': 3, **col, 'values': {'1': 30, '2': 20, '3': 10}},
        'flag': {'type': 'boolean', 'distinct': 2, **col, 'values': {'true': 40, 'false': 20}},
        'val': {'type': 'number', 'distinct': 60, **col, 'values': {str(i * 1.5): 1 for i in range(60)}},
        'sometimes': {'type': 'string', 'distinct': 2, **col, 'values': {'x': 24, 'y': 21}},
        'never': {'type': 'string', 'distinct': 0, **col},
        'constant': {'type': 'string', 'distinct': 1, **col, 'values': {'same': 60}},
        'nested': {'type': 'number', 'distinct': 2, **col, 'values': {"{'k': 0}": 30, "{'k': 1}": 30}},
    }}
    assert list(got['columns']['state']['values']) == ['Alpha', 'Beta', 'Gamma']   # most first
    assert list(got['columns']['nested']['values']) == ["{'k': 0}", "{'k': 1}"]     # ties by value


def test_empty_layer(tmp_path):
    pq = tmp_path / 'e.parquet'
    duckdb.connect().execute(f"COPY (SELECT 1 AS a WHERE false) TO '{pq}' (FORMAT PARQUET)")
    assert ai.compute_layer_stats(CountingCon(pq), pq, 'e') == {'row_count': 0, 'columns': {}}
