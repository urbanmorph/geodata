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


def test_shapefile_zip_is_byte_identical_across_runs(tmp_path, monkeypatch):
    # Zip entries stored each file's mtime, so every run changed the md5 and
    # re-uploaded unchanged shapefiles.
    import time
    monkeypatch.setattr(ir, 'WORK', tmp_path)
    src = _ward_parquet(tmp_path)
    first = ir.bake_whole_layer(_ds(), src)['shapefile'].read_bytes()
    time.sleep(2.1)  # zip timestamps have 2-second resolution
    second = ir.bake_whole_layer(_ds(), src)['shapefile'].read_bytes()
    assert first == second


def test_facilities_batch_layers_are_defined_with_traced_licences():
    # Hospitals trace to data.gov.in (GODL); schools' original (NCOG) states
    # no terms, so the compiler's CC0 applies. All formats, named Placemarks.
    by_id = {d.id: d for d in ir.DATASETS}
    expect = {
        'nhp_hospitals': ('GODL-India', 'Hospital_Name', 'health-edu'),
        'nin_health_facilities': ('GODL-India', 'health_facility_name', 'health-edu'),
        'udise_schools': ('CC0-1.0', 'school_nam', 'health-edu'),
    }
    for lid, (lic, name_field, cat) in expect.items():
        d = by_id[lid]
        assert (d.license, d.kml_name_field, d.category) == (lic, name_field, cat)
        assert d.bake_all_formats and 'ramSeraph' in d.notes
    # Held: traceable originals whose terms require permission.
    for held in ('rbi_bank_branches', 'postal_post_offices', 'ir_stations', 'ir_tracks'):
        assert held not in by_id


def _two_state_parquet(tmp_path: Path) -> Path:
    p = tmp_path / 'Schools.parquet'
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute(
        "COPY (SELECT * FROM (VALUES ('A School', 'KERALA', ST_Point(76.2, 10.5)), "
        "('B School', 'KERALA', ST_Point(76.3, 10.6)), ('C School', 'BIHAR', ST_Point(85.1, 25.6))) "
        f"t(school_nam, state_name, geometry)) TO '{p}' (FORMAT PARQUET)"
    )
    return p


def test_shapefile_split_by_state_keeps_every_feature(tmp_path, monkeypatch):
    # UDISE's single .dbf was 5.8 GB; most GIS tools refuse a .dbf over 2 GB.
    import zipfile
    monkeypatch.setattr(ir, 'WORK', tmp_path)
    out = ir.bake_whole_layer(_ds({'shp_split_by': 'state_name'}), _two_state_parquet(tmp_path))
    names = sorted(zipfile.ZipFile(out['shapefile']).namelist())
    shps = [n for n in names if n.endswith('.shp')]
    assert shps == ['Test_bihar.shp', 'Test_kerala.shp']  # named from the release file
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    total = sum(con.execute(f"select count(*) from ST_Read('/vsizip/{out['shapefile']}/{s}')").fetchone()[0] for s in shps)
    assert total == 3


def test_a_dbf_over_the_limit_drops_the_shapefile(tmp_path, monkeypatch):
    monkeypatch.setattr(ir, 'WORK', tmp_path)
    monkeypatch.setattr(ir, 'DBF_MAX_BYTES', 10)  # every .dbf is "too big"
    out = ir.bake_whole_layer(_ds(), _two_state_parquet(tmp_path))
    assert 'shapefile' not in out and {'geojson', 'kml'} <= set(out)


def test_rebake_is_byte_identical_with_hilbert_ties(tmp_path):
    # UDISE has many schools at the same point: equal Hilbert keys sorted in
    # parallel came out in a different order each run, so every re-run
    # re-uploaded about 6.7 GB. Ties must break on the source row order.
    import hashlib
    src = tmp_path / 'ties.parquet'
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial; SET threads = 8')
    con.execute(
        "COPY (SELECT i AS id, ST_Point(76 + (i % 50) / 100.0, 10 + (i % 50) / 100.0) AS geometry "
        f"FROM range(400000) t(i)) TO '{src}' (FORMAT PARQUET)")
    digests = set()
    for run in range(3):
        dst = tmp_path / f'out{run}.parquet'
        ir.rebake_flatten_bbox(src, dst)
        digests.add(hashlib.md5(dst.read_bytes()).hexdigest())
    assert len(digests) == 1


def test_shapefile_text_fields_are_resized_not_padded(tmp_path, monkeypatch):
    # Without RESIZE every text field is 80+ chars wide, so a wide layer (FSI
    # beats: 429k rows x 23 columns) blows the 2 GB .dbf limit.
    import zipfile
    monkeypatch.setattr(ir, 'WORK', tmp_path)
    out = ir.bake_whole_layer(_ds(), _ward_parquet(tmp_path))
    dbf = next(n for n in zipfile.ZipFile(out['shapefile']).namelist() if n.endswith('.dbf'))
    head = zipfile.ZipFile(out['shapefile']).read(dbf)[:32 * 8]
    # dBase field descriptors start at byte 32, 32 bytes each; width at offset 16
    widths = {head[32 * i:32 * i + 11].rstrip(b'\0').decode(): head[32 * i + 16] for i in range(1, 3)}
    assert widths['wardname'] <= 10 and widths['ulbname'] <= 10


SIGNIFICANT = {
    # id: (category, kml name field)
    'fsi_circles': ('environment', 'Circle_Nam'), 'fsi_divisions': ('environment', 'Division'),
    'fsi_ranges': ('environment', 'Range'), 'fsi_beats': ('environment', 'Beat_Name'),
    'wildlife_corridors': ('environment', 'name'),
    'crz2019_zones': ('environment', 'category'), 'crz2019_lines': ('environment', 'category'),
    'gw_quality_premonsoon': ('water', 'GWQ'), 'gw_quality_postmonsoon': ('water', 'GWQ'),
    'gsi_geology_2m': ('environment', 'index_'), 'gsi_coal_blocks': ('environment', 'block_name'),
    'gsi_critical_minerals': ('environment', 'locality'), 'gsi_lineaments_250k': ('environment', 'l2descript'),
    'police_stations_ap': ('people', 'police_station_name'), 'police_stations_bihar': ('people', 'PS_NAME'),
    'police_stations_delhi': ('people', 'POL_STN_NM'), 'police_stations_tn': ('people', 'police_station_name'),
    'traffic_police_stations_tn': ('people', 'police_station'), 'police_stations_telangana': ('people', 'PS_Name'),
    'marine_police_stations': ('people', 'vname'),
    'amrit_sarovar_ponds': ('water', 'Name_of_Sarovar'), 'jjm_facilities': ('infrastructure', 'fac_name'),
}


def test_significant_batch_is_defined_under_policy_b():
    # Republished government data (bharatlas.com/about#sources-and-licensing):
    # CC0 from the compiler, crediting the original publisher.
    by_id = {d.id: d for d in ir.DATASETS}
    for lid, (cat, name_field) in SIGNIFICANT.items():
        d = by_id[lid]
        assert (d.category, d.kml_name_field, d.license) == (cat, name_field, 'CC0-1.0'), lid
        assert d.bake_all_formats and 'sources-and-licensing' in d.notes and d.source_org, lid
    # Personal data (lessee names, phones, emails; editor name + mobile) stays out.
    for held in ('gsi_major_mining_leases_2022', 'ncog_major_mining_leases', 'police_stations_rajasthan'):
        assert held not in by_id
