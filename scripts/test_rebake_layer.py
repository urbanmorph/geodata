"""Tests for the generic catalog-layer rebake helpers.

Pure helpers only — the actual rebake + R2 upload is exercised end-to-end
when the script runs; here we cover the URL parsing and catalog-patch
logic that's easy to get wrong silently.

Run: python3 -m pytest scripts/test_rebake_layer.py -v"""

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))


def test_r2_key_from_url_strips_public_host() -> None:
    from rebake_layer import r2_key_from_url
    assert r2_key_from_url(
        'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/water/wetlands/x.parquet'
    ) == 'water/wetlands/x.parquet'


def test_r2_key_from_url_handles_nested_paths() -> None:
    from rebake_layer import r2_key_from_url, R2_PUBLIC
    assert r2_key_from_url(
        f'{R2_PUBLIC}/a/b/c/d/file.parquet'
    ) == 'a/b/c/d/file.parquet'


def test_r2_key_from_url_rejects_non_r2_url() -> None:
    from rebake_layer import r2_key_from_url
    with pytest.raises(ValueError):
        r2_key_from_url('https://github.com/foo/bar/release/file.parquet')


def test_patch_catalog_bytes_updates_named_layer(tmp_path: Path) -> None:
    from rebake_layer import patch_catalog_bytes
    catalog_path = tmp_path / 'catalog.json'
    catalog_path.write_text(json.dumps({
        'layers': [
            {'id': 'a', 'parquet': {'url': 'x', 'bytes': 100}},
            {'id': 'b', 'parquet': {'url': 'y', 'bytes': 200}},
        ],
    }))
    patch_catalog_bytes(catalog_path, 'b', 999)
    out = json.loads(catalog_path.read_text())
    assert out['layers'][0]['parquet']['bytes'] == 100
    assert out['layers'][1]['parquet']['bytes'] == 999


def test_patch_catalog_bytes_raises_on_missing_layer(tmp_path: Path) -> None:
    from rebake_layer import patch_catalog_bytes
    catalog_path = tmp_path / 'catalog.json'
    catalog_path.write_text(json.dumps({'layers': []}))
    with pytest.raises(KeyError):
        patch_catalog_bytes(catalog_path, 'nope', 1)


def test_find_layer_returns_match() -> None:
    from rebake_layer import find_layer
    cat = {'layers': [{'id': 'lgd_states'}, {'id': 'bp_wetlands'}]}
    assert find_layer(cat, 'bp_wetlands')['id'] == 'bp_wetlands'


def test_find_layer_raises_on_unknown() -> None:
    from rebake_layer import find_layer
    cat = {'layers': [{'id': 'a'}]}
    with pytest.raises(KeyError):
        find_layer(cat, 'b')
