"""ingest_external: the Nov 2026 ward and zone batch, and the local build.

Every layer it builds must carry what locate, nearby and the downloads need:
parquet with flat xmin/ymin/xmax/ymax in Hilbert order, PMTiles reaching z12
(locate tests a point at the tileset's max zoom; -zg once stopped at z4),
GeoJSON and KML longitude first, KML Placemarks named, and a shapefile.

Licences were read from each OpenCity dataset's CKAN package_show on
2026-11-15 (behind a Cloudflare challenge, so they are a fixture here) and
from the DataMeet Chennai folder readme.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_ingest_external.py -q
"""
from __future__ import annotations

import json
import shutil
import sys
import zipfile
from pathlib import Path

import duckdb
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ingest_external as ie  # noqa: E402

OPENCITY = 'https://data.opencity.in/dataset/'
DATAMEET_CHENNAI = 'https://github.com/datameet/Municipal_Spatial_Data/tree/master/Chennai'

# id -> (source_url, licence label, attr_key, feature count, KML name column)
BATCH = {
    'wards_kalyan_dombivli': (OPENCITY + 'kalyan-dombivli-wards-map', 'CC0-1.0', 'OpenCity', 123, 'sourcewardcode'),
    'zones_bengaluru_gba': (OPENCITY + 'greater-bengaluru-authority-corporations-delimitation-2025',
                            'CC0-1.0', 'OpenCity', 10, 'Zone'),
    'wards_pune_2025': (OPENCITY + 'pune-wards-info', 'CC0-1.0', 'OpenCity', 15, 'Field'),
    'zones_pune': (OPENCITY + 'pune-wards-info', 'CC0-1.0', 'OpenCity', 5, 'Zone_Name'),
    'zones_chennai': (DATAMEET_CHENNAI, 'CC-BY-SA-2.5-IN', 'DataMeet', 16, 'Zone Name'),
}


def _by_id() -> dict:
    return {d.id: d for d in ie.DATASETS}


@pytest.mark.parametrize('layer_id', sorted(BATCH))
def test_batch_dataset_is_defined_with_its_stated_licence(layer_id):
    url, lic, attr, n, name_col = BATCH[layer_id]
    d = _by_id()[layer_id]
    assert (d.source_url, d.license, d.attr_key, d.features, d.kml_name_field) == (url, lic, attr, n, name_col)
    assert d.category == 'city-wards' and d.level == layer_id
    assert Path(d.src).parent == ie.ROOT / 'data' / 'external-src'
    assert '—' not in d.description + d.name + d.notes  # no em-dashes in user copy


def test_ids_and_r2_prefixes_are_unique():
    ids = [d.id for d in ie.DATASETS]
    assert len(ids) == len(set(ids))
    others = {d.r2_prefix for d in ie.DATASETS if d.id not in BATCH}
    batch = [_by_id()[i].r2_prefix for i in BATCH]
    assert len(set(batch)) == len(batch) and not others & set(batch)


def test_tiles_reach_zoom_12_not_a_guessed_zoom(tmp_path):
    args = ie.tippecanoe_args(tmp_path / 'in.geojson', tmp_path / 'out.pmtiles', 'x')
    assert '-zg' not in args
    assert '-z12' in args and '-Z0' in args


def test_outputs_land_at_their_r2_paths_under_data_baked():
    d = _by_id()['zones_pune']
    out = ie.outputs(d, ie.ROOT / 'data' / 'baked')
    base = ie.ROOT / 'data' / 'baked' / 'admin' / 'zones-pune'
    assert out == {fmt: base / f'zones_pune.{ext}' for fmt, ext in
                   [('parquet', 'parquet'), ('pmtiles', 'pmtiles'), ('geojson', 'geojson'),
                    ('kml', 'kml'), ('shapefile', 'shp.zip')]}


def test_manifest_merge_replaces_by_id_and_keeps_the_rest():
    old = [{'id': 'a', 'v': 1}, {'id': 'b', 'v': 1}]
    assert ie.merge_manifest(old, [{'id': 'b', 'v': 2}, {'id': 'c', 'v': 1}]) == [
        {'id': 'a', 'v': 1}, {'id': 'b', 'v': 2}, {'id': 'c', 'v': 1}]


def test_ward_index_reads_the_new_ward_layers():
    import build_ward_index as w
    assert w.OVERRIDES['wards_pune_2025'] == ('AdminNo', 'Field', 'Ward office')
    assert w.OVERRIDES['wards_kalyan_dombivli'] == ('sourcewardcode', None, None)


