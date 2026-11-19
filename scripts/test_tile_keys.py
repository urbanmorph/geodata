"""Rebaked map tiles survive a catalog rebuild or a re-ingest.

rebake_tiles.py (<stem>.<md5[:8]>.pmtiles) and oneoff/rebake_locate_tiles.py
(<stem>.z12.pmtiles, earlier) publish tiles under new keys (the old keys stay; only
r2_prune.py prunes old tiles). build_catalog.py, ingest_ramseraph.py and the
bakes' register steps template the tile URL from their own files, so without
this rule a rerun would point a layer back at tiles without the rebake's
fixes (and the ingest would re-upload the heavy upstream tiles).

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
    layer = {'pmtiles': {'url': f'{R2}/environment/fsi-beats/FSI_Beats.pmtiles'}}
    key = rebake_tiles.versioned_key(layer, '8357dbd8' + '0' * 24)
    assert tile_keys.is_rebaked({'url': f'{R2}/{key}'})
    import rebake_layer
    pq = rebake_layer.versioned_key('admin/states/LGD_States.parquet', '0a1b2c3d' + '0' * 24)
    assert tile_keys.is_rebaked({'url': f'{R2}/{pq}'}, 'parquet')


def test_rebake_tiles_names_new_tiles_after_a_rebaked_parquet_without_doubling_the_suffix():
    import rebake_tiles
    layer = {'parquet': {'url': f'{R2}/admin/wards-x/wards_x.0a1b2c3d.parquet'}}
    assert rebake_tiles.versioned_key(layer, 'ffffffff' + '0' * 24) == 'admin/wards-x/wards_x.ffffffff.pmtiles'


def test_is_rebaked_parquet_recognises_the_md5_key_only():
    assert tile_keys.is_rebaked({'url': f'{R2}/admin/states/LGD_States.0a1b2c3d.parquet'}, 'parquet')
    assert not tile_keys.is_rebaked({'url': f'{R2}/admin/states/LGD_States.parquet'}, 'parquet')
    assert not tile_keys.is_rebaked({'url': f'{R2}/admin/states/LGD_States.z12.parquet'}, 'parquet')
    # a key of one format never counts for the other
    assert not tile_keys.is_rebaked({'url': f'{R2}/a/X.0a1b2c3d.parquet'}, 'pmtiles')
    assert not tile_keys.is_rebaked({'url': f'{R2}/a/X.0a1b2c3d.pmtiles'}, 'parquet')


def test_keep_rebaked_prefers_the_previous_rebaked_block():
    for fmt in tile_keys.FORMATS:
        prev = {fmt: {'url': f'{R2}/a/X.c08c0de4.{fmt}', 'bytes': 5}}
        layer = {fmt: {'url': f'{R2}/a/X.{fmt}', 'upstream_url': 'u', 'bytes': 9}}
        assert tile_keys.keep_rebaked(layer, prev, fmt) is True
        assert layer[fmt] == prev[fmt]


def test_keep_rebaked_leaves_plain_blocks_alone():
    for fmt in tile_keys.FORMATS:
        prev = {fmt: {'url': f'{R2}/a/X.{fmt}', 'bytes': 5}}
        layer = {fmt: {'url': f'{R2}/a/X.{fmt}', 'bytes': 9}}
        assert tile_keys.keep_rebaked(layer, prev, fmt) is False
        assert layer[fmt]['bytes'] == 9
        assert tile_keys.keep_rebaked(layer, None, fmt) is False


def test_keep_all_rebaked_keeps_each_format_on_its_own():
    prev = {'parquet': {'url': f'{R2}/a/X.0a1b2c3d.parquet', 'bytes': 1},
            'pmtiles': {'url': f'{R2}/a/X.pmtiles', 'bytes': 2}}
    layer = {'parquet': {'url': f'{R2}/a/X.parquet', 'bytes': 3},
             'pmtiles': {'url': f'{R2}/a/X.pmtiles', 'bytes': 4}}
    assert tile_keys.keep_all_rebaked(layer, prev) == ['parquet']
    assert layer['parquet'] == prev['parquet']
    assert layer['pmtiles']['bytes'] == 4


def test_unversioned_name_strips_the_rebake_suffix():
    assert tile_keys.unversioned_name(f'{R2}/admin/states/LGD_States.0a1b2c3d.parquet') == 'LGD_States.parquet'
    assert tile_keys.unversioned_name(f'{R2}/admin/states/LGD_States.z12.pmtiles') == 'LGD_States.pmtiles'
    assert tile_keys.unversioned_name(f'{R2}/admin/states/LGD_States.parquet') == 'LGD_States.parquet'


def test_find_parquet_finds_the_local_source_of_a_rebaked_parquet(tmp_path, monkeypatch):
    """build_api_indexes / build_ward_index read the local source parquet by
    the catalog file name; a rebaked key must still find it."""
    import pipeline
    src = tmp_path / 'sources' / 'india-geodata'
    src.mkdir(parents=True)
    (src / 'LGD_States.parquet').write_bytes(b'x')
    monkeypatch.setattr(pipeline, 'ROOT', tmp_path)
    layer = {'parquet': {'url': f'{R2}/admin/states/LGD_States.0a1b2c3d.parquet'}}
    assert pipeline.find_parquet(layer) == src / 'LGD_States.parquet'
    baked = tmp_path / 'data' / 'baked' / 'admin' / 'wards-x'
    baked.mkdir(parents=True)
    (baked / 'wards_x.parquet').write_bytes(b'x')
    assert pipeline.find_parquet({'parquet': {'url': f'{R2}/admin/wards-x/wards_x.0a1b2c3d.parquet'}}) == \
        baked / 'wards_x.parquet'


def test_build_catalog_carry_forward_keeps_a_rebaked_parquet():
    import build_catalog
    prev = {'id': 'soi_states', 'parquet': {'url': f'{R2}/admin/states/SOI_States.0a1b2c3d.parquet', 'bytes': 11,
                                            'upstream_url': 'u'}}
    layer = {'id': 'soi_states', 'parquet': {'url': f'{R2}/admin/states/SOI_States.parquet', 'bytes': 10780243}}
    build_catalog.carry_forward_from_prev(layer, {'soi_states': prev})
    assert layer['parquet'] == prev['parquet']


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


def test_ingest_merge_keeps_a_rebaked_parquet():
    from ingest_ramseraph import merge_layer_into_catalog
    from test_catalog_idempotent import _ds
    rebaked = {'url': f'{R2}/environment/test-layer/Test.0123abcd.parquet', 'upstream_url': 'u', 'bytes': 7}
    c = {'layers': [{'id': 'test_layer', 'parquet': dict(rebaked)}]}
    merge_layer_into_catalog(c, _ds(), 100, 200, 50)
    assert c['layers'][0]['parquet'] == rebaked


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


# ── one content-versioned key for every bake ──────────────────────────────────

def test_versioned_key_puts_the_md5_before_the_whole_extension():
    md5 = '0a1b2c3d' + '0' * 24
    assert tile_keys.versioned_key('economy/x/X_2025_26.parquet', md5) == 'economy/x/X_2025_26.0a1b2c3d.parquet'
    assert tile_keys.versioned_key('X_2025_26.shp.zip', md5) == 'X_2025_26.0a1b2c3d.shp.zip'
    assert tile_keys.versioned_key('a/X.geojson', md5) == 'a/X.0a1b2c3d.geojson'
    assert tile_keys.versioned_key('a/X.kml', md5) == 'a/X.0a1b2c3d.kml'
    assert tile_keys.versioned_key('Bhuvan_X.geojson.zip', md5) == 'Bhuvan_X.0a1b2c3d.geojson.zip'


def test_versioned_key_replaces_an_earlier_version_and_can_change_the_extension():
    md5 = 'ffffffff' + '0' * 24
    assert tile_keys.versioned_key('a/X.0a1b2c3d.parquet', md5) == 'a/X.ffffffff.parquet'
    assert tile_keys.versioned_key('a/X.0a1b2c3d.parquet', md5, 'pmtiles') == 'a/X.ffffffff.pmtiles'
    assert tile_keys.versioned_key('2026-09-23.1-r3/o.pmtiles', md5) == '2026-09-23.1-r3/o.ffffffff.pmtiles'


def test_versioned_key_is_stable_for_the_same_content():
    md5 = '12345678' + 'a' * 24
    once = tile_keys.versioned_key('a/X.parquet', md5)
    assert tile_keys.versioned_key(once, md5) == once


def test_keep_rebaked_gives_way_when_the_data_changed():
    """A bake's new parquet (a new content key) makes its own fresh tiles current:
    tiles rebaked from the old data no longer match it."""
    prev = {'parquet': {'url': f'{R2}/a/X.11111111.parquet'}, 'pmtiles': {'url': f'{R2}/a/X.c08c0de4.pmtiles'}}
    layer = {'parquet': {'url': f'{R2}/a/X.22222222.parquet'}, 'pmtiles': {'url': f'{R2}/a/X.33333333.pmtiles'}}
    assert tile_keys.keep_all_rebaked(layer, prev) == []
    assert layer['pmtiles']['url'].endswith('X.33333333.pmtiles')


def test_keep_rebaked_keeps_tiles_when_the_data_is_the_same_or_unknown():
    rebaked = {'url': f'{R2}/a/X.c08c0de4.pmtiles'}
    same = {'parquet': {'url': f'{R2}/a/X.11111111.parquet'}, 'pmtiles': rebaked}
    layer = {'parquet': {'url': f'{R2}/a/X.11111111.parquet'}, 'pmtiles': {'url': f'{R2}/a/X.33333333.pmtiles'}}
    assert tile_keys.keep_all_rebaked(layer, same) == ['pmtiles', 'parquet']
    assert layer['pmtiles'] == rebaked
    # an unversioned (upstream-named or legacy fixed) parquet can't tell: keep, as before
    legacy = {'parquet': {'url': f'{R2}/a/X.parquet'}, 'pmtiles': rebaked}
    layer = {'parquet': {'url': f'{R2}/a/X.22222222.parquet'}, 'pmtiles': {'url': f'{R2}/a/X.33333333.pmtiles'}}
    assert 'pmtiles' in tile_keys.keep_all_rebaked(layer, legacy)
    assert layer['pmtiles'] == rebaked
