"""bake_point_index: the merged point index (web/functions/lib/point-index.ts reads it)."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

import bake_point_index as bpi


def layer(lid: str, licence: str = 'CC0-1.0', bytes_: int = 10) -> dict:
    return {'id': lid, 'licence': licence,
            'parquet': {'url': f'https://data.bharatlas.com/x/{lid}.parquet', 'bytes': bytes_},
            'pmtiles': {'url': f'https://data.bharatlas.com/x/{lid}.pmtiles', 'bytes': 5}}


@pytest.mark.parametrize('licence', ['ODbL-1.0', 'CC-BY-SA-2.5-IN', 'CC-BY-SA-4.0', 'odbl',
                                     'Creative Commons Attribution-ShareAlike 4.0'])
def test_share_alike_licences(licence):
    assert bpi.share_alike(licence)


@pytest.mark.parametrize('licence', ['CC0-1.0', 'CC-BY-4.0', 'GODL-India', 'MIT', 'CC0-1.0 / CC-BY-4.0', None, ''])
def test_open_licences_are_not_share_alike(licence):
    assert not bpi.share_alike(licence)


def test_plan_keeps_share_alike_layers_out_of_every_archive():
    archives = {'place': {'layers': ['a', 'sa_wards', 'b'], 'props': 'tiles'},
                'zones': {'layers': ['z'], 'props': 'sidecar'}}
    catalog = {'layers': [layer('a'), layer('b'), layer('z'), layer('sa_wards', 'ODbL-1.0')]}
    plan = bpi.plan(catalog, archives)
    assert {name: [lyr['id'] for lyr in rows] for name, rows in plan.items()} == {'place': ['a', 'b'], 'zones': ['z']}


def test_plan_skips_layers_without_parquet_or_tiles_and_unknown_ids():
    no_tiles = {**layer('c'), 'pmtiles': None}
    plan = bpi.plan({'layers': [layer('a'), no_tiles]}, {'place': {'layers': ['a', 'c', 'gone'], 'props': 'tiles'}})
    assert [lyr['id'] for lyr in plan['place']] == ['a']


def test_the_real_plan_has_no_share_alike_layer():
    catalog = json.loads(bpi.CATALOG.read_text())
    licences = {lyr['id']: lyr.get('licence') for lyr in catalog['layers']}
    for rows in bpi.plan(catalog).values():
        assert not [lyr['id'] for lyr in rows if bpi.share_alike(licences[lyr['id']])]


def test_sidecar_drops_nulls_and_artefacts_and_indexes_by_row():
    lines = [
        {'type': 'Feature', 'properties': {'f': 3, 'name': 'c', 'Shape_Area': 9.5, 'note': None}, 'geometry': None},
        {'type': 'Feature', 'properties': {'f': 1, 'name': 'a', 'n': 2.0, 'tags': ['x', 'y']}, 'geometry': None},
    ]
    props = bpi.sidecar_props((json.dumps(x) for x in lines), {'shape_area'})
    # f is the row number + 1 (tippecanoe cannot store a feature id of 0); row 1 has no polygon
    assert props == [{'name': 'a', 'n': 2.0, 'tags': '["x","y"]'}, None, {'name': 'c'}]


def test_tippecanoe_command_names_each_layer_and_keeps_only_ids_for_a_sidecar_archive(tmp_path):
    inputs = [('a', tmp_path / 'a.geojsonl'), ('b', tmp_path / 'b.geojsonl')]
    with_props = bpi.tippecanoe_cmd(tmp_path / 'o.pmtiles', inputs, ids_only=False)
    ids_only = bpi.tippecanoe_cmd(tmp_path / 'o.pmtiles', inputs, ids_only=True)
    assert f'-z{bpi.ZOOM}' in with_props and f'-Z{bpi.ZOOM}' in with_props
    assert '--use-attribute-for-id=f' in with_props
    assert ['-L', f'a:{tmp_path / "a.geojsonl"}'] == with_props[with_props.index('-L'):with_props.index('-L') + 2]
    assert '-y' not in with_props
    assert ids_only[ids_only.index('-y') + 1] == 'f'


def test_build_key_moves_with_any_input():
    base = [('a', 'etag1', ['x', 'y'])]
    k = bpi.build_key(base, ids_only=False)
    assert bpi.build_key(base, ids_only=False) == k
    assert bpi.build_key([('a', 'etag2', ['x', 'y'])], ids_only=False) != k
    assert bpi.build_key([('a', 'etag1', ['x'])], ids_only=False) != k
    assert bpi.build_key(base, ids_only=True) != k


def test_manifest_records_each_layers_sources():
    lyr = layer('z')
    m = bpi.manifest(
        {'zones': {'url': 'https://data.bharatlas.com/point-index/zones.abcd1234.pmtiles', 'bytes': 99}},
        [('zones', lyr, 'etag-z', {'url': 'https://data.bharatlas.com/point-index/props/z.1234abcd.json', 'bytes': 7})],
    )
    assert m == {
        'zoom': bpi.ZOOM,
        'archives': {'zones': {'url': 'https://data.bharatlas.com/point-index/zones.abcd1234.pmtiles', 'bytes': 99}},
        'layers': {'z': {
            'archive': 'zones', 'parquet': lyr['parquet'], 'etag': 'etag-z', 'pmtiles': lyr['pmtiles']['url'],
            'props': {'url': 'https://data.bharatlas.com/point-index/props/z.1234abcd.json', 'bytes': 7},
        }},
    }


@pytest.mark.skipif(not shutil.which('tippecanoe'), reason='needs tippecanoe')
def test_tile_ids_are_row_numbers_plus_one_and_carry_no_f(tmp_path):
    # Row 0's id would be 0, which tippecanoe keeps as an "f" property instead; +1 avoids it.
    src = tmp_path / 'a.geojsonl'
    square = {'type': 'Polygon', 'coordinates': [[[77.5, 12.9], [77.6, 12.9], [77.6, 13.0], [77.5, 13.0], [77.5, 12.9]]]}
    src.write_text(json.dumps({'type': 'Feature', 'properties': {'f': 1, 'name': 'zero'}, 'geometry': square}) + '\n')
    out = tmp_path / 'o.pmtiles'
    subprocess.run(bpi.tippecanoe_cmd(out, [('a', src)], ids_only=False), check=True, capture_output=True)
    decoded = json.loads(subprocess.run(['tippecanoe-decode', str(out)], check=True, capture_output=True).stdout)
    feats = [f for t in decoded['features'] for lyr in t['features'] for f in lyr['features']]
    assert feats and all(f['id'] == 1 and f['properties'] == {'name': 'zero'} for f in feats)


def test_manifest_path_is_under_api_data():
    assert bpi.MANIFEST == Path(bpi.ROOT) / 'web' / 'public' / 'api-data' / 'point-index.json'


def test_every_city_ward_layer_is_planned_from_the_generated_ward_list():
    # a new city's wards (scripts/gen-ward-bboxes.mjs) join the index without editing this script
    wards = bpi.ward_layers()
    assert {'wards_ahmedabad', 'wards_mumbai', 'wards_vizag'} <= set(wards)
    assert all(w.startswith('wards_') for w in wards)
    assert {'sbm_wards', 'wb_amrut_wards'} <= set(bpi.ARCHIVES['place']['layers'])
    assert set(wards) <= set(bpi.ARCHIVES['place']['layers'])


def test_the_default_locate_layers_are_all_planned():
    # web/functions/lib/locate-layers.ts DEFAULT_LOCATE_LAYERS: a default lookup reads only the index
    import re
    ts = (bpi.ROOT / 'web' / 'functions' / 'lib' / 'locate-layers.ts').read_text()
    body = ts[ts.index('DEFAULT_LOCATE_LAYERS'):]
    defaults = set(re.findall(r"'([a-z0-9_]+)'", body[:body.index('] as const')]))
    planned = {lid for spec in bpi.ARCHIVES.values() for lid in spec['layers']}
    assert {'bharatviz_pincodes', 'soi_forests', 'high_courts'} <= defaults
    assert sorted(defaults - planned) == []


def test_the_manifest_holds_every_layer_the_bake_plans_and_no_other():
    # Fails after a layer refresh or a new planned layer until the bake runs again:
    #   python3 -u scripts/bake_point_index.py   (then commit web/public/api-data/point-index.json)
    catalog = json.loads(bpi.CATALOG.read_text())
    planned = {lyr['id'] for rows in bpi.plan(catalog).values() for lyr in rows}
    indexed = set(json.loads(bpi.MANIFEST.read_text())['layers'])
    assert sorted(planned - indexed) == [], 'planned but not in the index: re-run scripts/bake_point_index.py'
    assert sorted(indexed - planned) == [], 'in the index but no longer planned: re-run scripts/bake_point_index.py'


def test_refresh_note_names_the_bake_for_an_indexed_layer_only(tmp_path):
    m = tmp_path / 'point-index.json'
    m.write_text(json.dumps({'zoom': 12, 'archives': {}, 'layers': {'lgd_states': {}}}))
    assert 'bake_point_index.py' in bpi.refresh_note('lgd_states', m)
    assert bpi.refresh_note('wris_dams', m) is None
    assert bpi.refresh_note('lgd_states', tmp_path / 'missing.json') is None
