"""Column stats files for every curated parquet layer (the Filter panel and /schema).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_filter_stats.py -q
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
import bake_filter_stats as b  # noqa: E402
import build_filter_stats as fs  # noqa: E402

MB = 1024 * 1024


def test_threshold_is_read_from_the_shared_rule():
    assert b.large_filter_bytes() == 100 * MB


def test_large_layers_are_those_over_the_threshold_with_a_parquet():
    cat = {'layers': [
        {'id': 'big', 'parquet': {'url': 'u1', 'bytes': 101 * MB}},
        {'id': 'small', 'parquet': {'url': 'u3', 'bytes': 99 * MB}},
        {'id': 'none', 'parquet': None},
    ]}
    assert [x['id'] for x in b.large_layers(cat, 100 * MB)] == ['big']


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    """Serves byte ranges (206), as R2 does. http.server alone ignores Range
    and answers 200 with the whole file, which DuckDB retries as a failed read
    (with the bake's retry backoff, for minutes)."""

    def log_message(self, *_):
        pass

    def do_GET(self):
        rng = self.headers.get('Range')
        if not rng:
            return super().do_GET()
        data = Path(self.translate_path(self.path)).read_bytes()
        start, end = rng.removeprefix('bytes=').split('-')
        start, end = int(start), min(int(end or len(data) - 1), len(data) - 1)
        self.send_response(206)
        self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()
        self.wfile.write(data[start:end + 1])


@pytest.fixture
def served(tmp_path):
    """A small parquet over HTTP, served in byte ranges."""
    con = duckdb.connect()
    pq = tmp_path / 'x.parquet'
    con.execute(f"COPY (SELECT i::VARCHAR AS id, CASE WHEN i % 2 = 0 THEN 'KA' ELSE 'MH' END AS state "
                f"FROM range(20) t(i)) TO '{pq}' (FORMAT PARQUET)")
    handler = functools.partial(RangeHandler, directory=str(tmp_path))
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


def _catalog(path, served, **extra):
    path.write_text(json.dumps({'layers': [
        {'id': 'big', 'parquet': {'url': served, 'bytes': 200 * MB}},
        {'id': 'small', 'parquet': {'url': served, 'bytes': 1}},
        {'id': 'c_abc', 'parquet': {'url': served, 'bytes': 1}},   # community: /schema reads it live
        {'id': 'none', 'parquet': None},
    ], **extra}))


def test_bake_writes_a_file_per_curated_parquet_layer_never_the_catalog(served, tmp_path):
    # Stats in catalog.json reach every visitor (75 -> 99 KB gzipped for 23
    # layers): they live in web/public/api-data/filter-stats/<id>.json, read
    # by the Filter panel (large layers) and /api/v1/layers/{id}/schema (all).
    cat, out = tmp_path / 'catalog.json', tmp_path / 'filter-stats'
    _catalog(cat, served, filter_stats={'big': {'row_count': 5, 'columns': []},
                                        'small': {'row_count': 1, 'columns': []}})
    assert b.bake(cat, out, threshold=100 * MB) == ['big', 'small']
    c = json.loads(cat.read_text())
    assert c['filter_stats'] == {'small': {'row_count': 1, 'columns': []}}  # small layers keep theirs
    assert sorted(p.name for p in out.iterdir()) == ['big.json', 'small.json']
    big = json.loads((out / 'big.json').read_text())
    assert big['row_count'] == 20
    # Which parquet the stats came from, so a stale file is caught (and not served).
    assert big['parquet'] == {'url': served, 'bytes': 200 * MB}
    assert big['schema'] == [{'name': 'id', 'type': 'BYTE_ARRAY', 'converted_type': 'UTF8'},
                             {'name': 'state', 'type': 'BYTE_ARRAY', 'converted_type': 'UTF8'}]


def test_a_second_run_does_no_work_and_a_changed_parquet_is_baked_again(served, tmp_path):
    cat, out = tmp_path / 'catalog.json', tmp_path / 'filter-stats'
    _catalog(cat, served)
    b.bake(cat, out, threshold=100 * MB)
    files = {p.name: p.read_bytes() for p in out.iterdir()}
    first = cat.read_text()
    assert b.bake(cat, out, threshold=100 * MB) == []  # nothing stale: no work, no change
    assert cat.read_text() == first and {p.name: p.read_bytes() for p in out.iterdir()} == files
    c = json.loads(first)
    c['layers'][1]['parquet']['bytes'] = 2               # the small layer's parquet was replaced
    cat.write_text(json.dumps(c))
    assert b.bake(cat, out, threshold=100 * MB) == ['small']
    assert json.loads((out / 'small.json').read_text())['parquet']['bytes'] == 2


def test_a_file_from_before_the_source_was_recorded_is_stale(tmp_path):
    layer = {'id': 'x', 'parquet': {'url': 'u', 'bytes': 5}}
    assert not b.is_fresh(tmp_path / 'x.json', layer)                      # no file
    (tmp_path / 'x.json').write_text(json.dumps({'row_count': 1, 'columns': []}))
    assert not b.is_fresh(tmp_path / 'x.json', layer)                      # old format
    (tmp_path / 'x.json').write_text(json.dumps({'parquet': {'url': 'u', 'bytes': 5}, 'schema': []}))
    assert b.is_fresh(tmp_path / 'x.json', layer)
    assert not b.is_fresh(tmp_path / 'x.json', {'id': 'x', 'parquet': {'url': 'u2', 'bytes': 5}})
    (tmp_path / 'x.json').write_text('{"parquet": {"url": "u", "bytes": 5}, "schema": [], "max": NaN}')
    assert not b.is_fresh(tmp_path / 'x.json', layer)                      # not JSON to a browser


def test_stats_missing_a_column_are_incomplete_never_saved_and_stale(served, tmp_path, monkeypatch):
    # Overture, 24 Nov 2026: R2 answered 429 to six columns' aggregates, the
    # per-column fallback left them out, and the file was saved without them.
    schema = [{'name': 'id', 'type': 'BYTE_ARRAY'}, {'name': 'state', 'type': 'BYTE_ARRAY'}]
    full = {'row_count': 2, 'schema': schema, 'columns': [
        {'name': 'id', 'distinct': 2, 'top_values': [{'v': 'a', 'n': 1}, {'v': 'b', 'n': 1}]},
        {'name': 'state', 'distinct': 60}]}
    assert b.incomplete(full) == []
    assert b.incomplete({**full, 'columns': full['columns'][1:]}) == ['id: no stats']
    assert b.incomplete({**full, 'columns': [{'name': 'id', 'distinct': 2}, full['columns'][1]]}) == ['id: no top values']
    layer = {'id': 'x', 'parquet': {'url': 'u', 'bytes': 5}}
    (tmp_path / 'x.json').write_text(json.dumps({**full, 'columns': full['columns'][1:], 'parquet': layer['parquet']}))
    assert not b.is_fresh(tmp_path / 'x.json', layer)

    cat, out = tmp_path / 'catalog.json', tmp_path / 'filter-stats'
    _catalog(cat, served)
    real = fs.build_all

    def drop_first_column(layers):
        return {k: {**v, 'columns': v['columns'][1:]} for k, v in real(layers).items()}
    monkeypatch.setattr(fs, 'build_all', drop_first_column)
    assert b.bake(cat, out, threshold=100 * MB) == []
    assert not out.exists() or not list(out.iterdir())


def test_a_nan_or_infinite_value_is_written_as_text_so_the_file_stays_json(tmp_path):
    # subsidence_megacities: DuckDB's MAX of a float column holding NaN is NaN,
    # which Python writes bare and JSON.parse (the API, the viewer) refuses.
    b.write_stats(tmp_path / 's.json', {'columns': [{'min': -5.1, 'max': float('nan'),
                                                     'top_values': [{'v': float('inf'), 'n': 2}]}]})
    text = (tmp_path / 's.json').read_text()
    assert json.loads(text, parse_constant=lambda c: pytest.fail(f'bare {c}')) == {
        'columns': [{'min': -5.1, 'max': 'NaN', 'top_values': [{'v': 'Infinity', 'n': 2}]}]}


def test_the_time_limit_stops_before_the_next_layer(served, tmp_path):
    cat, out = tmp_path / 'catalog.json', tmp_path / 'filter-stats'
    _catalog(cat, served)
    assert b.bake(cat, out, threshold=100 * MB, minutes=0) == []
    assert b.bake(cat, out, threshold=100 * MB) == ['big', 'small']  # the rerun continues
