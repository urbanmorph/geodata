"""Shared pipeline helpers (scripts/pipeline.py).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_pipeline.py -q
"""
from __future__ import annotations

import contextlib
import http.server
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pipeline  # noqa: E402


def test_importing_the_library_creates_no_directories():
    # ingest_ramseraph made /tmp/ramseraph at import, so every script that
    # borrowed a helper from it made that directory too.
    code = ('import pathlib, sys; sys.path.insert(0, sys.argv[1])\n'
            'def boom(*a, **k): raise SystemExit("mkdir at import")\n'
            'pathlib.Path.mkdir = boom\n'
            'import pipeline, ingest_ramseraph, bake_formats, bake_extracts\n')
    r = subprocess.run([sys.executable, '-c', code, str(HERE)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_old_import_names_still_work():
    # Other scripts (and ingest scripts on other branches) import these from
    # ingest_ramseraph, bake_formats, bake_extracts and bake_mgnrega_districts.
    import bake_extracts
    import bake_formats
    import bake_mgnrega_districts
    import ingest_ramseraph as ir
    for name in ('BUCKET', 'R2_PUBLIC', 'CONTENT_TYPES', 'r2_client', 'r2_upload', 'file_md5',
                 'rebake_flatten_bbox', 'row_group_size_for', 'bake_whole_layer', 'WHOLE_LAYER_MAX_MB'):
        assert hasattr(ir, name), name
    assert bake_formats.atomic_output is pipeline.atomic_output
    assert bake_extracts.make_con is pipeline.make_con
    assert bake_mgnrega_districts.with_retries is pipeline.with_retries
    assert bake_mgnrega_districts.log is pipeline.log


# ── downloads (review item 3) ────────────────────────────────────────────────

@contextlib.contextmanager
def _server(responses: list):
    """Serve `responses` in order: (status, body) per request; records each request's UA."""
    seen = []

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            seen.append(self.headers.get('User-Agent'))
            status, body = responses.pop(0) if responses else (500, b'')
            self.send_response(status)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f'http://127.0.0.1:{srv.server_address[1]}/f', seen
    finally:
        srv.shutdown()


def test_download_writes_atomically_and_skips_on_rerun(tmp_path):
    dest = tmp_path / 'x.parquet'
    with _server([(200, b'PAR1data')]) as (url, seen):
        assert pipeline.download(url, dest) == 8
        assert pipeline.download(url, dest) == 8  # cached: no second request
    assert dest.read_bytes() == b'PAR1data' and len(seen) == 1
    assert 'Python-urllib' not in seen[0]  # r2.dev refuses urllib's default UA
    assert list(tmp_path.iterdir()) == [dest]  # no .part left behind


def test_download_retries_then_succeeds(tmp_path):
    dest = tmp_path / 'x.bin'
    with _server([(503, b'busy'), (200, b'ok')]) as (url, seen):
        pipeline.download(url, dest, wait=lambda n: None)
    assert dest.read_bytes() == b'ok' and len(seen) == 2


def test_failed_download_leaves_no_file_that_counts_as_done(tmp_path):
    # A killed or failed download left a truncated file, skipped forever after.
    dest = tmp_path / 'x.bin'
    with _server([(404, b'<html>not found</html>')] * 3) as (url, _):
        with pytest.raises(OSError):
            pipeline.download(url, dest, tries=3, wait=lambda n: None)
    assert list(tmp_path.iterdir()) == []


def test_ingest_ramseraph_downloads_through_the_shared_helper():
    import ingest_ramseraph as ir
    import rebake_locate_tiles as rt
    assert ir.http_download is pipeline.download
    assert rt.download is pipeline.download


# ── byte-stable zips (review item 5) ─────────────────────────────────────────

def _zip_twice(tmp_path, make):
    outs = []
    for i, stamp in enumerate((1_000_000_000, 1_700_000_000)):
        d = tmp_path / f'src{i}'
        d.mkdir()
        for name, body in (('x.shp', b'shp'), ('x.dbf', b'dbf')):
            (d / name).write_bytes(body)
            os.utime(d / name, (stamp, stamp))
        out = tmp_path / f'out{i}.shp.zip'
        make(d, out)
        outs.append(out.read_bytes())
    return outs


def test_stable_zip_bytes_do_not_depend_on_file_times(tmp_path):
    a, b = _zip_twice(tmp_path, lambda d, out: pipeline.write_stable_zip(sorted(d.iterdir()), out))
    assert a == b


def test_bake_formats_zip_with_key_is_byte_stable(tmp_path):
    import bake_formats
    a, b = _zip_twice(tmp_path, lambda d, out: bake_formats.zip_with_key(d, out, ['k']))
    assert a == b


def test_whole_layer_shapefile_zip_is_byte_stable(tmp_path, monkeypatch):
    import bake_whole_layer as bwl

    def fake_ogr(cmd, *a, **k):  # ogr2ogr stand-in: write a fixed shapefile set
        shp = Path(cmd[cmd.index('ESRI Shapefile') + 3])
        for ext in ('shp', 'dbf'):
            p = shp.with_suffix(f'.{ext}')
            p.write_bytes(ext.encode())
            os.utime(p, (fake_ogr.stamp, fake_ogr.stamp))
        fake_ogr.stamp += 10_000_000
    fake_ogr.stamp = 1_000_000_000
    monkeypatch.setattr(bwl, 'run', fake_ogr)
    a, b = _zip_twice(tmp_path, lambda d, out: bwl.write_shapefile_zip(d / 'x.geojson', 'x', out))
    assert a == b


# ── freshness (review item 8) ────────────────────────────────────────────────

def test_is_fresh_needs_a_non_empty_output_newer_than_every_source(tmp_path):
    src, out = tmp_path / 'src.parquet', tmp_path / 'out.geojson'
    src.write_bytes(b'x')
    os.utime(src, (2000, 2000))
    assert not pipeline.is_fresh(out, src)  # missing
    out.write_bytes(b'')
    assert not pipeline.is_fresh(out, src)  # empty
    out.write_bytes(b'{}')
    os.utime(out, (1000, 1000))
    assert not pipeline.is_fresh(out, src)  # older than its source: rebake
    os.utime(out, (3000, 3000))
    assert pipeline.is_fresh(out, src)


def _tiny_parquet(path: Path) -> Path:
    con = pipeline.make_con()
    con.execute("COPY (SELECT 'Ward 1' AS wardname, 29 AS state_lgd, ST_Point(77.6, 12.9) AS geometry) "
                f"TO '{path}' (FORMAT PARQUET)")
    return path


def test_whole_layer_rebakes_an_output_older_than_its_source(tmp_path, monkeypatch):
    # "Skip if size > 0" kept stale (or partial) downloads after a source refresh.
    import bake_whole_layer as bwl
    monkeypatch.setattr(bwl, 'OUT', tmp_path / 'baked')
    pq = _tiny_parquet(tmp_path / 'w.parquet')
    paths = bwl.out_paths('p', 'w')
    paths['geojson'].parent.mkdir(parents=True)
    paths['geojson'].write_text('stale')
    os.utime(paths['geojson'], (1000, 1000))
    written, skipped, errors = bwl.bake_one(pipeline.make_con(), 'w', pq, 'p', 'w', True, False)
    assert errors == [] and written == 2  # geojson + kml rebuilt
    assert 'Ward 1' in paths['geojson'].read_text()
    written, skipped, _ = bwl.bake_one(pipeline.make_con(), 'w', pq, 'p', 'w', True, False)
    assert written == 0 and skipped == 3  # second run: nothing to do


def test_whole_layer_failure_leaves_no_partial_output(tmp_path, monkeypatch):
    import bake_whole_layer as bwl
    monkeypatch.setattr(bwl, 'OUT', tmp_path / 'baked')

    def half_then_die(con, parquet, out, gdal_ok):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text('{"type":"FeatureCollection","features":[')
        raise RuntimeError('killed')
    monkeypatch.setattr(bwl, 'write_geojson_whole', half_then_die)
    pq = _tiny_parquet(tmp_path / 'w.parquet')
    _, _, errors = bwl.bake_one(None, 'w', pq, 'p', 'w', True, False)
    assert errors and not bwl.out_paths('p', 'w')['geojson'].exists()


def test_per_state_extract_skip_needs_a_fresh_output(tmp_path):
    src, out = tmp_path / 'src.parquet', tmp_path / 'out.parquet'
    src.write_bytes(b'x')
    out.write_bytes(b'y')
    os.utime(out, (1000, 1000))
    assert not pipeline.is_fresh(out, src)
    os.utime(out, (src.stat().st_mtime + 10,) * 2)
    assert pipeline.is_fresh(out, src)


# ── GeoJSON -> parquet / pmtiles converters (review items 13, 22) ────────────

def _tiny_geojson(path: Path) -> Path:
    path.write_text('{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"A"},'
                    '"geometry":{"type":"Point","coordinates":[77.6,12.9]}}]}')
    return path


def test_geojson_to_parquet_adds_the_nearby_bbox_columns(tmp_path):
    out = tmp_path / 'o.parquet'
    assert pipeline.geojson_to_parquet(_tiny_geojson(tmp_path / 'i.geojson'), out, geometry_name='geometry') == 1
    cols = [c[0] for c in pipeline.make_con().execute(f"DESCRIBE SELECT * FROM '{out}'").fetchall()]
    assert {'xmin', 'ymin', 'xmax', 'ymax', 'geometry', 'name'} <= set(cols)
    assert not list(tmp_path.glob('*.raw.parquet'))


def test_geojson_to_parquet_adds_no_reader_column(tmp_path):
    # DuckDB's ST_Read numbers features as OGC_FID; that is not the source's data.
    out = tmp_path / 'o.parquet'
    pipeline.geojson_to_parquet(_tiny_geojson(tmp_path / 'i.geojson'), out, geometry_name='geometry')
    cols = [c[0] for c in pipeline.make_con().execute(f"DESCRIBE SELECT * FROM '{out}'").fetchall()]
    assert cols == ['name', 'geometry', 'xmin', 'ymin', 'xmax', 'ymax']


def test_judiciary_parquet_gets_bbox_columns_for_nearby(tmp_path):
    # bake_judiciary wrote plain ST_Read parquet: no bbox columns, no Hilbert order.
    import bake_judiciary as bj
    out = tmp_path / 'hc.parquet'
    bj.geojson_to_parquet(pipeline.make_con(), _tiny_geojson(tmp_path / 'hc.geojson'), out)
    cols = [c[0] for c in pipeline.make_con().execute(f"DESCRIBE SELECT * FROM '{out}'").fetchall()]
    assert {'xmin', 'ymin', 'xmax', 'ymax'} <= set(cols)


def _popup_geojson(path: Path) -> Path:
    """A feature with a name, a code, a GIS artefact and flat bbox columns."""
    path.write_text('{"type": "FeatureCollection", "features": [{"type": "Feature", "properties": '
                    '{"name": "Patna HC", "code": 7, "Shape_Area": 1.5, "OBJECTID": 3, "xmin": 85.0, '
                    '"ymax": 25.7}, "geometry": {"type": "Point", "coordinates": [85.1, 25.6]}}]}')
    return path


def test_popup_fields_of_a_geojson_leave_out_artefacts_and_bbox(tmp_path):
    import bake_formats
    assert bake_formats.geojson_popup_fields(_popup_geojson(tmp_path / 'p.geojson')) == ['name', 'code', 'OBJECTID']


def test_judiciary_and_community_tiles_carry_popup_fields_only(tmp_path, monkeypatch):
    import bake_community as bc
    import bake_formats
    import bake_judiciary as bj
    seen = []
    monkeypatch.setattr(pipeline, 'run', lambda cmd, *a, **k: seen.append(cmd))
    monkeypatch.setattr(bc, '_run', lambda cmd: seen.append(cmd))
    gj, out = _popup_geojson(tmp_path / 'high_courts.geojson'), tmp_path / 'o.pmtiles'
    bj.geojson_to_pmtiles(gj, out)
    bc.geojson_to_pmtiles(gj, out, 'c_x')
    fields = ['name', 'code', 'OBJECTID']
    assert seen == [bake_formats.pmtiles_args(gj, out, 'high_courts', fields),
                    bake_formats.pmtiles_args(gj, out, 'c_x', fields)]


# ── R2 uploads (review items 1, 11) ──────────────────────────────────────────

class FakeS3:
    class exceptions:  # noqa: N801
        ClientError = KeyError

    def __init__(self, head=None):
        self.head, self.puts = head, []

    def head_object(self, Bucket, Key):  # noqa: N803
        if self.head is None:
            raise KeyError(Key)
        return self.head

    def upload_file(self, path, bucket, key, ExtraArgs, Config):  # noqa: N803
        self.puts.append((key, ExtraArgs))


def test_r2_upload_skips_on_md5_not_size(tmp_path):
    f = tmp_path / 'a.geojson'
    f.write_bytes(b'{"x":[85.1,25.6]}')
    same_size = FakeS3({'ContentLength': f.stat().st_size, 'Metadata': {'md5': 'x' * 32}, 'ETag': '"y"'})
    pipeline.r2_upload(same_size, f, 'k/a.geojson')
    assert len(same_size.puts) == 1
    match = FakeS3({'Metadata': {'md5': pipeline.file_md5(f)}})
    pipeline.r2_upload(match, f, 'k/a.geojson')
    assert match.puts == []


class FakeClientError(Exception):
    """Stands in for botocore's ClientError: not a KeyError, so a missing key in a
    response is a crash here too, as it is against real R2."""


class FakeMultipartS3:
    """Multipart stand-in; `fail_parts` lose their connection every time."""
    class exceptions:  # noqa: N801
        ClientError = FakeClientError

    def __init__(self, fail_parts=()):
        self.objects, self.pending, self.sent, self.completed = {}, {}, [], 0
        self.fail_parts = set(fail_parts)

    def head_object(self, Bucket, Key):  # noqa: N803
        if Key not in self.objects:
            raise FakeClientError('404 Not Found')
        return self.objects[Key]

    def create_multipart_upload(self, Bucket, Key, **extra):  # noqa: N803
        uid = f'u{len(self.pending) + 1}'
        self.pending[uid] = {'extra': extra, 'parts': {}}
        return {'UploadId': uid}

    def upload_part(self, Bucket, Key, PartNumber, UploadId, Body):  # noqa: N803
        if PartNumber in self.fail_parts:
            raise ConnectionResetError('connection dropped')
        self.sent.append(PartNumber)
        self.pending[UploadId]['parts'][PartNumber] = Body
        return {'ETag': f'"e{PartNumber}"'}

    def list_parts(self, Bucket, Key, UploadId, MaxParts):  # noqa: N803
        if UploadId not in self.pending:
            raise FakeClientError('NoSuchUpload')
        parts = [{'PartNumber': n, 'ETag': f'"e{n}"'} for n in sorted(self.pending[UploadId]['parts'])]
        return {'Parts': parts} if parts else {}  # like R2: no 'Parts' key before the first part lands

    def complete_multipart_upload(self, Bucket, Key, UploadId, MultipartUpload):  # noqa: N803
        up = self.pending.pop(UploadId)
        assert [p['PartNumber'] for p in MultipartUpload['Parts']] == sorted(up['parts'])
        self.completed += 1
        self.objects[Key] = {'Metadata': up['extra']['Metadata'], 'extra': up['extra'],
                             'body': b''.join(up['parts'][n] for n in sorted(up['parts']))}


def test_resumable_upload_continues_after_a_dropped_run_and_then_skips(tmp_path):
    f = tmp_path / 'big.geojson'
    f.write_bytes(bytes(range(256)) * 10)          # 2,560 bytes -> 3 parts of 1,000
    state = tmp_path / 'state'
    s3 = FakeMultipartS3(fail_parts={2})
    with pytest.raises(ConnectionResetError):
        pipeline.r2_upload_resumable(s3, f, 'k/big.geojson', state, part_size=1000, tries=2, wait=lambda n: None)
    assert s3.sent == [1] and 'k/big.geojson' not in s3.objects
    s3.fail_parts.clear()
    s3.sent.clear()
    pipeline.r2_upload_resumable(s3, f, 'k/big.geojson', state, part_size=1000, wait=lambda n: None)
    assert s3.sent == [2, 3]                         # resumed: part 1 not sent again
    obj = s3.objects['k/big.geojson']
    assert obj['body'] == f.read_bytes() and obj['Metadata'] == {'md5': pipeline.file_md5(f)}
    assert obj['extra']['ContentDisposition'] == 'attachment; filename="big.geojson"'
    assert not list(state.glob('*.json'))            # state removed once complete
    pipeline.r2_upload_resumable(s3, f, 'k/big.geojson', state, part_size=1000)
    assert s3.completed == 1                         # unchanged file: skipped by md5


def test_resumable_upload_resumes_a_run_that_dropped_before_its_first_part(tmp_path):
    # 2026-11-18: the 2.4 GB water-bodies geojson's saved upload had 0 parts;
    # R2's ListParts then has no 'Parts' key and the resume crashed (KeyError).
    f = tmp_path / 'big.geojson'
    f.write_bytes(bytes(range(256)) * 10)
    state = tmp_path / 'state'
    s3 = FakeMultipartS3(fail_parts={1})
    with pytest.raises(ConnectionResetError):
        pipeline.r2_upload_resumable(s3, f, 'k/big.geojson', state, part_size=1000, tries=2, wait=lambda n: None)
    assert s3.sent == []
    s3.fail_parts.clear()
    pipeline.r2_upload_resumable(s3, f, 'k/big.geojson', state, part_size=1000, wait=lambda n: None)
    assert s3.sent == [1, 2, 3] and s3.objects['k/big.geojson']['body'] == f.read_bytes()


def test_r2_upload_trusts_a_single_part_etag_when_no_md5_metadata(tmp_path):
    # Objects put by upload_baked.py / wrangler carry no md5 metadata; a
    # single-part ETag is the MD5, so an unchanged file is still skipped.
    f = tmp_path / 'a.kml'
    f.write_bytes(b'<kml/>')
    s3 = FakeS3({'Metadata': {}, 'ETag': f'"{pipeline.file_md5(f)}"'})
    pipeline.r2_upload(s3, f, 'k/a.kml')
    assert s3.puts == []
    multipart = FakeS3({'Metadata': {}, 'ETag': f'"{pipeline.file_md5(f)}-3"'})
    pipeline.r2_upload(multipart, f, 'k/a.kml')
    assert len(multipart.puts) == 1


def test_r2_upload_serves_downloads_as_attachments_and_tiles_inline(tmp_path):
    s3 = FakeS3()
    for name in ('a.parquet', 'a.geojson', 'a.kml', 'a.shp.zip', 'a.pmtiles'):
        (tmp_path / name).write_bytes(b'x')
        pipeline.r2_upload(s3, tmp_path / name, f'k/{name}')
    disp = {k: e['ContentDisposition'] for k, e in s3.puts}
    assert disp['k/a.pmtiles'] == 'inline'  # MapLibre range-reads it
    for name in ('a.parquet', 'a.geojson', 'a.kml', 'a.shp.zip'):
        assert disp[f'k/{name}'] == f'attachment; filename="{name}"'
    assert {k: e['ContentType'] for k, e in s3.puts}['k/a.shp.zip'] == 'application/zip'


def test_upload_baked_goes_through_the_md5_upload(tmp_path, monkeypatch):
    # It skipped on a matching size, which misses a lat,lon swap (Patna).
    import upload_baked as ub
    files = []
    for name in ('a.geojson', 'b.parquet'):
        (tmp_path / name).write_bytes(b'x')
        files.append((tmp_path / name, f'k/{name}', 1))
    monkeypatch.setattr(ub, 'collect_local_files', lambda: files)
    monkeypatch.setattr(ub, 'r2_client', lambda: 'S3')
    calls = []
    monkeypatch.setattr(ub, 'r2_upload', lambda s3, path, key: calls.append((s3, path.name, key)))
    for k in ('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_ACCOUNT_ID'):
        monkeypatch.setenv(k, 'x')
    assert ub.main([]) == 0
    assert calls == [('S3', 'a.geojson', 'k/a.geojson'), ('S3', 'b.parquet', 'k/b.parquet')]


def test_upload_r2_sh_maps_files_to_keys_and_hands_them_to_the_md5_uploader(tmp_path):
    # upload_r2.sh compared sizes too; it now only lists (local, key) pairs.
    (tmp_path / 'sources' / 'india-geodata').mkdir(parents=True)
    (tmp_path / 'sources' / 'india-geodata' / 'LGD_Districts.parquet').write_bytes(b'x')
    (tmp_path / 'data' / 'extracts' / 'districts' / '29').mkdir(parents=True)
    (tmp_path / 'data' / 'extracts' / 'districts' / '29' / 'districts_ka.kml').write_bytes(b'x')
    r = subprocess.run(['bash', str(HERE / 'upload_r2.sh'), '--list'], capture_output=True, text=True,
                       env={**os.environ, 'GEODATA_ROOT': str(tmp_path)})
    assert r.returncode == 0, r.stderr
    pairs = [line.split('\t') for line in r.stdout.splitlines()]
    root = str(tmp_path)
    assert [f'{root}/sources/india-geodata/LGD_Districts.parquet', 'admin/districts/LGD_Districts.parquet'] in pairs
    assert [f'{root}/data/extracts/districts/29/districts_ka.kml', 'extracts/districts/29/districts_ka.kml'] in pairs
    text = (HERE / 'upload_r2.sh').read_text()
    assert 'upload_baked.py' in text and 'remote_size' not in text
    assert not (HERE / 'upload_r2_multipart.py').exists()  # r2_upload does multipart itself


# ── one copy of the R2 constants and helpers (review items 16, 20) ───────────

def test_find_parquet_looks_in_sources_then_data_baked(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, 'ROOT', tmp_path)
    baked = tmp_path / 'data' / 'baked' / 'admin' / 'wards-x' / 'wards_x.parquet'
    baked.parent.mkdir(parents=True)
    baked.write_bytes(b'x')
    layer = {'parquet': {'url': f'{pipeline.R2_PUBLIC}/admin/wards-x/wards_x.parquet'}}
    assert pipeline.find_parquet(layer) == baked
    src = tmp_path / 'sources' / 'india-geodata' / 'wards_x.parquet'
    src.parent.mkdir(parents=True)
    src.write_bytes(b'x')
    assert pipeline.find_parquet(layer) == src
    assert pipeline.find_parquet({'parquet': None}) is None


def test_build_scripts_share_the_r2_constants_and_helpers():
    import build_api_indexes
    import build_catalog
    import build_ward_index
    assert build_catalog.R2 == pipeline.R2_PUBLIC
    assert build_api_indexes.find_parquet is pipeline.find_parquet
    assert build_ward_index.find_parquet is pipeline.find_parquet
    assert not hasattr(build_catalog, '_load_prev_layers')  # no callers anywhere


# ── catalog patching (review items 6, 7) ─────────────────────────────────────

def test_upsert_by_id_replaces_in_place_and_appends_new():
    rows = [{'id': 'a', 'v': 1}, {'id': 'b', 'v': 1}, {'id': 'c', 'v': 1}]
    assert pipeline.upsert_by_id(rows, {'id': 'b', 'v': 2}) == [
        {'id': 'a', 'v': 1}, {'id': 'b', 'v': 2}, {'id': 'c', 'v': 1}]
    assert [r['id'] for r in pipeline.upsert_by_id(rows, {'id': 'd'})] == ['a', 'b', 'c', 'd']


def test_upsert_layer_keeps_position_and_first_fetched_at():
    catalog = {'layers': [{'id': 'x', 'fetched_at': '2026-01-01T00:00:00+00:00'}, {'id': 'y'}],
               'level_meta': {}, 'level_order': ['x', 'y'], 'categories': {'a': 'A', 'other': 'Other'}}
    entry = {'id': 'x', 'rows': 5, 'fetched_at': '2026-11-17T00:00:00+00:00'}
    pipeline.upsert_layer(catalog, entry, level_meta={'label': 'X'},
                          attribution=('S', {'name': 's'}), category=('economy', 'Economy'))
    assert catalog['layers'][0] == {'id': 'x', 'rows': 5, 'fetched_at': '2026-01-01T00:00:00+00:00'}
    assert catalog['level_order'] == ['x', 'y'] and catalog['level_meta']['x'] == {'label': 'X'}
    assert catalog['attribution']['S'] == {'name': 's'}
    assert list(catalog['categories']) == ['a', 'economy', 'other']  # 'other' stays last


def test_register_layer_keeps_rebaked_tiles_on_a_rerun(tmp_path):
    """Re-registering a bake (same data) must not point the layer back at the
    bake's own tiles: rebake_tiles.py's tiles carry the Filter panel's columns."""
    r2 = 'https://pub.r2.dev'
    rebaked = {'url': f'{r2}/e/X.c08c0de4.pmtiles', 'bytes': 7}
    parquet = {'url': f'{r2}/e/X.11111111.parquet', 'bytes': 3}
    catalog, manifest = tmp_path / 'catalog.json', tmp_path / 'manifest.json'
    catalog.write_text(json.dumps({'layers': [{'id': 'x', 'parquet': parquet, 'pmtiles': rebaked,
                                               'fetched_at': '2026-01-01'}]}))
    manifest.write_text('[]')
    entry = {'id': 'x', 'parquet': dict(parquet), 'pmtiles': {'url': f'{r2}/e/X.99999999.pmtiles', 'bytes': 9}}
    pipeline.register_layer(catalog, manifest, entry, {'id': 'x'}, {'label': 'X'})
    layer = json.loads(catalog.read_text())['layers'][0]
    assert layer['pmtiles'] == rebaked
    assert layer['fetched_at'] == '2026-01-01'


def test_versioned_names_name_each_file_by_its_content(tmp_path):
    a, b = tmp_path / 'X.parquet', tmp_path / 'X.shp.zip'
    a.write_bytes(b'one')
    b.write_bytes(b'two')
    names = pipeline.versioned_names({'parquet': a, 'shapefile': b})
    assert names == {'parquet': f'X.{pipeline.file_md5(a)[:8]}.parquet',
                     'shapefile': f'X.{pipeline.file_md5(b)[:8]}.shp.zip'}


def test_upload_versioned_names_each_key_by_content_and_is_stable(tmp_path):
    a = tmp_path / 'X.parquet'
    a.write_bytes(b'one')
    keys = []
    names = pipeline.upload_versioned('S3', {'parquet': a}, 'e/x', put=lambda s3, p, k: keys.append(k))
    assert keys == [f'e/x/{names["parquet"]}'] and names['parquet'] == f'X.{pipeline.file_md5(a)[:8]}.parquet'
    assert pipeline.upload_versioned('S3', {'parquet': a}, 'e/x', put=lambda s3, p, k: keys.append(k)) == names
    a.write_bytes(b'two')  # new content, new key
    assert pipeline.upload_versioned('S3', {'parquet': a}, 'e/x', put=lambda *_: None) != names


def test_upsert_layer_stamps_a_new_layer_once():
    catalog = {'layers': []}
    pipeline.upsert_layer(catalog, {'id': 'n'}, level_meta={})
    stamp = catalog['layers'][0]['fetched_at']
    assert stamp
    pipeline.upsert_layer(catalog, {'id': 'n', 'fetched_at': 'later'}, level_meta={})
    assert catalog['layers'][0]['fetched_at'] == stamp and catalog['level_order'] == ['n']


def test_write_json_ends_with_a_newline(tmp_path):
    p = tmp_path / 'm.json'
    pipeline.write_json(p, [{'id': 'a', 'name': 'ā'}])
    assert p.read_text().endswith(']\n') and '\\u0101' in p.read_text()


# ── durable cache backup to R2 (review item 10) ─────────────────────────────

class FakeBucket:
    """list_objects_v2 / upload_file / download_file over a dict, paged two
    keys at a time so the listing's continuation is exercised."""
    class exceptions:  # noqa: N801
        ClientError = KeyError

    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.extra: dict[str, dict] = {}

    def list_objects_v2(self, Bucket, Prefix, **kw):  # noqa: N803
        keys = sorted(k for k in self.objects if k.startswith(Prefix))
        start = int(kw.get('ContinuationToken') or 0)
        page = keys[start:start + 2]
        out = {'KeyCount': len(page), 'IsTruncated': start + 2 < len(keys),
               'Contents': [{'Key': k, 'ETag': f'"{pipeline.hashlib.md5(self.objects[k]).hexdigest()}"',
                             'Size': len(self.objects[k])} for k in page]}
        if out['IsTruncated']:
            out['NextContinuationToken'] = str(start + 2)
        return out

    def upload_file(self, path, bucket, key, ExtraArgs=None, Config=None):  # noqa: N803
        self.objects[key] = Path(path).read_bytes()
        self.extra[key] = ExtraArgs

    def download_file(self, bucket, key, path):
        Path(path).write_bytes(self.objects[key])


def _cache(tmp_path):
    d = tmp_path / 'raw'
    (d / 'a').mkdir(parents=True)
    (d / 'a' / 'p1.json.gz').write_bytes(b'one')
    (d / 'p2.json').write_bytes(b'two')
    (d / 'p3.json').write_bytes(b'three')
    (d / 'p4.json.part').write_bytes(b'half')       # a write in progress: never backed up
    return d


def test_checkpoint_cache_uploads_under_cache_prefix_and_skips_unchanged(tmp_path):
    d, s3 = _cache(tmp_path), FakeBucket()
    assert pipeline.checkpoint_cache(d, 'bake_x', s3) == 3
    assert sorted(s3.objects) == ['cache/bake_x/a/p1.json.gz', 'cache/bake_x/p2.json', 'cache/bake_x/p3.json']
    assert s3.extra['cache/bake_x/p2.json']['CacheControl'] == 'no-cache'
    assert pipeline.checkpoint_cache(d, 'bake_x', s3) == 0     # md5 match: nothing re-sent
    (d / 'p2.json').write_bytes(b'two, changed')
    (d / 'p5.json').write_bytes(b'five')
    assert pipeline.checkpoint_cache(d, 'bake_x', s3) == 2
    assert s3.objects['cache/bake_x/p2.json'] == b'two, changed'


def test_restore_cache_fetches_only_missing_files(tmp_path):
    d, s3 = _cache(tmp_path), FakeBucket()
    pipeline.checkpoint_cache(d, 'bake_x', s3)
    fresh = tmp_path / 'fresh'
    fresh.mkdir()
    (fresh / 'p2.json').write_bytes(b'local wins')
    assert pipeline.restore_cache(fresh, 'bake_x', s3) == 2
    assert (fresh / 'a' / 'p1.json.gz').read_bytes() == b'one'
    assert (fresh / 'p2.json').read_bytes() == b'local wins'
    assert pipeline.restore_cache(fresh, 'bake_x', s3) == 0     # second run: no work
    assert not list(fresh.rglob('*.part*'))


def test_cache_backup_restores_checkpoints_at_intervals_and_on_failure(tmp_path):
    d, s3 = _cache(tmp_path), FakeBucket()
    s3.objects['cache/job/old.json'] = b'from an earlier run'
    with pytest.raises(RuntimeError):
        with pipeline.cache_backup(d, 'job', s3, every_s=0.05):
            assert (d / 'old.json').read_bytes() == b'from an earlier run'
            (d / 'new.json').write_bytes(b'answer')
            for _ in range(200):                      # wait for an interval checkpoint
                if 'cache/job/new.json' in s3.objects:
                    break
                threading.Event().wait(0.02)
            assert 'cache/job/new.json' in s3.objects
            (d / 'last.json').write_bytes(b'saved on the way out')
            raise RuntimeError('killed mid-run')
    assert s3.objects['cache/job/last.json'] == b'saved on the way out'


def _recording_backup(seen):
    @contextlib.contextmanager
    def fake(local_dir, prefix, *a, **k):
        seen.append(('enter', local_dir, prefix))
        yield
        seen.append(('exit',))
    return fake


@pytest.mark.parametrize('name, prefix', [
    ('bake_mgnrega_districts', 'bake_mgnrega_districts'),
    ('bake_state_finance', 'bake_state_finance'),
    ('bake_wbc1_water_bodies', 'bake_wbc1_water_bodies'),
    ('bake_cityfinance_ulbs', 'cityfinance'),
    ('bake_cityfinance_balance_sheet', 'cityfinance'),
])
def test_pull_steps_run_inside_a_cache_backup(monkeypatch, name, prefix):
    import importlib
    mod = importlib.import_module(name)
    seen = []
    monkeypatch.setattr(mod, 'cache_backup', _recording_backup(seen))
    monkeypatch.setattr(mod, 'pull', lambda *a, **k: seen.append(('pull',)) or True)
    monkeypatch.setattr(sys, 'argv', [name, 'pull'])
    with contextlib.suppress(SystemExit):
        mod.main()
    assert [s[0] for s in seen] == ['enter', 'pull', 'exit']
    assert seen[0][1:] == (mod.RAW, prefix)


def test_fetch_osm_areas_runs_inside_a_cache_backup(monkeypatch, tmp_path):
    import build_ward_index
    import fetch_osm_areas
    (tmp_path / 'catalog.json').write_text('{"layers": []}')
    monkeypatch.setattr(build_ward_index, 'CATALOG', tmp_path / 'catalog.json')
    seen = []
    monkeypatch.setattr(fetch_osm_areas, 'cache_backup', _recording_backup(seen))
    monkeypatch.setattr(sys, 'argv', ['fetch_osm_areas'])
    assert fetch_osm_areas.main() == 0
    assert seen == [('enter', fetch_osm_areas.CACHE, 'fetch_osm_areas'), ('exit',)]


@pytest.mark.parametrize('name', ['bake_pmtiles'])
def test_one_off_scripts_still_import_from_scripts_oneoff(name):
    # Importing runs nothing; it checks their paths into scripts/ still resolve.
    code = (f'import importlib.util as u; s = u.spec_from_file_location("m", "{HERE}/oneoff/{name}.py"); '
            'm = u.module_from_spec(s); s.loader.exec_module(m); '
            f'assert getattr(m, "ROOT", None) in (None, __import__("pathlib").Path("{HERE.parent}"))')
    r = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_the_content_disposition_backfill_refuses_to_run():
    """Its job is done (pipeline._put_args sets the header on every upload), and a
    re-run would copy_object(MetadataDirective='REPLACE') over published keys,
    dropping their md5 metadata and immutable Cache-Control. It must stop before
    it imports boto3 or reads credentials."""
    code = ('import sys; sys.modules["boto3"] = None; '
            f'exec(compile(open("{HERE}/oneoff/fix_r2_content_disposition.py").read(), "f", "exec"), '
            '{"__name__": "__main__"})')
    env = {**os.environ, 'CLOUDFLARE_ACCOUNT_ID': 'x', 'R2_ACCESS_KEY_ID': 'x', 'R2_SECRET_ACCESS_KEY': 'x'}
    r = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, env=env)
    assert r.returncode == 1 and 'refuses to run' in r.stderr, r.stderr


def test_cache_backup_without_r2_credentials_is_local_only(tmp_path, monkeypatch):
    for k in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'):
        monkeypatch.delenv(k, raising=False)
    d = _cache(tmp_path)
    with pipeline.cache_backup(d, 'job'):
        (d / 'x.json').write_text('{}')
    assert (d / 'x.json').exists()


def test_read_head_reads_only_the_first_bytes(tmp_path):
    f = tmp_path / 'x.pmtiles'
    f.write_bytes(b'PMTiles' + b'\0' * 1000)
    assert pipeline.read_head(f, 7) == b'PMTiles'


def test_no_script_loads_a_whole_file_to_look_at_its_first_bytes():
    here = Path(__file__).resolve().parent
    offenders = [p.name for p in here.glob('*.py')
                 if not p.name.startswith('test_') and 'read_bytes()[' in p.read_text()]
    assert offenders == []


def test_judiciary_bake_fails_loudly_and_leaves_no_partial_file(tmp_path, monkeypatch):
    """A failed format used to print FAIL and exit 0, so a partial bake looked done."""
    import bake_judiciary as bj
    src = tmp_path / 'LGD_States.parquet'
    src.write_bytes(b'x')
    monkeypatch.setattr(bj, 'SRC', src)
    monkeypatch.setattr(bj, 'OUT', tmp_path / 'out')
    monkeypatch.setattr(bj, 'make_con', lambda: None)
    monkeypatch.setattr(bj, 'dissolve_layer', lambda con, s, lookup, kind, out: out.write_text('{}'))

    def half_written(con, gj, out):
        out.write_text('half')
        raise RuntimeError('disk full')
    monkeypatch.setattr(bj, 'geojson_to_parquet', half_written)
    for name in ('geojson_to_pmtiles', 'write_shapefile_zip'):
        monkeypatch.setattr(bj, name, lambda gj, *a: a[-1].write_text('ok'))
    monkeypatch.setattr(bj, 'write_kml_from_geojson', lambda gj, name, out: out.write_text('ok'))
    assert bj.main() == 1
    out = tmp_path / 'out'
    assert not list(out.glob('*.parquet')) and not list(out.glob('*.part*'))
    assert (out / 'high_courts.kml').exists()
