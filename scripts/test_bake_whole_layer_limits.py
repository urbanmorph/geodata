"""bake_whole_layer.py keeps a download over its format limit off the upload path.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_whole_layer_limits.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_whole_layer as bwl  # noqa: E402
import pipeline  # noqa: E402


def _file(tmp_path, name, nbytes):
    p = tmp_path / name
    with p.open('wb') as fh:
        fh.truncate(nbytes)
    return p


def test_a_file_over_its_limit_is_set_aside_not_left_for_upload(tmp_path, monkeypatch):
    monkeypatch.setitem(pipeline.FORMAT_MAX_BYTES, 'kml', 10)
    kml = _file(tmp_path, 'x.kml', 11)
    assert bwl.set_aside_if_over_limit('kml', kml) is True
    assert not kml.exists() and (tmp_path / 'x.kml.over-limit').exists()


def test_a_file_within_its_limit_stays(tmp_path):
    gj = _file(tmp_path, 'x.geojson', 10)
    assert bwl.set_aside_if_over_limit('geojson', gj) is False
    assert gj.exists()


def test_a_rerun_takes_back_a_fresh_held_file_so_nothing_is_rebaked(tmp_path):
    src = _file(tmp_path, 'src.parquet', 1)
    held = _file(tmp_path, 'x.geojson.over-limit', 5)
    paths = {'geojson': tmp_path / 'x.geojson', 'kml': tmp_path / 'x.kml'}
    bwl.take_back_held(paths, src)
    assert paths['geojson'].exists() and not held.exists()
