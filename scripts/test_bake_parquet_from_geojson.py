"""Parquet for layers published as GeoJSON only (gb_adm1-4, india_boundary).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_parquet_from_geojson.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_parquet_from_geojson as b  # noqa: E402
import tile_keys  # noqa: E402

R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'


def test_parquet_key_sits_next_to_the_geojson_and_is_content_versioned():
    layer = {'id': 'gb_adm1', 'geojson': {'url': f'{R2}/geoboundaries/IND_ADM1.geojson'}}
    key = b.parquet_key(layer, '0a1b2c3d' + '0' * 24)
    assert key == 'geoboundaries/IND_ADM1.0a1b2c3d.parquet'
    assert tile_keys.is_rebaked({'url': f'{R2}/{key}'}, 'parquet')  # a rebuild keeps it


def test_needs_parquet_only_when_the_layer_has_geojson_and_no_parquet():
    assert b.needs_parquet({'parquet': None, 'geojson': {'url': 'u'}})
    assert b.needs_parquet({'geojson': {'url': 'u'}})
    assert not b.needs_parquet({'parquet': {'url': 'p'}, 'geojson': {'url': 'u'}})
    assert not b.needs_parquet({'parquet': None})


def test_patch_catalog_fills_the_empty_parquet_block_in_place(tmp_path: Path):
    cat = tmp_path / 'catalog.json'
    cat.write_text(json.dumps({'layers': [
        {'id': 'gb_adm1', 'rows': 36, 'geojson': {'url': 'g'}, 'parquet': None, 'pmtiles': {'url': 't'}},
        {'id': 'other', 'parquet': {'url': 'keep'}},
    ]}))
    b.patch_catalog('gb_adm1', 'geoboundaries/IND_ADM1.0a1b2c3d.parquet', 123, catalog=cat)
    layers = json.loads(cat.read_text())['layers']
    assert layers[0]['parquet'] == {'url': f'{R2}/geoboundaries/IND_ADM1.0a1b2c3d.parquet', 'bytes': 123}
    assert list(layers[0]) == ['id', 'rows', 'geojson', 'parquet', 'pmtiles']  # same place, nothing else moved
    assert layers[1]['parquet'] == {'url': 'keep'}


@pytest.fixture
def gj(tmp_path: Path) -> Path:
    p = tmp_path / 'IND_X.geojson'
    p.write_text(json.dumps({'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {'shapeName': 'A', 'shapeID': '1'},
         'geometry': {'type': 'Polygon', 'coordinates': [[[77, 12], [78, 12], [78, 13], [77, 12]]]}},
        {'type': 'Feature', 'properties': {'shapeName': 'B', 'shapeID': '2'},
         'geometry': {'type': 'Polygon', 'coordinates': [[[70, 20], [71, 20], [71, 21], [70, 20]]]}},
    ]}))
    return p


def test_build_keeps_every_feature_and_property_and_adds_bbox(gj: Path, tmp_path: Path):
    out = tmp_path / 'IND_X.parquet'
    report = b.build(gj, out, expected_rows=2)
    assert report['rows'] == 2
    assert report['columns'] == ['shapeName', 'shapeID', 'geometry', 'xmin', 'ymin', 'xmax', 'ymax']
    import duckdb
    con = duckdb.connect()
    row = con.execute(f"SELECT xmin, ymin, xmax, ymax FROM '{out}' WHERE shapeName = 'A'").fetchone()
    assert row == (77.0, 12.0, 78.0, 13.0)  # lon, lat order


def test_build_refuses_a_row_count_that_differs_from_the_catalog(gj: Path, tmp_path: Path):
    with pytest.raises(ValueError, match='2 rows, catalog says 3'):
        b.build(gj, tmp_path / 'IND_X.parquet', expected_rows=3)


def test_a_cached_build_does_not_read_the_geojson_again(gj: Path, tmp_path: Path):
    # Counting features re-read the whole GeoJSON (100+ MB) on every cached run.
    out = tmp_path / 'IND_X.parquet'
    b.build(gj, out, expected_rows=2)
    gj.write_text('not geojson any more')
    assert b.build(gj, out, expected_rows=2)['rows'] == 2


def test_a_run_stops_cleanly_at_its_time_limit(tmp_path: Path, monkeypatch, capsys):
    cat = tmp_path / 'catalog.json'
    cat.write_text(json.dumps({'layers': [{'id': 'gb_adm1', 'geojson': {'url': 'u'}}]}))
    monkeypatch.setattr(b, 'CATALOG', cat)
    monkeypatch.setattr(b, 'bake', lambda *a, **k: pytest.fail('baked past the time limit'))
    assert b.main(['gb_adm1', '--no-upload', '--max-minutes', '0']) == 3
    assert 'STOPPED' in capsys.readouterr().out
