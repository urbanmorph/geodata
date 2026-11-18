"""Tests for scripts/rebake_tiles.py (the pure parts: fields, args, keys,
catalog patch, lock, checks)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rebake_tiles as rt  # noqa: E402

R2 = rt.R2_PUBLIC


def test_gis_artefact_columns_come_from_the_ts_set():
    cols = rt.gis_artefact_columns()
    assert {'shape_leng', 'shape_area', 'st_area(shape)', 'ogc_fid'} <= cols
    assert 'objectid' not in cols  # locate keeps ids


def test_popup_fields_generic_rule_drops_artefacts_bbox_and_nested():
    schema = [('name', 'VARCHAR'), ('Shape_Area', 'DOUBLE'), ('OBJECTID', 'INTEGER'),
              ('names', 'STRUCT(primary VARCHAR)'), ('tags', 'VARCHAR[]'), ('geometry', 'GEOMETRY'),
              ('xmin', 'DOUBLE'), ('bbox', 'STRUCT(xmin DOUBLE)'), ('code', 'BIGINT')]
    assert rt.popup_fields('any', schema, {'shape_area'}) == ['name', 'OBJECTID', 'code']


def test_popup_fields_never_widen_the_live_tiles():
    schema = [('name', 'VARCHAR'), ('code', 'VARCHAR'), ('Shape_Area', 'DOUBLE'), ('extra', 'VARCHAR')]
    live = ['code', 'name', 'Shape_Area']
    assert rt.popup_fields('any', schema, {'shape_area'}, live) == ['name', 'code']
    with pytest.raises(ValueError):
        rt.popup_fields('any', schema, set(), ['NAME'])


def test_popup_fields_override_and_missing_column():
    schema = [(c, 'VARCHAR') for c in ('Circle_Nam', 'ST_Name', 'OBJECTID')]
    assert rt.popup_fields('fsi_circles', schema, set()) == ['Circle_Nam', 'ST_Name']
    with pytest.raises(ValueError):
        rt.popup_fields('fsi_divisions', schema, set())


def test_tippecanoe_args_polygons_coalesce_with_budget_and_shared_borders():
    args = rt.tippecanoe_args(Path('a.geojsonl'), Path('a.pmtiles'), 'lyr', ['name'], 'polygon', 11)
    assert '--coalesce-densest-as-needed' in args and '--drop-densest-as-needed' not in args
    assert f'--maximum-tile-bytes={rt.MAX_TILE_BYTES}' in args
    assert f'--low-detail={rt.LOW_DETAIL}' in args
    assert '--smallest-maximum-zoom-guess=11' in args
    assert '--detect-shared-borders' in args
    assert args[args.index('-y') + 1] == 'name'
    assert args[-1] == 'a.geojsonl'


@pytest.mark.parametrize('kind', ['point', 'line'])
def test_tippecanoe_args_points_and_lines_thin(kind):
    args = rt.tippecanoe_args(Path('a.geojsonl'), Path('a.pmtiles'), 'lyr', ['n'], kind, 10)
    assert '--drop-densest-as-needed' in args and '--coalesce-densest-as-needed' not in args
    assert ('-r1' in args) == (kind == 'point')


def test_tippecanoe_args_no_fields_means_no_attributes():
    args = rt.tippecanoe_args(Path('a.geojsonl'), Path('a.pmtiles'), 'lyr', [], 'point', 10)
    assert '--detect-shared-borders' not in args
    assert '-X' in args and '-y' not in args


def test_check_zooms():
    assert rt.check_zooms(11) == [3, 5, 8, 11]
    assert rt.check_zooms(4) == [3, 4]


def test_versioned_key_next_to_the_old_tiles_and_replaces_a_previous_version():
    layer = {'pmtiles': {'url': f'{R2}/environment/fsi-beats/FSI_Beats.pmtiles'}}
    assert rt.versioned_key(layer, 'abcdef0123456789') == 'environment/fsi-beats/FSI_Beats.abcdef01.pmtiles'
    layer = {'pmtiles': {'url': f'{R2}/environment/fsi-beats/FSI_Beats.abcdef01.pmtiles'}}
    assert rt.versioned_key(layer, '1234567890') == 'environment/fsi-beats/FSI_Beats.12345678.pmtiles'


def test_versioned_key_next_to_the_source_when_there_were_no_tiles():
    layer = {'id': 'gb_adm1', 'pmtiles': None, 'parquet': None,
             'geojson': {'url': f'{R2}/geoboundaries/IND_ADM1.geojson'}}
    assert rt.versioned_key(layer, 'ffffffff00') == 'geoboundaries/IND_ADM1.ffffffff.pmtiles'


def test_patched_layer_points_at_new_tiles_and_notes_once():
    layer = {'id': 'x', 'notes': 'From FSI.', 'pmtiles': {'url': 'old', 'upstream_url': 'up', 'bytes': 1}}
    out = rt.patched_layer(layer, 'k/x.12345678.pmtiles', 99, narrowed=True)
    assert out['pmtiles'] == {'url': f'{R2}/k/x.12345678.pmtiles', 'bytes': 99}
    assert out['notes'] == f'From FSI. {rt.NOTE}'
    assert rt.patched_layer(out, 'k/x.12345678.pmtiles', 99, narrowed=True) == out
    assert rt.patched_layer(layer, 'k', 1, narrowed=False)['notes'] == 'From FSI.'
    assert rt.with_note('name-only') == f'name-only. {rt.NOTE}'


def test_patch_catalog_and_manifest_in_place_idempotent(tmp_path):
    cat = tmp_path / 'catalog.json'
    man = tmp_path / 'manifest.json'
    layers = [{'id': 'a', 'pmtiles': None}, {'id': 'b', 'pmtiles': None}]
    cat.write_text(json.dumps({'layers': layers}, indent=2) + '\n')
    man.write_text(json.dumps([{'id': 'a', 'r2_prefix': 'env/a', 'pmtiles_file': 'A.pmtiles', 'pmtiles_bytes': 5}],
                              indent=2) + '\n')
    rt.patch_catalog('a', 'env/a/A.0badf00d.pmtiles', 7, False, cat, man)
    first = (cat.read_text(), man.read_text())
    rt.patch_catalog('a', 'env/a/A.0badf00d.pmtiles', 7, False, cat, man)
    assert (cat.read_text(), man.read_text()) == first
    layers = json.loads(first[0])['layers']
    assert layers[0]['pmtiles'] == {'url': f'{R2}/env/a/A.0badf00d.pmtiles', 'bytes': 7}
    assert layers[1] == {'id': 'b', 'pmtiles': None}
    assert json.loads(first[1])[0]['pmtiles_file'] == 'A.0badf00d.pmtiles'


def test_upload_lock_is_exclusive_and_released_on_error(tmp_path):
    lock = tmp_path / 'lock'
    with pytest.raises(RuntimeError), rt.upload_lock(lock, 'me'):
        assert (lock / 'owner').read_text() == 'me\n'
        raise RuntimeError('upload failed')
    assert not lock.exists()


def test_report_problems():
    rows = [{'z': 11, 'x': 1, 'y': 1, 'decoded': 9, 'parquet': 10, 'cover': 1.0},
            {'z': 5, 'x': 1, 'y': 1, 'decoded': 3, 'parquet': 900, 'cover': 0.5},
            {'z': 3, 'x': 1, 'y': 1, 'decoded': 3, 'parquet': 900, 'cover': 1.01}]
    rows.append({'z': 8, 'x': 1, 'y': 1, 'decoded': 3, 'parquet': 9, 'cover': 0.94})  # dust: within the band
    problems = rt.report_problems(rows, 11, 'polygon')
    assert len(problems) == 2
    assert 'decoded' in problems[0] and 'cover 50%' in problems[1]
    assert rt.report_problems(rows[2:], 11, 'polygon') == []


def test_geometry_column_by_type_not_name():
    assert rt.geometry_column([('id', 'VARCHAR'), ('geom', 'GEOMETRY')]) == 'geom'
