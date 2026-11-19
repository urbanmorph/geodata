"""Every layer bake publishes each file under a content-versioned key.

R2 objects are served immutable for a week, so a refresh that re-uploaded new
bytes to <BASENAME>.parquet let range readers mix old and new bytes, and lost
the previous version. Each bake now uploads to <BASENAME>.<md5[:8]>.<ext>
(tile_keys.versioned_key), records those names in its summary, and its
register step points the catalog at exactly those keys.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_versioned_keys.py -q
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pipeline  # noqa: E402

R2 = 'https://r2.example'
WBC1 = {'points': {'india': 1, 'outside': 0, 'zero': 0, 'null': 0, 'invalid': 0}, 'text_coords': 0, 'states': 1,
        'missing': [], 'partial': {}, 'fetched_at': '2026-11-15T00:00:00+00:00'}
# module -> summary fields its register step reads besides rows/sizes/names
BAKES = {
    'bake_mgnrega_districts': {'unmatched': []},
    'bake_state_finance': {'unmatched': []},
    'bake_cityfinance_ulbs': {},
    'bake_cityfinance_balance_sheet': {},
    'bake_mi6_wells': {'wells': 1},
    'bake_wbc1_water_bodies': WBC1,
    'bake_chennai_property_tax': {},
    'bake_ir_stations_merged': {},
}


def local_files(m, out_dir: Path) -> dict[str, Path]:
    paths = {fmt: out_dir / name for fmt, name in pipeline.plain_names(m.BASENAME, m.EXT).items()}
    for fmt, p in paths.items():
        p.write_bytes(f'{m.LAYER_ID} {fmt}'.encode())
    return paths


@pytest.mark.parametrize('name', BAKES)
def test_upload_puts_each_file_under_its_content_key(name, tmp_path, monkeypatch):
    m = importlib.import_module(name)
    paths = local_files(m, tmp_path)
    keys = []
    put = lambda s3, local, key, *a, **kw: keys.append(key)  # noqa: E731
    monkeypatch.setattr(pipeline, 'r2_client', lambda **kw: 'S3')
    monkeypatch.setattr(pipeline, 'r2_upload', put)
    monkeypatch.setattr(pipeline, 'r2_upload_resumable', put)
    m.upload(tmp_path)
    want = {f'{m.R2_PREFIX}/{n}' for n in pipeline.versioned_names(paths).values()}
    assert set(keys) == want and len(keys) == len(m.EXT)
    keys.clear()
    m.upload(tmp_path)  # same bytes, same keys: nothing new on R2
    assert set(keys) == want


@pytest.mark.parametrize('name', BAKES)
def test_register_points_the_catalog_at_the_uploaded_keys(name, tmp_path):
    m = importlib.import_module(name)
    names = pipeline.versioned_names(local_files(m, tmp_path))
    cat, man, summ = tmp_path / 'c.json', tmp_path / 'm.json', tmp_path / 's.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': [], 'attribution': {},
                               'categories': {'other': 'Other'}}))
    man.write_text('[]')
    summ.write_text(json.dumps({'rows': 9, 'sizes': {f: 2 for f in m.EXT}, 'names': names, **BAKES[name]}))
    kw = {'fetched_at': '2026-11-17'} if name == 'bake_ir_stations_merged' else {}
    m.register(cat, man, summ, r2_public=R2, **kw)
    layer = next(x for x in json.loads(cat.read_text())['layers'] if x['id'] == m.LAYER_ID)
    for fmt in m.EXT:
        assert layer[fmt]['url'] == f'{R2}/{m.R2_PREFIX}/{names[fmt]}'
    row = next(x for x in json.loads(man.read_text()) if x['id'] == m.LAYER_ID)
    assert (row['parquet_file'], row['pmtiles_file']) == (names['parquet'], names['pmtiles'])
