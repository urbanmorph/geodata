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


def test_tippecanoe_args_full_detail_leaves_tippecanoes_default():
    args = rt.tippecanoe_args(Path('a.geojsonl'), Path('a.pmtiles'), 'lyr', ['n'], 'polygon', 10, low_detail=None)
    assert not any(a.startswith('--low-detail') for a in args)
    assert f'--maximum-tile-bytes={rt.MAX_TILE_BYTES}' in args
    args = rt.tippecanoe_args(Path('a.geojsonl'), Path('a.pmtiles'), 'lyr', ['n'], 'line', 10,
                              low_detail=None, max_tile_bytes=None)
    assert not any(a.startswith(('--low-detail', '--maximum-tile-bytes')) for a in args)


def test_tile_tries_smaller_tiles_first_then_tippecanoes_defaults():
    # Fine parcels in a small area turn to dust at country zoom with the lower
    # detail; dense lines keep less length in the smaller budget. Each later try
    # gives back one of tippecanoe's defaults.
    assert rt.TILE_TRIES == ((rt.LOW_DETAIL, rt.MAX_TILE_BYTES, ''), (None, rt.MAX_TILE_BYTES, '.full-detail'),
                             (None, None, '.default-budget'))


def test_worse_than_the_live_tiles_per_shared_probe_tile():
    def row(z, x, decoded, cover):
        return {'z': z, 'x': x, 'y': 0, 'decoded': decoded, 'parquet': 10, 'cover': cover}
    live = [row(3, 1, 300, 0.997), row(5, 1, 900, 0.999), row(8, 1, 50, 1.0), row(12, 1, 9, 1.0)]
    # Polygons: further from the parquet's area than the live tiles were (beyond 1 point).
    new = [row(3, 1, 18, 0.951), row(5, 1, 40, 0.995), row(8, 1, 50, 1.0), row(13, 1, 9, 1.0)]
    assert rt.worse_than(live, new, 'polygon') == ["z3/1/0: polygons cover 95% of the parquet's area (live tiles 100%)"]
    # Lines: shorter by more than 5 points; points: under 90% of the live count.
    assert rt.worse_than([row(5, 1, 100, 0.8)], [row(5, 1, 50, 0.7)], 'line') == \
        ["z5/1/0: lines keep 70% of the parquet's length (live tiles 80%)"]
    assert rt.worse_than([row(5, 1, 100, None)], [row(5, 1, 89, None)], 'point') == \
        ['z5/1/0: 89 points decoded (live tiles 100)']
    assert rt.worse_than([row(5, 1, 100, None)], [row(5, 1, 95, None)], 'point') == []
    assert rt.worse_than(None, new, 'polygon') == []  # no live tiles: nothing to compare


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


def test_filter_stats_baked_first_else_probed_once_and_cached(tmp_path):
    import duckdb
    src = tmp_path / 'source.parquet'
    con = duckdb.connect()
    con.execute(f"COPY (SELECT range AS fid, chr(65 + range::INT % 4) AS corporation FROM range(40)) TO '{src}'")
    layer = {'id': 'wards_x', 'parquet': {'url': 'https://r2/wards_x.parquet', 'bytes': 1000}}
    baked = {'row_count': 1, 'columns': []}
    assert rt.filter_stats(layer, {'filter_stats': {'wards_x': baked}}, src, con, tmp_path / 'fs.json') is baked
    probed = rt.filter_stats(layer, {}, src, con, tmp_path / 'fs.json')
    assert rt.tile_filter_columns(probed) == ['corporation']
    src.unlink()  # the second run reads the cache, not the parquet
    assert rt.filter_stats(layer, {}, src, con, tmp_path / 'fs.json') == probed
    # No parquet, no Filter panel: nothing to add.
    assert rt.filter_stats({'id': 'g', 'geojson': {'url': 'x'}}, {}, src, con, tmp_path / 'g.json') is None


def test_probes_are_picked_once_so_live_and_new_tiles_meet_the_same_tiles(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(rt, 'probe_points', lambda con, parquet: calls.append(1) or [(77.5, 12.9), (88.3, 22.5)])
    first = rt.probes(None, tmp_path / 'p.parquet', tmp_path / 'probes.json')
    assert first == [(77.5, 12.9), (88.3, 22.5)]
    assert rt.probes(None, tmp_path / 'p.parquet', tmp_path / 'probes.json') == first
    assert len(calls) == 1


def test_geometry_column_by_type_not_name():
    assert rt.geometry_column([('id', 'VARCHAR'), ('geom', 'GEOMETRY')]) == 'geom'


# A source polygon whose MakeValid throws in GEOS ("Overlay input is mixed-
# dimension"): land degradation 2015-16 row TS.28062 carries a ring of four
# identical points beside its real ring. The check must still measure it.
DEGENERATE_RING = (
    'MULTIPOLYGON (((77.6146832 17.4472724, 77.6146832 17.4472724, 77.6146832 17.4472724, 77.6146832 17.4472724)), '
    '((77.6069205 17.4460576, 77.6085345 17.4461351, 77.6146831 17.4472723, 77.6141494 17.446572, '
    '77.6132726 17.4455628, 77.6110442 17.4451136, 77.6094739 17.445199, 77.6076526 17.4452247, '
    '77.6069205 17.4460576)))')


def _measure(kind, wkt, env='ST_MakeEnvelope(77, 17, 78, 18)'):
    import duckdb
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial')
    return con.execute(f"SELECT {rt.amount_sql(kind, 'geometry', env)} FROM "
                       f"(SELECT ST_GeomFromText('{wkt}') AS geometry)").fetchone()[0]


def test_amount_measures_a_polygon_that_make_valid_rejects():
    area = _measure('polygon', DEGENERATE_RING)
    assert area == pytest.approx(8.4288e-06, rel=1e-3)  # the real ring's area


def test_amount_unchanged_for_valid_shapes_and_by_kind():
    square = 'POLYGON((77 17, 77.5 17, 77.5 17.5, 77 17.5, 77 17))'
    assert _measure('polygon', square) == pytest.approx(0.25)
    assert _measure('polygon', square, 'ST_MakeEnvelope(77, 17, 77.25, 17.5)') == pytest.approx(0.125)
    assert _measure('line', 'LINESTRING(77 17, 77.5 17)') == pytest.approx(0.5)
    # a collection mixing a polygon and a line measures only the polygon (area) or line (length)
    mixed = 'GEOMETRYCOLLECTION(POLYGON((77 17, 77.5 17, 77.5 17.5, 77 17.5, 77 17)), LINESTRING(77.6 17.6, 77.9 17.6))'
    assert _measure('polygon', mixed) == pytest.approx(0.25)
    assert _measure('line', mixed) == pytest.approx(0.3)
    assert rt.amount_sql('point', 'geometry', 'e') == '0'
