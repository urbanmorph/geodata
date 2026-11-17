"""Locate tests a point against PMTiles geometry at the tileset's max zoom.
bharatviz_pincodes stopped at z4 (tippecanoe -zg), so MG Road fell inside a
coarse Bettahalsur (562157) blob instead of 560001 (Nov 2026).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_rebake_locate_tiles.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rebake_locate_tiles as rt  # noqa: E402

URL = 'https://pub-x.r2.dev/postal/boundaries/bharatviz_pincodes.pmtiles'


def test_tiles_go_to_zoom_12_and_keep_every_feature_there():
    cmd = rt.tippecanoe_cmd(Path('in.geojson'), Path('out.pmtiles'), 'bharatviz_pincodes')
    assert cmd[0] == 'tippecanoe' and '-z12' in cmd and '-zg' not in cmd
    assert '--extend-zooms-if-still-dropping' in cmd  # never drop at max zoom
    assert ['-l', 'bharatviz_pincodes'] == cmd[cmd.index('-l'):cmd.index('-l') + 2]


def test_new_tiles_go_to_a_versioned_key_not_the_cached_one():
    # The old object is served immutable for 7 days; overwriting it would keep
    # serving the coarse tiles from caches.
    assert rt.versioned_key(URL) == 'postal/boundaries/bharatviz_pincodes.z12.pmtiles'
    assert rt.versioned_key(URL.replace('.pmtiles', '.z12.pmtiles')) == 'postal/boundaries/bharatviz_pincodes.z12.pmtiles'


def test_patch_points_the_layer_at_the_new_tiles_and_keeps_the_rest():
    layer = {'id': 'bharatviz_pincodes', 'rows': 3, 'pmtiles': {'url': URL, 'bytes': 1, 'upstream_url': 'u'}}
    out = rt.patched_layer(layer, 'https://pub-x.r2.dev', 'postal/boundaries/bharatviz_pincodes.z12.pmtiles', 99)
    assert out['pmtiles'] == {'url': 'https://pub-x.r2.dev/postal/boundaries/bharatviz_pincodes.z12.pmtiles',
                              'bytes': 99, 'upstream_url': 'u'}
    assert out['rows'] == 3 and layer['pmtiles']['url'] == URL  # input untouched


def _layer(tmp_path, lid='bharatviz_pincodes'):
    import pipeline
    pq = tmp_path / 'src.parquet'
    if not pq.exists():
        pipeline.make_con().execute(
            "COPY (SELECT '560001' AS pincode, ST_GeomFromText('POLYGON((77.5 12.9, 77.6 12.9, 77.6 13, 77.5 12.9))') "
            f"AS geometry) TO '{pq}' (FORMAT PARQUET)")
    return {'id': lid, 'parquet': {'url': str(pq)}, 'pmtiles': {'url': URL.replace('bharatviz_pincodes', lid)}}


def test_a_rerun_does_not_run_tippecanoe_again(tmp_path, monkeypatch):
    # Every run re-ran tippecanoe (up to 30 min a layer) for every layer.
    import shutil
    monkeypatch.setattr(rt, 'WORK', tmp_path / 'work')
    monkeypatch.setattr(rt, 'download', lambda url, dest: dest.exists() or shutil.copy(url, dest))
    calls = []

    def fake_run(cmd, *a, **k):
        calls.append(cmd[0])
        Path(cmd[cmd.index('-o') + 1]).write_bytes(b'tiles')
    monkeypatch.setattr(rt.subprocess, 'run', fake_run)
    first = rt.bake(_layer(tmp_path))
    assert calls == ['tippecanoe'] and first.read_bytes() == b'tiles'
    assert rt.bake(_layer(tmp_path)) == first and calls == ['tippecanoe']


def test_catalog_is_patched_after_each_layer(tmp_path, monkeypatch):
    # The catalog was written once after the loop, so a kill lost every patch.
    import json
    cat = tmp_path / 'catalog.json'
    layers = [_layer(tmp_path, 'a'), _layer(tmp_path, 'b')]
    cat.write_text(json.dumps({'layers': layers}))
    monkeypatch.setattr(rt, 'CATALOG', cat)
    monkeypatch.setattr(rt, 'LAYERS', ['a', 'b'])
    monkeypatch.setattr(rt, 'r2_client', lambda: object())
    monkeypatch.setattr(rt, 'r2_upload', lambda *a: None)
    out = tmp_path / 'a.z12.pmtiles'
    out.write_bytes(b'tiles')

    def bake(layer):
        if layer['id'] == 'b':
            raise KeyboardInterrupt  # killed mid-run
        return out
    monkeypatch.setattr(rt, 'bake', bake)
    with pytest.raises(KeyboardInterrupt):
        rt.main(['x'])
    a = json.loads(cat.read_text())['layers'][0]
    assert a['pmtiles']['url'].endswith('/postal/boundaries/a.z12.pmtiles') and a['pmtiles']['bytes'] == 5


def test_tile_args_come_from_the_shared_builder():
    import bake_formats
    assert rt.tippecanoe_cmd(Path('i.geojson'), Path('o.pmtiles'), 'l') == bake_formats.pmtiles_args(
        Path('i.geojson'), Path('o.pmtiles'), 'l', (), max_zoom=12)
