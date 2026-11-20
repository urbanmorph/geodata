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
import pipeline  # noqa: E402
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
    monkeypatch.setattr(pipeline, 'WHOLE_LAYER_MAX_MB', 0)  # every file is "too big"
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
    # fetched_at is UTC; compare with today's UTC date (local today differs 00:00-05:30 IST)
    assert c['layers'][0]['fetched_at'][:10] == datetime.datetime.now(datetime.timezone.utc).date().isoformat()
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
    # Held: traceable originals whose terms require permission. (IR stations
    # and tracks came in later under policy B.)
    for held in ('rbi_bank_branches', 'postal_post_offices'):
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
    monkeypatch.setattr(pipeline, 'DBF_MAX_BYTES', 10)  # every .dbf is "too big"
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


NGDR_UNDERGROUND = {
    # id: (ramSeraph release, file, kml name field)
    'gsi_drilling_boreholes': ('indian_land_features/mining', 'NGDR_Mining_Exploration_Drilling_Boreholes',
                               'borehole_name'),
    'gsi_hydrocarbon_blocks': ('indian_land_features/mining', 'NGDR_Hydrocarbon_Blocks', 'blk_name'),
    'gsi_mineral_deposits': ('indian_land_features/mining', 'NGDR_Mineral_Deposits', 'locality'),
    'gsi_geothermal_springs': ('indian_water_features/natural', 'NGDR_Geothermal_Springs', 'location'),
}


def test_ngdr_underground_layers_are_defined_under_policy_b():
    # NGDR (GSI Bhukosh) states no open licence: the compiler's CC0 applies,
    # crediting GSI, as for coal blocks and critical minerals.
    from build_catalog import ATTR
    by_id = {d.id: d for d in ir.DATASETS}
    for lid, (release, file, name_field) in NGDR_UNDERGROUND.items():
        d = by_id[lid]
        repo, tag = release.split('/')
        base = f'https://github.com/ramSeraph/{repo}/releases/download/{tag}/{file}'
        assert (d.parquet_url, d.pmtiles_url) == (f'{base}.parquet', f'{base}.pmtiles'), lid
        assert (d.category, d.kml_name_field, d.license, d.source) == ('environment', name_field, 'CC0-1.0', 'NGDR'), lid
        assert d.source_url == ATTR['NGDR']['url'] and 'Geological Survey of India' in d.source_org, lid
        assert d.bake_all_formats and 'sources-and-licensing' in d.notes, lid
        assert '—' not in d.name + d.description and 'catalog' not in (d.name + d.description).lower(), lid
        assert [x.id for x in ir.DATASETS if lid in x.id] == [lid]
    # Mining leases (major, minor, other; NGDR and NCOG) name private lessees,
    # many with phones and emails: personal data, still held.
    for held in ('gsi_minor_mining_leases', 'ncog_minor_mining_leases', 'gsi_mining_leases_other'):
        assert held not in by_id


WB_AND_RAILWAYS = {
    # id: (category, kml name field, ATTR source key)
    'wb_amrut_wards': ('city-wards', 'Ward_No', 'WBAMRUT'),
    'wb_amrut_ulbs': ('boundaries', 'Name', 'WBAMRUT'),
    'ir_tracks': ('transport', 'tmssection', 'IRGIS'),
}


def test_ir_stations_is_not_a_ramseraph_ingest():
    # bake_ir_stations_merged.py owns the ir_stations id since 2026-11-18 (the
    # merged CRIS + GatiShakti + Wikidata set replaced the IRGIS-only layer); a
    # ramSeraph re-ingest under that id would overwrite it.
    assert 'ir_stations' not in {d.id for d in ir.DATASETS}


def test_wb_wards_and_railways_are_defined_under_policy_b():
    # West Bengal AMRUT fills the state SBM wards leave out; Indian Railways
    # (irgeoportal, CRIS) was held until policy B. Neither publisher states an
    # open licence, so the compiler's CC0 applies with credit.
    from build_catalog import ATTR
    by_id = {d.id: d for d in ir.DATASETS}
    for lid, (cat, name_field, src) in WB_AND_RAILWAYS.items():
        d = by_id[lid]
        assert (d.category, d.kml_name_field, d.license, d.source) == (cat, name_field, 'CC0-1.0', src), lid
        assert src in ATTR and d.source_url == ATTR[src]['url'], lid
        assert d.bake_all_formats and 'sources-and-licensing' in d.notes, lid
        assert '—' not in d.name + d.description, lid
    # An exact id never pulls in another layer (main() matches substrings).
    for lid in WB_AND_RAILWAYS:
        assert [d.id for d in ir.DATASETS if lid in d.id] == [lid]


def test_ogr2ogr_reads_geojson_features_of_any_size(tmp_path, monkeypatch):
    # One CRZ 2019 line is over GDAL's 200 MB per-feature GeoJSON limit, so the
    # KML and shapefile conversions failed ("GeoJSON object too complex/large").
    import subprocess
    monkeypatch.setattr(ir, 'WORK', tmp_path)
    seen = []
    real_run = subprocess.run

    def spy(cmd, *a, **kw):
        if cmd and cmd[0] == 'ogr2ogr':
            seen.append((kw.get('env') or {}).get('OGR_GEOJSON_MAX_OBJ_SIZE'))
        return real_run(cmd, *a, **kw)
    monkeypatch.setattr(pipeline.subprocess, 'run', spy)
    ir.bake_whole_layer(_ds(), _ward_parquet(tmp_path))
    assert seen and all(v == '0' for v in seen)


def test_a_rerun_does_not_rebake_unchanged_layers(tmp_path, monkeypatch):
    # Every run re-flattened and rebaked every layer; only uploads were skipped.
    monkeypatch.setattr(ir, 'WORK', tmp_path)
    src = _ward_parquet(tmp_path)
    monkeypatch.setattr(ir, 'http_download', lambda url, dest: dest.exists() or dest.write_bytes(src.read_bytes()))
    ds = _ds({'pmtiles_url': '', 'bake_all_formats': True})
    ir.ingest(ds, upload=False)
    work = []
    monkeypatch.setattr(ir, 'rebake_flatten_bbox', lambda *a, **k: work.append('flatten'))
    monkeypatch.setattr(pipeline.subprocess, 'run', lambda cmd, *a, **k: work.append(cmd[0]))
    monkeypatch.setattr(pipeline, 'make_con', lambda: work.append('duckdb'))
    ir.ingest(ds, upload=False)
    assert work == []


def test_one_failing_layer_does_not_stop_the_rest(monkeypatch, capsys):
    done = []

    def ingest(d, upload=True):
        if d.id == 'boom':
            raise RuntimeError('source 503')
        done.append(d.id)
    monkeypatch.setattr(ir, 'ingest', ingest)
    monkeypatch.setattr(ir, 'DATASETS', [_ds({'id': 'boom'}), _ds({'id': 'ok'})])
    assert ir.main(['x', '--no-upload']) == 1
    assert done == ['ok'] and 'boom' in capsys.readouterr().out


def test_a_run_stops_cleanly_at_its_own_time_limit(monkeypatch):
    """--max-minutes: the run stops between layers (finished ones are on R2 and
    in the manifest), so a re-run continues instead of hitting the job limit."""
    done = []
    monkeypatch.setattr(ir, 'ingest', lambda d, upload: done.append(d.id))
    assert ir.main(['x', '--no-upload', '--max-minutes', '0']) == 3
    assert done == []
    assert ir.main(['x', '--no-upload', '--max-minutes', '60', ir.DATASETS[0].id]) == 0
    assert done == [ir.DATASETS[0].id]
