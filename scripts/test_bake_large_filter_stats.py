"""Filter stats for every layer the Filter panel filters on the API.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_large_filter_stats.py -q
"""
from __future__ import annotations

import functools
import http.server
import json
import sys
import threading
from pathlib import Path

import duckdb
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_large_filter_stats as b  # noqa: E402
import build_filter_stats as fs  # noqa: E402

MB = 1024 * 1024


def test_threshold_is_read_from_the_shared_rule():
    assert b.large_filter_bytes() == 100 * MB


def test_targets_are_large_layers_without_stats():
    cat = {'layers': [
        {'id': 'big', 'parquet': {'url': 'u1', 'bytes': 101 * MB}},
        {'id': 'done', 'parquet': {'url': 'u2', 'bytes': 500 * MB}},
        {'id': 'small', 'parquet': {'url': 'u3', 'bytes': 99 * MB}},
        {'id': 'none', 'parquet': None},
    ], 'filter_stats': {'done': {}}}
    assert [x['id'] for x in b.targets(cat, 100 * MB)] == ['big']


@pytest.fixture
def served(tmp_path):
    """A small parquet over HTTP (http.server ignores Range, so DuckDB reads it
    whole: fine for a test; R2 serves ranges)."""
    con = duckdb.connect()
    pq = tmp_path / 'x.parquet'
    con.execute(f"COPY (SELECT i::VARCHAR AS id, CASE WHEN i % 2 = 0 THEN 'KA' ELSE 'MH' END AS state "
                f"FROM range(20) t(i)) TO '{pq}' (FORMAT PARQUET)")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(tmp_path))
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{srv.server_port}/x.parquet'
    srv.shutdown()


def test_stats_read_straight_from_a_url(served):
    out = fs.build_all([('lyr', served)])
    s = out['lyr']
    assert s['row_count'] == 20
    state = next(c for c in s['columns'] if c['name'] == 'state')
    assert state['distinct'] == 2 and {v['v'] for v in state['top_values']} == {'KA', 'MH'}


def test_bake_patches_catalog_per_layer_and_is_idempotent(served, tmp_path):
    cat = tmp_path / 'catalog.json'
    cat.write_text(json.dumps({'layers': [
        {'id': 'big', 'parquet': {'url': served, 'bytes': 200 * MB}},
        {'id': 'small', 'parquet': {'url': served, 'bytes': 1}},
    ], 'filter_stats': {}}))
    assert b.bake(cat, threshold=100 * MB) == ['big']
    first = cat.read_text()
    stats = json.loads(first)['filter_stats']
    assert list(stats) == ['big'] and stats['big']['row_count'] == 20
    assert b.bake(cat, threshold=100 * MB) == []  # nothing left: no work, no change
    assert cat.read_text() == first