# ── end to end on a two-ward KML ──

KML = """<?xml version="1.0" encoding="utf-8" ?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Schema name="w" id="w"><SimpleField name="ward_name" type="string"></SimpleField></Schema><Folder><name>w</name>
<Placemark><ExtendedData><SchemaData schemaUrl="#w"><SimpleData name="ward_name">Ward A</SimpleData></SchemaData></ExtendedData>
<Polygon><outerBoundaryIs><LinearRing><coordinates>73.10,19.20 73.12,19.20 73.12,19.22 73.10,19.22 73.10,19.20</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><ExtendedData><SchemaData schemaUrl="#w"><SimpleData name="ward_name">Ward B</SimpleData></SchemaData></ExtendedData>
<Polygon><outerBoundaryIs><LinearRing><coordinates>73.12,19.20 73.14,19.20 73.14,19.22 73.12,19.22 73.12,19.20</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder></Document></kml>
"""


@pytest.mark.skipif(not (shutil.which('tippecanoe') and shutil.which('ogr2ogr')), reason='needs tippecanoe + GDAL')
def test_build_bakes_every_format_ready_for_locate_and_downloads(tmp_path):
    src = tmp_path / 'src.kml'
    src.write_text(KML)
    d = ie.Dataset(id='wards_test', name='Test wards', src=str(src), category='city-wards', level='wards_test',
                   description='t', source_org='t', source_url='t', license='CC0-1.0', r2_prefix='admin/wards-test',
                   unit='wards', features=2, kml_name_field='ward_name')
    out = ie.build(d, tmp_path / 'baked')
    assert set(out) == {'parquet', 'pmtiles', 'geojson', 'kml', 'shapefile'}

    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    cols = [c[0] for c in con.execute(f"DESCRIBE SELECT * FROM '{out['parquet']}'").fetchall()]
    assert {'xmin', 'ymin', 'xmax', 'ymax', 'ward_name'} <= set(cols)
    assert con.execute(f"SELECT count(*) FROM '{out['parquet']}' WHERE xmin BETWEEN 73 AND 74").fetchone()[0] == 2

    header = out['pmtiles'].read_bytes()[:127]
    assert header[:7] == b'PMTiles' and header[101] >= 12  # v3 header: byte 101 is max zoom

    gj = json.loads(out['geojson'].read_text())
    assert len(gj['features']) == 2
    assert gj['features'][0]['geometry']['coordinates'][0][0][0] > 70  # lon first

    kml = out['kml'].read_text()
    assert '<name>Ward A</name>' in kml and '<name>Ward B</name>' in kml
    assert '73.1,19.2' in kml.replace('73.10,', '73.1,').replace('19.20', '19.2')  # lon,lat

    with zipfile.ZipFile(out['shapefile']) as zf:
        assert any(n.endswith('.shp') for n in zf.namelist())

    # A second run with the same input does no new work and changes nothing.
    before = {k: p.read_bytes() for k, p in out.items()}
    again = ie.build(d, tmp_path / 'baked')
    assert {k: p.read_bytes() for k, p in again.items()} == before


def test_manifest_is_written_with_a_trailing_newline(tmp_path, monkeypatch):
    m = tmp_path / 'external-ingested.json'
    m.write_text('[]\n')
    monkeypatch.setattr(ie, 'MANIFEST', m)
    ie.save_manifest([{'id': 'a'}])
    assert m.read_text().endswith(']\n')


# ── Hyderabad: GHMC's own 150-ward map replaces the OpenStreetMap-derived 145 ──

def test_hyderabad_is_the_ghmc_map_under_a_new_r2_prefix():
    d = _by_id()['wards_hyderabad']
    assert (d.source_url, d.license, d.attr_key, d.features, d.kml_name_field) == (
        OPENCITY + 'hyderabad-wards-info', 'CC0-1.0', 'OpenCity', 155, 'ward')
    assert Path(d.src) == ie.ROOT / 'data' / 'external-src' / 'ghmc_wards_2022.kml'
    # The old keys under admin/wards-hyderabad are served immutable and stay with the historical layer.
    assert d.r2_prefix == 'admin/wards-hyderabad-ghmc-2022'
    assert '—' not in d.description + d.name + d.notes
    assert 'wards_hyderabad_osm' not in _by_id()  # the historical layer keeps its published files
