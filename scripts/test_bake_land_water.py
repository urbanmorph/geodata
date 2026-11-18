"""Land and water layers from ramSeraph (Nov 2026): scripts/bake_land_water.py.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_land_water.py -q
"""
from __future__ import annotations

import http.server
import json
import sys
import threading
from pathlib import Path

import duckdb
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_land_water as blw  # noqa: E402
import ingest_ramseraph as ir  # noqa: E402


# ── download: resumable, cached, atomic ─────────────────────────────────

class _RangeHandler(http.server.BaseHTTPRequestHandler):
    body = b''
    requests: list = []
    fail_after: int | None = None  # bytes sent before dropping the connection

    def do_GET(self):  # noqa: N802
        rng = self.headers.get('Range')
        type(self).requests.append(rng)
        start = int(rng.split('=')[1].split('-')[0]) if rng else 0
        if start >= len(self.body):
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{len(self.body)}')
            self.end_headers()
            return
        chunk = self.body[start:]
        self.send_response(206 if rng else 200)
        if rng:
            self.send_header('Content-Range', f'bytes {start}-{len(self.body) - 1}/{len(self.body)}')
        self.send_header('Content-Length', str(len(chunk)))
        self.end_headers()
        if self.fail_after is not None:
            self.wfile.write(chunk[:self.fail_after])
            type(self).fail_after = None
            self.wfile.flush()
            self.connection.close()
            return
        self.wfile.write(chunk)

    def log_message(self, *a):
        pass


@pytest.fixture
def server():
    _RangeHandler.body = bytes(range(256)) * 4096  # 1 MiB
    _RangeHandler.requests = []
    _RangeHandler.fail_after = None
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), _RangeHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{srv.server_port}/f.parquet'
    srv.shutdown()


def test_fetch_downloads_whole_file_atomically(tmp_path, server):
    dest = tmp_path / 'f.parquet'
    blw.fetch(server, dest, retries=0)
    assert dest.read_bytes() == _RangeHandler.body
    assert not list(tmp_path.glob('*.part*'))


def test_fetch_resumes_a_partial_download(tmp_path, server):
    dest = tmp_path / 'f.parquet'
    part = blw.part_path(dest)
    part.write_bytes(_RangeHandler.body[:300_000])  # an earlier run was killed here
    blw.fetch(server, dest, retries=0)
    assert _RangeHandler.requests == ['bytes=300000-']
    assert dest.read_bytes() == _RangeHandler.body


def test_fetch_retries_a_dropped_connection_from_where_it_stopped(tmp_path, server):
    _RangeHandler.fail_after = 100_000
    dest = tmp_path / 'f.parquet'
    blw.fetch(server, dest, retries=2, backoff=0)
    assert dest.read_bytes() == _RangeHandler.body
    assert _RangeHandler.requests[-1] == 'bytes=100000-'


def test_fetch_skips_a_finished_file(tmp_path, server):
    dest = tmp_path / 'f.parquet'
    dest.write_bytes(b'done')
    blw.fetch(server, dest, retries=0)
    assert _RangeHandler.requests == []


# ── cached steps + time limit ──────────────────────────────────────────

def test_cached_step_runs_once_and_writes_atomically(tmp_path):
    out = tmp_path / 'x.parquet'
    calls = []

    def build(part: Path):
        calls.append(part)
        assert part != out and part.suffix == '.parquet'  # real extension last
        part.write_text('ok')

    assert blw.cached(out, build) == out
    assert blw.cached(out, build) == out
    assert len(calls) == 1 and out.read_text() == 'ok'


def test_cached_step_leaves_nothing_behind_on_failure(tmp_path):
    out = tmp_path / 'x.geojson'

    def boom(part: Path):
        part.write_text('half')
        raise RuntimeError('killed')

    with pytest.raises(RuntimeError):
        blw.cached(out, boom)
    assert not out.exists() and not list(tmp_path.iterdir())


def test_deadline_stops_cleanly_between_steps():
    clock = iter([0.0, 10.0, 100.0])
    d = blw.Deadline(minutes=1, clock=lambda: next(clock))
    d.check('download')  # 10 s in
    with pytest.raises(blw.OutOfTime):
        d.check('bake')  # 100 s in, over the 60 s limit


# ── verification ───────────────────────────────────────────────────────

