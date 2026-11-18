"""KML writing streams GeoJSON features (review item 17).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_extracts.py -q
"""
from __future__ import annotations

import json
import sys
import tracemalloc
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_extracts as be  # noqa: E402

FEATURES = [
    {'type': 'Feature', 'properties': {'stname': 'Bihār & <Co>', 'n': 1, 'empty': '', 'none': None},
     'geometry': {'type': 'Point', 'coordinates': [85.1376, 25.5941]}},
    {'type': 'Feature', 'properties': {'name': 'line "q"'},
     'geometry': {'type': 'LineString', 'coordinates': [[77.0, 28.5], [77.25, 28.75]]}},
    {'type': 'Feature', 'properties': {'dtname': 'Patna', 'v': 1.5e-7},
     'geometry': {'type': 'Polygon', 'coordinates': [
         [[85, 25], [86, 25], [86, 26], [85, 25]],
         [[85.2, 25.2], [85.3, 25.2], [85.3, 25.3], [85.2, 25.2]]]}},
    {'type': 'Feature', 'properties': {},
     'geometry': {'type': 'MultiPolygon', 'coordinates': [[[[1, 2], [3, 4], [5, 6], [1, 2]]]]}},
    {'type': 'Feature', 'properties': {'NAME': 'gc'},
     'geometry': {'type': 'GeometryCollection', 'geometries': [
         {'type': 'Point', 'coordinates': [1, 2]},
         {'type': 'MultiLineString', 'coordinates': [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]}]}},
    {'type': 'Feature', 'properties': None, 'geometry': None},
]


def kml_before(geojson: Path, layer_name: str) -> str:
    """What write_kml_from_geojson wrote before it streamed: the whole
    FeatureCollection loaded at once."""
    fc = json.loads(geojson.read_text(encoding='utf-8'))
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n'
            f'<Document><name>{be.esc_xml(layer_name)}</name>'
            + ''.join(be.feature_to_placemark(f) for f in fc.get('features') or [])
            + '</Document>\n</kml>\n')


GDAL_STYLE = ('{\n"type": "FeatureCollection",\n"name": "x",\n'
              '"crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:OGC:1.3:CRS84" } },\n'
              '"features": [\n' + ',\n'.join(json.dumps(f, ensure_ascii=False) for f in FEATURES) + '\n]\n}\n')


@pytest.mark.parametrize('text', [
    GDAL_STYLE,
    json.dumps({'type': 'FeatureCollection', 'features': FEATURES}),                   # compact
    json.dumps({'features': FEATURES, 'type': 'FeatureCollection', 'bbox': [1, 2, 3, 4]}, indent=2),
    json.dumps({'type': 'FeatureCollection', 'features': []}),
    json.dumps({'type': 'FeatureCollection', 'features': None}),
    json.dumps({'type': 'FeatureCollection'}),
])
def test_kml_is_byte_identical_to_the_whole_file_writer(tmp_path, text):
    gj, out = tmp_path / 'in.geojson', tmp_path / 'out.kml'
    gj.write_text(text, encoding='utf-8')
    be.write_kml_from_geojson(gj, 'Layer & co', out)
    assert out.read_text(encoding='utf-8') == kml_before(gj, 'Layer & co')


def test_features_larger_than_the_read_buffer_still_parse(tmp_path):
    gj = tmp_path / 'in.geojson'
    gj.write_text(GDAL_STYLE, encoding='utf-8')
    assert list(be.iter_geojson_features(gj, chunk_size=7)) == json.loads(GDAL_STYLE)['features']


def test_truncated_geojson_fails_loudly(tmp_path):
    gj = tmp_path / 'in.geojson'
    gj.write_text(GDAL_STYLE[:-30], encoding='utf-8')
    with pytest.raises(ValueError):
        list(be.iter_geojson_features(gj, chunk_size=64))


def test_kml_memory_stays_bounded_on_200k_features(tmp_path):
    gj, out = tmp_path / 'big.geojson', tmp_path / 'big.kml'
    with gj.open('w', encoding='utf-8') as f:
        f.write('{"type": "FeatureCollection", "name": "big", "features": [\n')
        for i in range(200_000):
            f.write(('' if i == 0 else ',\n') + '{"type": "Feature", "properties": {"name": "place %d", "code": %d}, '
                    '"geometry": {"type": "Point", "coordinates": [%f, %f]}}' % (i, i, 68 + i % 30, 8 + i % 29))
        f.write('\n]}\n')
    assert gj.stat().st_size > 20_000_000
    tracemalloc.start()
    be.write_kml_from_geojson(gj, 'big', out)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert out.read_text().count('<Placemark>') == 200_000
    assert peak < 8_000_000, f'peak {peak:,} bytes: the whole file was held in memory'
