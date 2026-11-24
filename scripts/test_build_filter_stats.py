"""Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_build_filter_stats.py -q"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
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
    {'name': 'constant', 'type': 'string', 'distinct': 1, 'null_frac': 0.0, 'min': 'same', 'max': 'same',
     'top_values': [{'v': 'same', 'n': 60}]},
    {'name': 'nested', 'type': 'blob', 'distinct': -1, 'null_frac': 0},
    {'name': 'geometry', 'type': 'geometry', 'distinct': -1, 'null_frac': 0}]}


@pytest.fixture
def fixture_parquet(tmp_path):
    return write_fixture(tmp_path / 'f.parquet')


def test_stats_match_the_per_column_output_in_two_scans(fixture_parquet):
    con = CountingCon(fixture_parquet)
    assert fs.stats_for_parquet(fixture_parquet, con) == BEFORE
    assert con.scans == 2          # was 1 + 1 per column + 1 per faceted column (14)


def test_a_one_value_column_keeps_its_value(fixture_parquet):
    # /api/v1/layers/{id}/schema lists a column's values when it has at most 20,
    # one included (the panel drops such columns, so its choices are unchanged).
    s = fs.stats_for_parquet(fixture_parquet, duckdb.connect())
    assert next(c for c in s['columns'] if c['name'] == 'constant')['top_values'] == [{'v': 'same', 'n': 60}]


def test_parquet_columns_are_the_top_level_columns_with_their_parquet_types(fixture_parquet):
    # What the API's schemaType reads (hyparquet's physical and converted type),
    # so a baked schema types each column as the live read does.
    cols = fs.parquet_columns(duckdb.connect(), str(fixture_parquet))
    assert [c['name'] for c in cols] == ['state', 'state_code', 'flag', 'val', 'sometimes', 'never',
                                         'constant', 'nested', 'geometry']
    by = {c['name']: c for c in cols}
    assert by['state'] == {'name': 'state', 'type': 'BYTE_ARRAY', 'converted_type': 'UTF8'}
    assert by['state_code'] == {'name': 'state_code', 'type': 'INT32', 'converted_type': 'INT_32'}
    assert by['flag'] == {'name': 'flag', 'type': 'BOOLEAN'}
    assert by['nested'] == {'name': 'nested', 'nested': True}


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


# ── the Filter panel's columns, for the map tiles ───────────────────────────

CASES = json.loads((Path(__file__).resolve().parent.parent / 'web' / 'tests' / 'fixtures'
                    / 'filter-columns.json').read_text())['cases']


@pytest.mark.parametrize('case', CASES, ids=[c['name'] for c in CASES])
def test_rank_columns_matches_the_panel(case):
    # Same cases as web/tests/filter-schema.test.ts (rankColumns).
    grouped = {m for g in case.get('column_groups', []) for m in g['members'] if m != g['canonical']}
    cols = [c for c in case['columns'] if c['name'] not in grouped]
    assert [c['name'] for c in fs.rank_columns(cols, case['row_count'])] == case['ranked']


@pytest.mark.parametrize('case', CASES, ids=[c['name'] for c in CASES])
def test_tile_filter_columns_are_the_panels_low_cardinality_columns(case):
    assert fs.tile_filter_columns(case) == case['tile']


def test_panel_stats_come_from_where_the_viewer_reads_them(tmp_path):
    # web/src/filter-stats.ts loadBakedStats, then filter-schema.ts columnStatsSource.
    inline, filed, probed = ({'row_count': n, 'columns': []} for n in (1, 2, 3))
    (tmp_path / 'big.json').write_text(json.dumps(filed))

    def stats(lid, nbytes, catalog=None):
        layer = {'id': lid, 'parquet': {'url': 'https://r2/x.parquet', 'bytes': nbytes}}
        return fs.panel_stats(layer, catalog or {}, lambda: probed, stats_dir=tmp_path, threshold=100)

    assert stats('small', 10, {'filter_stats': {'small': inline}}) == inline   # the catalog's
    assert stats('big', 500) == filed                                           # the layer's file
    assert stats('other_big', 500) is None      # large, no file: no panel, so no columns
    assert stats('small', 10) == probed         # the browser's probe
    (tmp_path / 'small.json').write_text(json.dumps(filed))  # every layer has a file for /schema now,
    assert stats('small', 10) == probed         # but the viewer only reads a large layer's
    assert fs.panel_stats({'id': 'x', 'parquet': None}, {}, lambda: probed, tmp_path, 100) is None


def test_probe_stats_skip_columns_the_panel_never_offers(tmp_path):
    # Mirrors web/src/filter-probe.ts, which the viewer runs for layers without baked stats.
    src = tmp_path / 'p.parquet'
    con = duckdb.connect()
    con.execute(f"COPY (SELECT range AS gid, chr(65 + range::INT % 3) AS zone FROM range(10)) TO '{src}'")
    s = fs.stats_for_parquet(src, con, probe=True)
    assert [(c['name'], c['distinct']) for c in s['columns']] == [('gid', -1), ('zone', 3)]
    assert fs.tile_filter_columns(s) == ['zone']