def _gj(tmp_path: Path, coords: list[float]) -> Path:
    p = tmp_path / 'a.geojson'
    p.write_text(json.dumps({'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {}, 'geometry': {'type': 'Point', 'coordinates': coords}}]}))
    return p


def test_first_coordinate_must_be_lon_lat_in_india(tmp_path):
    assert blw.first_coord(_gj(tmp_path, [77.2, 28.6])) == (77.2, 28.6)
    blw.assert_lon_lat(_gj(tmp_path, [77.2, 28.6]))
    with pytest.raises(AssertionError):
        blw.assert_lon_lat(_gj(tmp_path, [28.6, 77.2]))  # lat,lon swap


def test_first_coordinate_skips_empty_geometries(tmp_path, monkeypatch):
    # Groundwater prospect structures carry two LINESTRING(nan nan, ...) rows,
    # which the Hilbert sort puts first in every download.
    monkeypatch.setattr(ir, 'WORK', tmp_path)
    src = tmp_path / 'E.parquet'
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute("COPY (SELECT * FROM (VALUES (1, NULL::GEOMETRY), (2, ST_GeomFromText('LINESTRING(85.1 25.6, 85.2 25.7)'))) "
                f"t(n, geometry)) TO '{src}' (FORMAT PARQUET)")
    out = ir.bake_whole_layer(blw.DATASETS[0], src, tmp_path / 'b', 'E')
    for fmt in ('geojson', 'kml'):
        assert blw.first_coord(out[fmt]) == pytest.approx((85.1, 25.6)), fmt


def test_first_coordinate_of_a_kml_and_a_zipped_shapefile(tmp_path, monkeypatch):
    monkeypatch.setattr(ir, 'WORK', tmp_path)
    src = tmp_path / 'T.parquet'
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute("COPY (SELECT 'a' AS name, ST_Point(85.1, 25.6) AS geometry) "
                f"TO '{src}' (FORMAT PARQUET)")
    out = ir.bake_whole_layer(blw.DATASETS[0], src, tmp_path / 'b', 'T')
    for fmt in ('geojson', 'kml', 'shapefile'):
        assert blw.first_coord(out[fmt]) == pytest.approx((85.1, 25.6)), fmt


def test_tile_bounds_of_a_known_tile():
    # z0 is the whole web-mercator world; z1 x1 y0 is the north-east quarter.
    w, s, e, n = blw.tile_bounds(1, 1, 0)
    assert (w, e) == (0.0, 180.0) and s == pytest.approx(0.0, abs=1e-9) and n > 85


def test_polygon_tiles_coalesce_instead_of_dropping():
    poly = blw.tippecanoe_args(Path('a.geojsonl'), Path('a.pmtiles'), 'lyr', ['Priority'], polygons=True)
    line = blw.tippecanoe_args(Path('a.geojsonl'), Path('a.pmtiles'), 'lyr', ['Priority'], polygons=False)
    assert '--coalesce-densest-as-needed' in poly and '--drop-densest-as-needed' not in poly
    assert '--drop-densest-as-needed' in line
    for args in (poly, line):
        assert args[args.index('-y') + 1] == 'Priority' and args.count('-y') == 1  # popup fields only
        assert '-P' in args and args[args.index('-n') + 1] == 'lyr'


def test_tiles_fail_when_max_zoom_loses_features_or_polygons_leave_holes():
    good = [{'z': 5, 'decoded': 10, 'parquet': 40, 'cover': 0.999},
            {'z': 10, 'decoded': 41, 'parquet': 40, 'cover': 1.0}]
    assert blw.tiles_ok(good, 10, polygons=True)
    holes = [dict(good[0], cover=0.54), good[1]]
    assert not blw.tiles_ok(holes, 10, polygons=True)
    assert blw.tiles_ok(holes, 10, polygons=False)  # lines thin out at low zoom by design
    lost = [good[0], dict(good[1], decoded=39)]
    assert not blw.tiles_ok(lost, 10, polygons=False)


def test_every_layer_has_popup_fields_that_exist_in_its_kml_name():
    for d in blw.DATASETS:
        fields, _ = blw.TILES[d.id]
        assert d.kml_name_field in fields, d.id


# ── the layers ─────────────────────────────────────────────────────────

EXPECT = {
    # id: (category, ATTR source key, release file)
    'slusi_priority_micro_watersheds': ('water', 'SLUSI', 'SLUSI_Priority_MicroWatersheds'),
    'bhuvan_gw_prospect_structures': ('water', 'Bhuvan', 'Bhuvan_Groundwater_Prospects_STRU'),
    'bhuvan_lineaments_50k': ('environment', 'Bhuvan', 'Bhuvan_Lineament_50k_0506'),
    'gsi_lithology_50k': ('environment', 'NGDR', 'NGDR_Lithology_50k'),
    'bhuvan_geomorphology_50k': ('environment', 'Bhuvan', 'Bhuvan_Geomorphology_50k_0506'),
}


PARQUET_AND_TILES_ONLY = {'gsi_lithology_50k', 'bhuvan_geomorphology_50k'}


def test_big_polygon_layers_skip_whole_layer_downloads_and_say_so(tmp_path, monkeypatch):
    import pipeline  # the cap lives in pipeline since #276; ingest_ramseraph only re-exports it
    monkeypatch.setattr(pipeline, 'WHOLE_LAYER_MAX_MB', 0)  # their parquet is over the cap
    by_id = {d.id: d for d in blw.DATASETS}
    for lid in PARQUET_AND_TILES_ONLY:
        assert 'Filter & export' in by_id[lid].notes
    src = tmp_path / 'T.parquet'
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute(f"COPY (SELECT ST_Point(85.1, 25.6) AS geometry) TO '{src}' (FORMAT PARQUET)")
    assert ir.bake_whole_layer(by_id['gsi_lithology_50k'], src, tmp_path / 'b', 'T') == {}


def test_layers_are_republished_under_policy_b_smallest_first():
    from build_catalog import ATTR
    assert [d.id for d in blw.DATASETS] == list(EXPECT)
    existing = {d.id for d in ir.DATASETS}
    for d in blw.DATASETS:
        cat, src, file = EXPECT[d.id]
        assert (d.category, d.source, d.license) == (cat, src, 'CC0-1.0'), d.id
        assert src in ATTR, d.id
        assert d.parquet_url.endswith(f'/{file}.parquet') and d.pmtiles_url.endswith(f'/{file}.pmtiles')
        assert 'sources-and-licensing' in d.notes and 'ramSeraph' in d.notes, d.id
        # The 1:50k polygon layers are parquet + tiles only (GeoJSON was 25.6 GB).
        assert d.bake_all_formats == (d.id not in PARQUET_AND_TILES_ONLY) and d.kml_name_field, d.id
        assert '—' not in d.name + d.description, d.id  # no em-dashes in user copy
        assert d.id not in existing, d.id
        # An exact id never pulls in another layer.
        assert [x.id for x in blw.DATASETS if d.id in x.id] == [d.id]


def test_catalog_patch_touches_only_the_given_root_file_and_is_idempotent(tmp_path):
    cat = tmp_path / 'catalog.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': []}, indent=2) + '\n')
    gj = tmp_path / 'X.geojson'
    gj.write_text('{}')
    d = blw.DATASETS[0]
    blw.patch_root_catalog(d, 10, 20, 3, {'geojson': gj}, catalog=cat)
    first = cat.read_text()
    blw.patch_root_catalog(d, 10, 20, 3, {'geojson': gj}, catalog=cat)
    assert cat.read_text() == first
    layer = json.loads(first)['layers'][0]
    assert (layer['id'], layer['rows'], layer['geojson']['bytes']) == (d.id, 3, 2)
    assert layer['parquet']['url'].endswith(f'{d.r2_prefix}/SLUSI_Priority_MicroWatersheds.parquet')
    assert blw.CATALOG == ir.ROOT / 'catalog.json'


