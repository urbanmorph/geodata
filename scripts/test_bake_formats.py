"""Tests for scripts/bake_formats.py (shared bake helpers).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_formats.py -q
"""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_formats as f  # noqa: E402


def test_pmtiles_args_keeps_only_named_fields_in_order():
    args = f.pmtiles_args(Path('in.geojson'), Path('out.pmtiles'), 'my_layer', ('a', 'b'))
    assert args == ['tippecanoe', '-o', 'out.pmtiles', '-l', 'my_layer', '-n', 'my_layer', '-zg',
                    '--drop-densest-as-needed', '--extend-zooms-if-still-dropping',
                    '-y', 'a', '-y', 'b', '--force', '--no-progress-indicator', 'in.geojson']


def test_tile_fields_add_the_filter_columns_to_the_popup_fields():
    schema = [('name', 'VARCHAR'), ('corporation', 'VARCHAR'), ('zone', 'VARCHAR'), ('code', 'INTEGER')]
    # Popup order kept; filter columns the popup lacks follow, once; a name not in the source is ignored.
    assert f.tile_fields(['name', 'code'], ['zone', 'code', 'corporation', 'gone'], schema) == \
        ['name', 'code', 'zone', 'corporation']
    assert f.tile_fields([], [], schema) == []


def test_pmtiles_args_parallel_reads_line_delimited_input():
    args = f.pmtiles_args(Path('in.geojsons'), Path('o.pmtiles'), 'l', ('a',), parallel=True)
    assert args[:9] == ['tippecanoe', '-o', 'o.pmtiles', '-l', 'l', '-n', 'l', '-zg', '-P']


def test_zip_with_key_writes_columns_txt_and_every_file(tmp_path):
    src = tmp_path / 'shp'
    src.mkdir()
    (src / 'x.shp').write_bytes(b'shp')
    (src / 'x.dbf').write_bytes(b'dbf')
    out = tmp_path / 'x.shp.zip'
    f.zip_with_key(src, out, ['line one', 'line two'])
    with zipfile.ZipFile(out) as zf:
        assert sorted(zf.namelist()) == ['columns.txt', 'x.dbf', 'x.shp']
        assert zf.read('columns.txt').decode() == 'line one\nline two\n'


def test_zip_with_key_is_byte_stable_across_runs(tmp_path):
    # Same input, same bytes, same md5: a re-bake must not re-upload an unchanged shapefile.
    import os
    import time
    src = tmp_path / 'shp'
    src.mkdir()
    (src / 'x.shp').write_bytes(b'shp')
    a, b = tmp_path / 'a.shp.zip', tmp_path / 'b.shp.zip'
    f.zip_with_key(src, a, ['k'])
    later = time.time() + 120
    for p in src.iterdir():
        os.utime(p, (later, later))
    f.zip_with_key(src, b, ['k'])
    assert a.read_bytes() == b.read_bytes()


def test_short_field_names_fit_dbf_and_stay_unique_case_insensitively():
    cols = ['dist_lgd', 'shallow_tw_in_use', 'shallow_tw_share', 'shallow_tw',
            'energy_electric_all', 'energy_electric', 'Energy_Electric_X']
    names = f.short_field_names(cols)
    assert list(names) == cols  # every column, input order
    assert all(len(s) <= 10 for s in names.values())
    lowered = [s.lower() for s in names.values()]
    assert len(set(lowered)) == len(lowered)
    assert names['dist_lgd'] == 'dist_lgd'  # short names pass through
    assert names['shallow_tw'] == 'shallow_tw'


def test_short_field_names_is_deterministic():
    cols = [f'very_long_column_{i}' for i in range(30)]
    assert f.short_field_names(cols) == f.short_field_names(list(cols))


def test_shapefile_key_maps_short_to_long():
    key = f.shapefile_key({'long_column_name': 'long_colum', 'id': 'id'}, intro=['Intro.'])
    assert key[0] == 'Intro.'
    assert 'long_colum  long_column_name' in key
    assert 'id          id' in key


# ── atomic outputs: an interrupted bake must never leave a final-named file ─

def test_atomic_output_moves_into_place_on_success(tmp_path):
    final = tmp_path / 'x.parquet'
    with f.atomic_output(final) as part:
        assert part != final
        part.write_text('done')
    assert final.read_text() == 'done'
    assert not part.exists()


