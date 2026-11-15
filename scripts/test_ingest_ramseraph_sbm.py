"""SBM national wards + ULB boundaries via ingest_ramseraph (Nov 2026).

- Every format is baked (geojson, kml, shapefile) even above the 100 MB
  whole-layer cap, so the layers can be viewed, queried and downloaded.
- KML Placemarks carry the ward / town name (Google Earth / My Maps labels).
- --no-upload builds everything locally and never touches R2.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_ingest_ramseraph_sbm.py -q
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import duckdb
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ingest_ramseraph as ir  # noqa: E402
from test_catalog_idempotent import _ds  # noqa: E402


def _ward_parquet(tmp_path: Path) -> Path:
    p = tmp_path / 'SBM_Wards.parquet'
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute(
        "COPY (SELECT 'Ward 3' AS wardname, 'Patna' AS ulbname, "
        "ST_GeomFromText('POLYGON((85.1 25.6, 85.2 25.6, 85.2 25.7, 85.1 25.6))') AS geometry) "
        f"TO '{p}' (FORMAT PARQUET)"
    )
    return p


def test_bake_all_formats_ignores_the_size_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(ir, 'WORK', tmp_path)
    monkeypatch.setattr(ir, 'WHOLE_LAYER_MAX_MB', 0)  # every file is "too big"
    src = _ward_parquet(tmp_path)
    assert ir.bake_whole_layer(_ds(), src) == {}  # default: capped
    out = ir.bake_whole_layer(_ds({'bake_all_formats': True, 'id': 'all'}), src)
    assert set(out) == {'geojson', 'kml', 'shapefile'}


def test_kml_placemarks_are_named_by_the_name_field(tmp_path, monkeypatch):
    monkeypatch.setattr(ir, 'WORK', tmp_path)
    out = ir.bake_whole_layer(_ds({'kml_name_field': 'wardname'}), _ward_parquet(tmp_path))
    assert re.search(r'<name>Ward 3</name>', out['kml'].read_text())


def test_no_upload_never_touches_r2(tmp_path, monkeypatch):
    monkeypatch.setattr(ir, 'WORK', tmp_path)
    src = _ward_parquet(tmp_path)
    monkeypatch.setattr(ir, 'http_download', lambda url, dest: dest.write_bytes(src.read_bytes()))
    monkeypatch.setattr(ir, 'r2_client', lambda: pytest.fail('r2_client called with upload=False'))
    monkeypatch.setattr(ir, 'r2_upload', lambda *a: pytest.fail('r2_upload called with upload=False'))
    calls = []
    monkeypatch.setattr(ir, 'append_manifest', lambda *a: calls.append('manifest'))
    monkeypatch.setattr(ir, 'patch_catalog', lambda *a: calls.append('catalog'))
    ir.ingest(_ds({'pmtiles_url': ''}), upload=False)
    assert calls == []  # nothing recorded as live before the files are on R2


def test_sbm_layers_are_defined_open_and_credited():
    by_id = {d.id: d for d in ir.DATASETS}
    for lid, name_field in (('sbm_wards', 'wardname'), ('sbm_ulbs', 'ulbnm')):
        d = by_id[lid]
        assert d.license == 'CC0-1.0'
        assert d.bake_all_formats and d.kml_name_field == name_field
        assert 'DataMeet' in d.notes and 'Swachh Bharat' in d.source_org
        assert d.parquet_url.endswith('.parquet') and d.pmtiles_url.endswith('.pmtiles')


class _FakeS3:
    """head_object / upload_file stand-in: keeps each key's metadata."""
    class exceptions:
        ClientError = KeyError

    def __init__(self):
        self.objects, self.uploads = {}, 0

    def head_object(self, Bucket, Key):
        return self.objects[Key]

    def upload_file(self, path, bucket, key, ExtraArgs, Config):
        self.uploads += 1
        self.objects[key] = {'ContentLength': Path(path).stat().st_size, 'Metadata': ExtraArgs['Metadata']}


def test_r2_upload_compares_checksums_not_sizes(tmp_path):
    # A lat,lon swap keeps the byte count, so a size match must not skip it.
    f = tmp_path / 'a.geojson'
    s3 = _FakeS3()
    f.write_text('[85.1,25.6]')
    ir.r2_upload(s3, f, 'k')
    ir.r2_upload(s3, f, 'k')
    assert s3.uploads == 1  # unchanged: skipped
    f.write_text('[25.6,85.1]')  # same size, different content
    ir.r2_upload(s3, f, 'k')
    assert s3.uploads == 2


def test_a_new_layer_gets_fetched_at():
    # Cards show "Updated: YYYY-MM-DD" from fetched_at; None hides it.
    import datetime
    c = {}
    ir.merge_layer_into_catalog(c, _ds(), 100, 200, 50)
    assert c['layers'][0]['fetched_at'][:10] == datetime.date.today().isoformat()
    c['layers'][0]['fetched_at'] = '2026-01-01T00:00:00+00:00'
    ir.merge_layer_into_catalog(c, _ds(), 100, 200, 50)
    assert c['layers'][0]['fetched_at'] == '2026-01-01T00:00:00+00:00'  # kept on re-run
