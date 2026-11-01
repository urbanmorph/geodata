"""Downloads keep longitude first.

A parquet whose geometry carries an explicit EPSG:4326 tag made GDAL write
latitude,longitude into GeoJSON (and the KML and shapefile built from it),
putting every city ward layer's downloads in the wrong place (Nov 2026).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_axis_order.py -q
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from bake_extracts import make_con  # noqa: E402
from bake_whole_layer import write_geojson_whole  # noqa: E402

PATNA = (85.1585477, 25.6034884)  # lon, lat


def _tagged_parquet(tmp_path: Path) -> Path:
    src = tmp_path / 'tagged.parquet'
    con = make_con()
    con.execute(
        f"COPY (SELECT 'Ward 35' AS wardname, "
        f"ST_SetCRS(ST_Point({PATNA[0]}, {PATNA[1]}), 'EPSG:4326') AS geom) "
        f"TO '{src}' (FORMAT PARQUET)"
    )
    assert 'EPSG:4326' in con.execute(f"SELECT typeof(geom) FROM '{src}'").fetchone()[0]
    return src


def test_whole_layer_geojson_of_an_epsg4326_tagged_parquet_is_lon_lat(tmp_path):
    out = tmp_path / 'out.geojson'
    write_geojson_whole(make_con(), _tagged_parquet(tmp_path), out, gdal_ok=True)
    coords = json.loads(out.read_text())['features'][0]['geometry']['coordinates']
    assert coords == list(PATNA)


def test_every_script_that_writes_through_gdal_keeps_xy_order():
    # Any script with its own GDAL COPY must set geometry_always_xy (or use
    # bake_extracts.make_con, which does), or a CRS-tagged input flips again.
    missing = []
    for p in HERE.glob('*.py'):
        if p.name.startswith('test_'):
            continue
        text = p.read_text(encoding='utf-8')
        if re.search(r'FORMAT GDAL', text) and 'geometry_always_xy' not in text \
                and 'make_con' not in text:
            missing.append(p.name)
    assert missing == []


def test_kml_placemark_is_named_after_the_ward():
    # Ward layers had blank Placemark names, so Google My Maps showed no labels.
    from bake_extracts import feature_to_placemark
    feat = {'type': 'Feature', 'properties': {'wardname': 'Ward 1'},
            'geometry': {'type': 'Point', 'coordinates': list(PATNA)}}
    assert '<name>Ward 1</name>' in feature_to_placemark(feat)
    assert f'<coordinates>{PATNA[0]},{PATNA[1]}</coordinates>' in feature_to_placemark(feat)
