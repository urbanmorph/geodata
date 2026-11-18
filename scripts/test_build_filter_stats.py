"""Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_build_filter_stats.py -q"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_filter_stats as fs  # noqa: E402
from build_filter_stats import normalise_type  # noqa: E402
from stats_fixture import CountingCon, write_fixture  # noqa: E402


@pytest.mark.parametrize('t', ['STRUCT("primary" VARCHAR)', 'VARCHAR[]', 'MAP(VARCHAR, VARCHAR)',
                               'STRUCT(a INTEGER)[]', 'INTEGER[3]', 'UNION(a INTEGER, b VARCHAR)'])
def test_nested_types_are_blob_not_searchable_strings(t):
    # Mirrors web/src/filter-probe.ts: nested values can't be filtered.
    assert normalise_type(t) == 'blob'


@pytest.mark.parametrize('t,norm', [('VARCHAR', 'string'), ('DECIMAL(18,2)', 'float'),
                                    ('BIGINT', 'int'), ('GEOMETRY', 'geometry')])
def test_flat_types_unchanged(t, norm):
    assert normalise_type(t) == norm


# ── one scan per pass (review item 18) ──────────────────────────────────────

# What the per-column code wrote for the fixture before the scans were merged.
BEFORE = {'row_count': 60, 'columns': [
    {'name': 'state', 'type': 'string', 'distinct': 3, 'null_frac': 0.0, 'min': 'Alpha', 'max': 'Gamma',
     'top_values': [{'v': 'Alpha', 'n': 30}, {'v': 'Beta', 'n': 20}, {'v': 'Gamma', 'n': 10}]},
    {'name': 'state_code', 'type': 'int', 'distinct': 3, 'null_frac': 0.0, 'min': 1, 'max': 3,
     'top_values': [{'v': 1, 'n': 30}, {'v': 2, 'n': 20}, {'v': 3, 'n': 10}]},
    {'name': 'flag', 'type': 'bool', 'distinct': 2, 'null_frac': 0.0, 'min': 'false', 'max': 'true',
     'top_values': [{'v': 'true', 'n': 40}, {'v': 'false', 'n': 20}]},
    {'name': 'val', 'type': 'float', 'distinct': 60, 'null_frac': 0.0, 'min': 0.0, 'max': 88.5},
    {'name': 'sometimes', 'type': 'string', 'distinct': 2, 'null_frac': 0.25, 'min': 'x', 'max': 'y',
     'top_values': [{'v': 'x', 'n': 24}, {'v': 'y', 'n': 21}]},
    {'name': 'never', 'type': 'string', 'distinct': 0, 'null_frac': 1.0},
    {'name': 'constant', 'type': 'string', 'distinct': 1, 'null_frac': 0.0, 'min': 'same', 'max': 'same'},
    {'name': 'nested', 'type': 'blob', 'distinct': -1, 'null_frac': 0},
    {'name': 'geometry', 'type': 'geometry', 'distinct': -1, 'null_frac': 0}]}


@pytest.fixture
def fixture_parquet(tmp_path):
    return write_fixture(tmp_path / 'f.parquet')


def test_stats_match_the_per_column_output_in_two_scans(fixture_parquet):
    con = CountingCon(fixture_parquet)
    assert fs.stats_for_parquet(fixture_parquet, con) == BEFORE
    assert con.scans == 2          # was 1 + 1 per column + 1 per faceted column (14)


def test_equivalences_match_in_one_scan(fixture_parquet):
    con = CountingCon(fixture_parquet)
    groups = fs.detect_equivalences(str(fixture_parquet), BEFORE['columns'], 60, con)
    assert groups == [['flag', 'sometimes', 'state', 'state_code']]
    assert con.scans == 1          # was one per candidate pair (4)


def test_a_column_the_merged_query_cannot_take_falls_back_per_column(fixture_parquet, monkeypatch):
    real = fs._column_aggs
    monkeypatch.setattr(fs, '_column_aggs', lambda c: ["error('boom')"] if c == 'val' else real(c))
    s = fs.stats_for_parquet(fixture_parquet, CountingCon(fixture_parquet))
    assert s['columns'] == [c for c in BEFORE['columns'] if c['name'] != 'val']


def test_value_counts_one_scan_nulls_left_out_ties_by_value(fixture_parquet):
    con = CountingCon(fixture_parquet)
    got = fs.value_counts(con, str(fixture_parquet), ['sometimes', 'nested', 'never'], limit=50)
    assert got == {'sometimes': [('x', 24), ('y', 21)],
                   'nested': [("{'k': 0}", 30), ("{'k': 1}", 30)],
                   'never': []}
    assert con.scans == 1
