"""Tests for scripts/oneoff/bake_missing_formats.py: the whole-layer downloads
22 layers lacked (Nov 2026).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_missing_formats.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / 'oneoff'))
import bake_missing_formats as bm  # noqa: E402
from pipeline import Deadline, OutOfTime, make_con  # noqa: E402

BASE = 'https://data.bharatlas.com'


def _layer(**blocks) -> dict:
    return {'id': 'x', 'level': 'state',
            'parquet': {'url': f'{BASE}/geoboundaries/IND_ADM1.3f41867b.parquet', 'bytes': 1},
            'pmtiles': {'url': f'{BASE}/geoboundaries/IND_ADM1.466461ac.pmtiles', 'bytes': 1},
            **blocks, 'licence': 'CC-BY-4.0'}


def _parquet(tmp_path: Path, geom: str = 'geometry') -> Path:
    pq = tmp_path / 'src.parquet'
    make_con().execute(
        f"""COPY (SELECT * FROM (VALUES
              ('Bengaluru', 1, ST_GeomFromText('POLYGON((77.5 12.9, 77.7 12.9, 77.7 13.1, 77.5 13.1, 77.5 12.9))')),
              ('Patna', NULL, ST_GeomFromText('POLYGON((85.1 25.5, 85.2 25.5, 85.2 25.6, 85.1 25.5))')))
            t(name, a_very_long_column, {geom})) TO '{pq}' (FORMAT PARQUET)""")
    return pq


def test_missing_formats_lists_only_what_the_entry_lacks():
    assert bm.missing_formats(_layer()) == ['geojson', 'kml', 'shapefile']
    assert bm.missing_formats(_layer(geojson={'url': 'u', 'bytes': 1})) == ['kml', 'shapefile']
    assert bm.missing_formats(_layer(geojson=None, kml=None)) == ['geojson', 'kml', 'shapefile']


def test_patch_fills_a_null_block_where_it_stands():
    layer = _layer(geojson=None)
    got = bm.with_blocks(layer, {'geojson': {'url': 'u', 'bytes': 1}, 'kml': {'url': 'k', 'bytes': 2}})
    assert list(got) == ['id', 'level', 'parquet', 'pmtiles', 'geojson', 'kml', 'licence']
    assert got['geojson'] == {'url': 'u', 'bytes': 1}


def test_stem_drops_the_version_suffix_and_prefix_is_the_r2_folder():
    assert bm.stem(f'{BASE}/geoboundaries/IND_ADM1.3f41867b.parquet') == 'IND_ADM1'
    assert bm.stem(f'{BASE}/water/rivers/WRIS_Rivers.parquet') == 'WRIS_Rivers'
    assert bm.r2_prefix(f'{BASE}/pois/overture-places/2026-11-18.0-r3/o.parquet') == 'pois/overture-places/2026-11-18.0-r3'
    with pytest.raises(ValueError):
        bm.r2_prefix('https://example.com/a/b.parquet')


def test_bake_writes_every_missing_format_and_a_rerun_does_nothing(tmp_path):
    pq = _parquet(tmp_path)
    paths = {f: tmp_path / 'out' / f'IND_ADM1.{bm.EXT[f]}' for f in bm.FORMATS}
    first = bm.bake_layer(_layer(), pq, paths, list(bm.FORMATS), Deadline(10))
    assert first == {'geojson': 'wrote', 'kml': 'wrote', 'shapefile': 'wrote'}
    assert bm.bake_layer(_layer(), pq, paths, list(bm.FORMATS), Deadline(10)) == dict.fromkeys(bm.FORMATS, 'skip')
    assert bm.verify_layer(_layer(), pq, paths, list(bm.FORMATS)) == dict.fromkeys(bm.FORMATS, [])


def test_an_ogc_fid_column_rides_as_the_geojson_id_and_comes_back_in_the_shapefile(tmp_path):
    pq = tmp_path / 'fid.parquet'
    make_con().execute(f"COPY (SELECT 41 AS OGC_FID, 'Patna' AS name, ST_Point(85.1, 25.6) AS geom) TO '{pq}' (FORMAT PARQUET)")
    paths = {f: tmp_path / 'out' / f'P.{bm.EXT[f]}' for f in bm.FORMATS}
    bm.bake_layer(_layer(), pq, paths, list(bm.FORMATS), Deadline(10))
    assert json.loads(paths['geojson'].read_text())['features'][0]['id'] == 41
    assert bm.verify_layer(_layer(), pq, paths, list(bm.FORMATS)) == dict.fromkeys(bm.FORMATS, [])
    assert bm.ogr_summary(f'/vsizip/{paths["shapefile"]}')[1] == ['OGC_FID', 'name']


def test_a_failed_format_is_reported_and_the_run_goes_on(tmp_path, monkeypatch):
    def boom(*a):
        raise ValueError('writer broke')
    monkeypatch.setattr(bm, 'write_geojson_whole', boom)
    paths = {f: tmp_path / 'out' / f'IND_ADM1.{bm.EXT[f]}' for f in bm.FORMATS}
    got = bm.bake_layer(_layer(), _parquet(tmp_path), paths, list(bm.FORMATS), Deadline(10))
    assert got == {'geojson': 'failed: writer broke', 'kml': 'needs the geojson', 'shapefile': 'needs the geojson'}
    assert not any(p.exists() for p in paths.values())


def test_a_changed_parquet_rebakes(tmp_path):
    pq = _parquet(tmp_path)
    paths = {f: tmp_path / 'out' / f'IND_ADM1.{bm.EXT[f]}' for f in bm.FORMATS}
    bm.bake_layer(_layer(), pq, paths, ['geojson'], Deadline(10))
    pq.unlink()
    _parquet(tmp_path, geom='geom')  # same rows, other bytes
    assert bm.bake_layer(_layer(), pq, paths, ['geojson'], Deadline(10)) == {'geojson': 'wrote'}


def test_bake_stops_cleanly_at_its_time_limit(tmp_path):
    pq = _parquet(tmp_path)
    paths = {f: tmp_path / 'out' / f'IND_ADM1.{bm.EXT[f]}' for f in bm.FORMATS}
    with pytest.raises(OutOfTime):
        bm.bake_layer(_layer(), pq, paths, list(bm.FORMATS), Deadline(-1))
    assert not any(p.exists() for p in paths.values())


def test_verify_catches_a_lat_lon_file(tmp_path):
    gj = tmp_path / 'swapped.geojson'
    gj.write_text(json.dumps({'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {'name': n, 'a_very_long_column': None},
         'geometry': {'type': 'Point', 'coordinates': [12.9, 77.5]}} for n in 'ab']}))
    assert bm.verify_file('geojson', gj, 2, ['name', 'a_very_long_column']) == [
        'first coordinate 12.9,77.5 is not lon,lat in India']
    assert bm.verify_file('geojson', gj, 3, ['name', 'a_very_long_column'])[0] == '2 features, parquet has 3'


def test_verify_catches_a_kml_that_lost_a_column(tmp_path):
    kml = tmp_path / 'x.kml'
    kml.write_text('<kml><Document><Placemark><name>a</name><ExtendedData><Data name="name"><value>a</value></Data>'
                   '</ExtendedData><Point><coordinates>77.5,12.9</coordinates></Point></Placemark></Document></kml>')
    assert bm.kml_data_names(kml, chunk=7) == {'name'}  # a name split across chunks is still found
    assert bm.verify_file('kml', kml, 1, ['name', 'code']) == ["KML Data names differ: missing ['code'], extra []"]


def test_plan_names_a_new_versioned_key_and_the_patch_adds_only_new_blocks(tmp_path, monkeypatch):
    monkeypatch.setattr(bm, 'ROOT', tmp_path)
    f = tmp_path / 'IND_ADM1.kml'
    f.write_text('<kml/>')
    p = bm.plan_entry(_layer(), 'kml', f)
    assert p['key'] == f'geoboundaries/IND_ADM1.{p["md5"][:8]}.kml'
    assert p['url'] == f'{BASE}/{p["key"]}' and p['bytes'] == 6
    old_geojson = {'url': f'{BASE}/geoboundaries/IND_ADM1.geojson', 'bytes': 9}
    catalog = {'layers': [_layer(geojson=old_geojson), {'id': 'other'}]}
    patched = bm.patch_catalog(json.loads(json.dumps(catalog)), [p])
    got = patched['layers'][0]
    assert list(got) == ['id', 'level', 'parquet', 'pmtiles', 'geojson', 'kml', 'licence']
    assert got['geojson'] == old_geojson and got['kml'] == {'url': p['url'], 'bytes': 6}
    assert patched['layers'][1] == {'id': 'other'}
    assert bm.patch_catalog(json.loads(json.dumps(patched)), [p]) == patched  # idempotent
