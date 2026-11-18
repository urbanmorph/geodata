"""Rebaked map tiles survive a catalog rebuild or a re-ingest.

rebake_tiles.py (<stem>.<md5[:8]>.pmtiles) and rebake_locate_tiles.py
(<stem>.z12.pmtiles) publish tiles under new keys and the old keys are deleted
after deploy. build_catalog.py and ingest_ramseraph.py template the tile URL
from the upstream file name, so without this rule a rerun would point a layer
back at a deleted file (and the ingest would re-upload the heavy upstream
tiles).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_tile_keys.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import tile_keys  # noqa: E402

R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'


def test_is_rebaked_recognises_both_rebake_key_shapes():
    assert tile_keys.is_rebaked({'url': f'{R2}/admin/villages/LGD_Villages.c08c0de4.pmtiles'})
    assert tile_keys.is_rebaked({'url': f'{R2}/admin/states/LGD_States.z12.pmtiles'})
    assert not tile_keys.is_rebaked({'url': f'{R2}/admin/villages/LGD_Villages.pmtiles'})
    assert not tile_keys.is_rebaked({'url': f'{R2}/x/Some.Name.pmtiles'})
    assert not tile_keys.is_rebaked(None)
    assert not tile_keys.is_rebaked({})


def test_rebake_scripts_produce_keys_the_rule_recognises():
    import rebake_tiles
    import rebake_locate_tiles
    layer = {'pmtiles': {'url': f'{R2}/environment/fsi-beats/FSI_Beats.pmtiles'}}
    key = rebake_tiles.versioned_key(layer, '8357dbd8' + '0' * 24)
    assert tile_keys.is_rebaked({'url': f'{R2}/{key}'})
    z = rebake_locate_tiles.versioned_key(f'{R2}/admin/states/LGD_States.pmtiles')
    assert tile_keys.is_rebaked({'url': f'{R2}/{z}'})


def test_keep_rebaked_pmtiles_prefers_the_previous_rebaked_block():
    prev = {'pmtiles': {'url': f'{R2}/a/X.c08c0de4.pmtiles', 'bytes': 5}}
    layer = {'pmtiles': {'url': f'{R2}/a/X.pmtiles', 'upstream_url': 'u', 'bytes': 9}}
    assert tile_keys.keep_rebaked_pmtiles(layer, prev) is True
    assert layer['pmtiles'] == prev['pmtiles']


def test_keep_rebaked_pmtiles_leaves_plain_tiles_alone():
    prev = {'pmtiles': {'url': f'{R2}/a/X.pmtiles', 'bytes': 5}}
    layer = {'pmtiles': {'url': f'{R2}/a/X.pmtiles', 'bytes': 9}}
    assert tile_keys.keep_rebaked_pmtiles(layer, prev) is False
    assert layer['pmtiles']['bytes'] == 9
    assert tile_keys.keep_rebaked_pmtiles(layer, None) is False


def test_build_catalog_carry_forward_keeps_rebaked_tiles():
    import build_catalog
    prev = {'id': 'lgd_villages', 'pmtiles': {'url': f'{R2}/admin/villages/LGD_Villages.c08c0de4.pmtiles', 'bytes': 176147477}}
    layer = {'id': 'lgd_villages', 'pmtiles': {'url': f'{R2}/admin/villages/LGD_Villages.pmtiles', 'bytes': None}}
    build_catalog.carry_forward_from_prev(layer, {'lgd_villages': prev})
    assert layer['pmtiles']['url'].endswith('LGD_Villages.c08c0de4.pmtiles')
    assert layer['pmtiles']['bytes'] == 176147477


def test_ingest_merge_keeps_rebaked_tiles():
    from ingest_ramseraph import merge_layer_into_catalog
    from test_catalog_idempotent import _ds
    rebaked = {'url': f'{R2}/environment/test-layer/Test.0123abcd.pmtiles', 'bytes': 7}
    c = {'layers': [{'id': 'test_layer', 'pmtiles': dict(rebaked)}]}
    merge_layer_into_catalog(c, _ds(), 100, 200, 50)
    assert c['layers'][0]['pmtiles'] == rebaked


def test_ingest_skips_upstream_tiles_when_the_catalog_has_rebaked_ones(monkeypatch):
    import ingest_ramseraph as ir
    from test_catalog_idempotent import _ds
    d = _ds()
    monkeypatch.setattr(ir, 'current_catalog_layer', lambda layer_id: {'pmtiles': {'url': f'{R2}/x/Test.0123abcd.pmtiles'}})
    assert ir.wants_upstream_pmtiles(d) is False
    monkeypatch.setattr(ir, 'current_catalog_layer', lambda layer_id: {'pmtiles': {'url': f'{R2}/x/Test.pmtiles'}})
    assert ir.wants_upstream_pmtiles(d) is True
    monkeypatch.setattr(ir, 'current_catalog_layer', lambda layer_id: None)
    assert ir.wants_upstream_pmtiles(d) is True
    assert ir.wants_upstream_pmtiles(_ds({'pmtiles_url': ''})) is False
