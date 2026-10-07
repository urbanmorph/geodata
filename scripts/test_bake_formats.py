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
    assert args == ['tippecanoe', '-o', 'out.pmtiles', '-l', 'my_layer', '-zg',
                    '--drop-densest-as-needed', '--extend-zooms-if-still-dropping',
                    '-y', 'a', '-y', 'b', '--force', '--no-progress-indicator', 'in.geojson']


def test_pmtiles_args_parallel_reads_line_delimited_input():
    args = f.pmtiles_args(Path('in.geojsons'), Path('o.pmtiles'), 'l', ('a',), parallel=True)
    assert args[:7] == ['tippecanoe', '-o', 'o.pmtiles', '-l', 'l', '-zg', '-P']


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