def test_atomic_output_part_keeps_the_real_extension_last(tmp_path):
    # tippecanoe picks its output format from the extension: `x.pmtiles.part`
    # silently produced an MBTiles (SQLite) file instead of PMTiles.
    with f.atomic_output(tmp_path / 'x.pmtiles') as part:
        assert part.name == 'x.part.pmtiles'
        part.write_text('t')
    with f.atomic_output(tmp_path / 'x.shp.zip') as part:
        assert part.name.endswith('.zip') and part.name != 'x.shp.zip'
        part.write_text('z')


def test_atomic_output_leaves_nothing_on_failure(tmp_path):
    final = tmp_path / 'x.parquet'
    try:
        with f.atomic_output(final) as part:
            part.write_text('half')
            raise RuntimeError('killed')
    except RuntimeError:
        pass
    assert not final.exists() and not part.exists()


def test_layer_url_reads_the_catalog():
    catalog = {'layers': [{'id': 'lgd_districts', 'parquet': {'url': 'https://r2/d.parquet'}}]}
    assert f.layer_url(catalog, 'lgd_districts', 'parquet') == 'https://r2/d.parquet'


def test_features_sql_builds_one_geojson_feature_per_row():
    sql = f.features_sql('/w/p.parquet', 'struct_pack(id := id)')
    assert "'Feature' AS type" in sql and 'ST_AsGeoJSON(geometry)::JSON AS geometry' in sql
    assert 'struct_pack(id := id) AS properties' in sql and "read_parquet('/w/p.parquet')" in sql


def test_shapefile_key_default_intro_explains_short_names():
    assert f.shapefile_key({'a_long_name': 'a_long_nam'})[0].startswith('Shapefile field names are limited')


def test_pmtiles_args_fixed_max_zoom_replaces_the_guess():
    # -zg picked z4 for ~9k railway stations: 600 m coordinate steps when zoomed in.
    args = f.pmtiles_args(Path('in.geojson'), Path('o.pmtiles'), 'l', ('a',), max_zoom=12)
    assert '-zg' not in args and '-Z0' in args and '-z12' in args


def test_pmtiles_args_keep_every_point_at_every_zoom_when_asked():
    args = f.pmtiles_args(Path('in.geojson'), Path('o.pmtiles'), 'l', ('a',), max_zoom=12, keep_all=True)
    assert args[args.index('-r') + 1] == '1'   # drop rate 1: no thinning below the base zoom
    assert '--drop-densest-as-needed' not in args and '--extend-zooms-if-still-dropping' not in args
    assert '-r' not in f.pmtiles_args(Path('in.geojson'), Path('o.pmtiles'), 'l', ('a',))


def test_write_all_formats_writes_every_format_from_the_parquet(tmp_path):
    import json

    import pipeline
    pq = tmp_path / 'X.parquet'
    con = pipeline.make_con()
    con.execute(f"""COPY (SELECT * FROM (VALUES ('a', 1, ST_Point(77.1, 12.1)), ('b', 2, ST_Point(78.2, 13.2)))
                    t(name, a_very_long_column, geometry)) TO '{pq}' (FORMAT PARQUET)""")
    exts = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
    path = pipeline.layer_paths(tmp_path, 'X', exts)
    got = f.write_all_formats(con, path, 'x', ['name', 'a_very_long_column'], ('name',), max_zoom=8)
    assert got == pipeline.sizes_and_names(path)
    assert list(got['sizes']) == list(exts) and all(got['sizes'].values())
    assert [ft['properties']['name'] for ft in json.loads(path['geojson'].read_text())['features']] == ['a', 'b']
    assert '<Placemark' in path['kml'].read_text()
    with zipfile.ZipFile(path['shapefile']) as z:
        assert 'a_very_lon  a_very_long_column' in z.read('columns.txt').decode()


def test_gis_artefact_columns_reads_only_column_names():
    cols = f.gis_artefact_columns()
    assert {'ogc_fid', 'shape_area', '__mlocate_', '__mlocate0', '__mlocate8'} <= cols
    assert all(' ' not in c for c in cols), cols  # no comment text read as a name
