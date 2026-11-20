"""Groundwater prospect zones and land degradation 2015-16, split per state:
scripts/bake_land_water_states.py.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_land_water_states.py -q
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

import duckdb
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_land_water_states as s  # noqa: E402
import licence_watch  # noqa: E402
import ingest_ramseraph as ir  # noqa: E402
from pipeline import file_md5  # noqa: E402


def _con():
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial; SET geometry_always_xy = true')
    return con


def _shard(path: Path, rows: list[tuple], extra: str | None = None) -> Path:
    """A ramSeraph-shaped shard: string columns, a bbox struct, polygons."""
    con = _con()
    sel = []
    for i, (state, x, y) in enumerate(rows):
        state_sql = 'NULL' if state is None else f"'{state}'"
        poly = f'POLYGON(({x} {y}, {x + 0.1} {y}, {x + 0.1} {y + 0.1}, {x} {y + 0.1}, {x} {y}))'
        cols = f"'{path.stem}-{i}' AS id, {state_sql} AS st, 'unit {i}' AS a_rather_long_column_name"
        if extra:
            cols += f", 'x{i}' AS \"{extra}\""
        sel.append(f"SELECT {cols}, ST_GeomFromText('{poly}') AS geometry, "
                   f"{{'xmin': {x}, 'ymin': {y}, 'xmax': {x + 0.1}, 'ymax': {y + 0.1}}} AS bbox")
    con.execute(f"COPY ({' UNION ALL '.join(sel)}) TO '{path}' (FORMAT PARQUET)")
    return path


@pytest.fixture
def shards(tmp_path):
    a = _shard(tmp_path / 'a.parquet', [('KA', 77.5, 12.9), ('KA', 77.6, 13.0), ('MH', 73.8, 18.5)])
    b = _shard(tmp_path / 'b.parquet', [('MH', 73.9, 18.6), (None, 85.3, 23.3)], extra='only_in_b')
    return [a, b]


# ── the layers ─────────────────────────────────────────────────────────────

def test_layers_are_gw_prospects_and_degradation_2015_16_only():
    ids = [layer.d.id for layer in s.LAYERS]
    assert ids == ['bhuvan_gw_prospects', 'bhuvan_land_degradation_1516']
    gw, ld = s.LAYERS
    assert gw.state_column == 'sname' and ld.state_column == 'lname'
    assert [Path(u).name for u in gw.shards] == [
        'Bhuvan_Groundwater_Prospects_LGEOM.00.parquet', 'Bhuvan_Groundwater_Prospects_LGEOM.01.parquet']
    assert [Path(u).name for u in ld.shards] == [
        f'Bhuvan_Land_Degradation_50k_1516.{n}.parquet' for n in ('000', '001', '010', '011')]
    for layer in s.LAYERS:
        assert layer.d.license == licence_watch.licence_of(layer.d.id)   # Bhuvan: NRSC terms
        assert all(u.startswith('https://github.com/ramSeraph/indian_land_features/releases/download/')
                   for u in layer.shards)
        assert layer.popup and layer.state_column in layer.popup


# ── national parquet ───────────────────────────────────────────────────────

def test_national_parquet_keeps_every_column_and_row_with_flat_bbox(shards, tmp_path):
    out = tmp_path / 'n.parquet'
    n = s.national_parquet(shards, out, tmp_path / 'work', _con())
    con = _con()
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{out}')").fetchall()]
    assert n == 5
    for c in ('id', 'st', 'a_rather_long_column_name', 'only_in_b', 'geometry', 'xmin', 'ymin', 'xmax', 'ymax'):
        assert c in cols
    assert 'bbox' not in cols  # flattened into xmin..ymax (rebake_flatten_bbox)
    assert con.execute(f"SELECT count(*) FROM read_parquet('{out}') WHERE xmin IS NULL").fetchone()[0] == 0


def test_national_parquet_is_byte_stable(shards, tmp_path):
    one = s.national_parquet(shards, tmp_path / 'one.parquet', tmp_path / 'w1', _con())
    two = s.national_parquet(shards, tmp_path / 'two.parquet', tmp_path / 'w2', _con())
    assert one == two
    assert file_md5(tmp_path / 'one.parquet') == file_md5(tmp_path / 'two.parquet')


# ── per-state files ────────────────────────────────────────────────────────

def test_state_counts_include_a_missing_state(shards, tmp_path):
    out = tmp_path / 'n.parquet'
    s.national_parquet(shards, out, tmp_path / 'work', _con())
    assert s.state_counts(_con(), out, 'st') == {'KA': 2, 'MH': 2, None: 1}


def test_state_stem():
    assert s.state_stem('bhuvan_gw_prospects', 'Andhra Pradesh') == 'bhuvan_gw_prospects_andhra_pradesh'
    assert s.state_stem('x', None) == 'x_no_state'


def test_state_files_hold_each_state_in_every_format(shards, tmp_path):
    pq = tmp_path / 'n.parquet'
    s.national_parquet(shards, pq, tmp_path / 'work', _con())
    out = tmp_path / 'states'
    files = s.write_state_files(pq, 'st', 'MH', out, 'lyr', kml_name_field='id')
    assert sorted(files) == ['geojson', 'kml', 'shapefile']
    assert s.count_geojson_features(files['geojson']) == 2
    assert s.count_kml_placemarks(files['kml']) == 2
    assert s.count_shapefile_features(files['shapefile']) == 2
    x, y = s.blw.first_coord(files['geojson'])
    assert 73 < x < 74 and 18 < y < 19  # lon,lat (GDAL axis order)
    # cached: a second call does no work
    mtimes = {k: p.stat().st_mtime_ns for k, p in files.items()}
    again = s.write_state_files(pq, 'st', 'MH', out, 'lyr', kml_name_field='id')
    assert {k: p.stat().st_mtime_ns for k, p in again.items()} == mtimes


def test_state_files_for_rows_without_a_state(shards, tmp_path):
    pq = tmp_path / 'n.parquet'
    s.national_parquet(shards, pq, tmp_path / 'work', _con())
    files = s.write_state_files(pq, 'st', None, tmp_path / 'states', 'lyr')
    assert files['geojson'].name == 'lyr_no_state.geojson'
    assert s.count_geojson_features(files['geojson']) == 1


def test_shapefile_keeps_long_names_in_a_key(shards, tmp_path):
    pq = tmp_path / 'n.parquet'
    s.national_parquet(shards, pq, tmp_path / 'work', _con())
    files = s.write_state_files(pq, 'st', 'KA', tmp_path / 'states', 'lyr')
    names = s.shapefile_names(_con(), pq)
    assert names['a_rather_long_column_name'] == 'a_rather_l'
    assert 'geometry' not in names
    fields = s.shapefile_fields(files['shapefile'])
    assert 'a_rather_l' in fields and 'only_in_b' in fields


def test_check_counts_must_add_up():
    expected = {'KA': 2, 'MH': 2, None: 1}
    s.check_counts('geojson', expected, {'KA': 2, 'MH': 2, None: 1}, total=5)
    with pytest.raises(RuntimeError, match='MH'):
        s.check_counts('kml', expected, {'KA': 2, 'MH': 1, None: 1}, total=5)
    with pytest.raises(RuntimeError, match='add up'):
        s.check_counts('geojson', {'KA': 2}, {'KA': 2}, total=5)


# ── zips ───────────────────────────────────────────────────────────────────

def test_stable_zip_streams_and_is_byte_stable(tmp_path):
    src = tmp_path / 'src'
    src.mkdir()
    (src / 'b.geojson').write_text('{"b": 1}')
    (src / 'a.geojson').write_text('{"a": 1}' * 1000)
    one, two = tmp_path / 'one.zip', tmp_path / 'two.zip'
    s.stable_zip([src / 'b.geojson', src / 'a.geojson'], one)
    (src / 'a.geojson').touch()  # a newer mtime must not change the bytes
    s.stable_zip([src / 'a.geojson', src / 'b.geojson'], two)
    assert file_md5(one) == file_md5(two)
    with zipfile.ZipFile(one) as z:
        assert z.namelist() == ['a.geojson', 'b.geojson']
        assert z.read('a.geojson') == (src / 'a.geojson').read_bytes()


def test_versioned_key():
    assert s.versioned_key('Bhuvan_X.geojson.zip', 'abcdef0123456789') == 'Bhuvan_X.abcdef01.geojson.zip'
    assert s.versioned_key('Bhuvan_X.parquet', 'abcdef0123456789') == 'Bhuvan_X.abcdef01.parquet'
    assert s.versioned_key('Bhuvan_X.shp.zip', '0123456789abcdef') == 'Bhuvan_X.01234567.shp.zip'


# ── catalog ────────────────────────────────────────────────────────────────

def _published():
    return {'parquet': ('Bhuvan_Groundwater_Prospects_LGEOM.11111111.parquet', 100),
            'pmtiles': ('Bhuvan_Groundwater_Prospects_LGEOM.22222222.pmtiles', 50),
            'geojson': ('Bhuvan_Groundwater_Prospects_LGEOM.33333333.geojson.zip', 30),
            'kml': ('Bhuvan_Groundwater_Prospects_LGEOM.44444444.kml.zip', 40),
            'shapefile': ('Bhuvan_Groundwater_Prospects_LGEOM.55555555.shp.zip', 20)}


def test_register_patches_catalog_and_manifest_in_place_idempotent(tmp_path):
    cat, man = tmp_path / 'catalog.json', tmp_path / 'manifest.json'
    cat.write_text(json.dumps({'layers': [{'id': 'other'}], 'level_meta': {}, 'level_order': []}))
    man.write_text('[]')
    layer = s.LAYERS[0]
    s.register(layer, _published(), features=7, states=31, catalog=cat, manifest=man)
    first_cat, first_man = cat.read_text(), man.read_text()
    s.register(layer, _published(), features=7, states=31, catalog=cat, manifest=man)
    assert (cat.read_text(), man.read_text()) == (first_cat, first_man)

    c = json.loads(first_cat)
    entry = next(x for x in c['layers'] if x['id'] == 'bhuvan_gw_prospects')
    base = f'{ir.R2_PUBLIC}/{layer.d.r2_prefix}/'
    assert entry['parquet']['url'] == base + 'Bhuvan_Groundwater_Prospects_LGEOM.11111111.parquet'
    assert entry['parquet']['upstream_url'] == layer.release_url
    assert entry['pmtiles'] == {'url': base + 'Bhuvan_Groundwater_Prospects_LGEOM.22222222.pmtiles', 'bytes': 50}
    assert entry['geojson'] == {'url': base + 'Bhuvan_Groundwater_Prospects_LGEOM.33333333.geojson.zip', 'bytes': 30}
    assert entry['kml']['url'].endswith('.kml.zip') and entry['shapefile']['url'].endswith('.shp.zip')
    assert (entry['rows'], entry['licence'], entry['provenance']) == (7, 'NRSC terms', 'curated')
    assert entry['fetched_at'] and 'one file per state' in entry['notes']
    assert '—' not in entry['notes'] and '—' not in c['level_meta']['bhuvan_gw_prospects']['description']
    assert 'bhuvan_gw_prospects' in c['level_order']
    m = json.loads(first_man)[0]
    assert (m['parquet_file'], m['pmtiles_file']) == ('Bhuvan_Groundwater_Prospects_LGEOM.11111111.parquet',
                                                      'Bhuvan_Groundwater_Prospects_LGEOM.22222222.pmtiles')
    assert m['r2_prefix'] == layer.d.r2_prefix and m['features'] == 7


def test_register_replaces_older_versions_but_keeps_fetched_at(tmp_path):
    cat, man = tmp_path / 'catalog.json', tmp_path / 'manifest.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': []}))
    man.write_text('[]')
    layer = s.LAYERS[0]
    s.register(layer, _published(), features=7, states=31, catalog=cat, manifest=man)
    first = json.loads(cat.read_text())['layers'][0]
    newer = {**_published(), 'pmtiles': ('Bhuvan_Groundwater_Prospects_LGEOM.99999999.pmtiles', 60)}
    s.register(layer, newer, features=7, states=31, catalog=cat, manifest=man)
    entry = json.loads(cat.read_text())['layers'][0]
    assert entry['pmtiles']['url'].endswith('.99999999.pmtiles')  # not the previous rebaked block
    assert entry['fetched_at'] == first['fetched_at']


def test_query_check_gates_registration(tmp_path):
    rec = tmp_path / 'query_check.json'
    assert not s.query_check_passed(rec)
    rec.write_text(json.dumps({'ok': False, 'error': 'timeout'}))
    assert not s.query_check_passed(rec)
    rec.write_text(json.dumps({'ok': True, 'ms': 1234}))
    assert s.query_check_passed(rec)