def test_layers_over_two_gigabytes_are_not_ingested():
    # Single-file architecture: parquet over 2 GB is skipped (no per-state split
    # pattern exists for one national layer). Land degradation 2005-06 / 2015-16
    # (3.9 GB each) and groundwater prospect zones (2.7 GB) stay out.
    ids = {d.id for d in blw.DATASETS}
    for skipped in ('bhuvan_land_degradation_0506', 'bhuvan_land_degradation_1516', 'bhuvan_gw_prospects'):
        assert skipped not in ids
    assert all(v['parquet_bytes'] > 2 * 1024**3 for v in blw.SKIPPED.values())


def test_gentle_client_uploads_fewer_parts_at_once_and_keeps_md5_skip():
    class Fake:
        def __init__(self):
            self.cfg = None

        def upload_file(self, path, bucket, key, ExtraArgs, Config):  # noqa: N803
            self.cfg = Config

        def head_object(self, Bucket, Key):  # noqa: N803
            return {'Metadata': {'md5': 'x'}}
    fake = Fake()
    s3 = blw.GentleS3(fake)
    s3.upload_file('p', 'b', 'k', ExtraArgs={}, Config=object())
    assert fake.cfg is blw.GentleS3.TRANSFER and fake.cfg.max_concurrency == 2
    assert s3.head_object(Bucket='b', Key='k')['Metadata']['md5'] == 'x'  # delegated


def test_upload_retries_a_dropped_connection(tmp_path, monkeypatch):
    from botocore.exceptions import SSLError
    calls = []

    def flaky(s3, local, key):
        calls.append(key)
        if len(calls) == 1:
            raise SSLError(endpoint_url='https://r2', error='EOF occurred in violation of protocol')
    monkeypatch.setattr(ir, 'r2_upload', flaky)
    blw.upload(None, tmp_path / 'a.parquet', 'k', retries=2, backoff=0)
    assert calls == ['k', 'k']
