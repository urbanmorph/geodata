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


def test_upload_retries_a_dropped_connection(tmp_path, monkeypatch):
    from botocore.exceptions import SSLError
    calls = []

    def flaky(s3, local, key, state_dir):
        calls.append(key)
        if len(calls) == 1:
            raise SSLError(endpoint_url='https://r2', error='EOF occurred in violation of protocol')
    monkeypatch.setattr(blw.pipeline, 'r2_upload_resumable', flaky)
    blw.upload(None, tmp_path / 'a.parquet', 'k', retries=2, backoff=0)
    assert calls == ['k', 'k']


def test_upload_lock_waits_for_another_job_and_is_released_on_failure(tmp_path):
    lock = tmp_path / 'upload.lock'
    lock.mkdir()  # another job (tile rebakes) holds it
    threading.Timer(0.2, lock.rmdir).start()
    with pytest.raises(RuntimeError):
        with blw.upload_lock(lock, wait=0.05):
            assert lock.is_dir()
            raise RuntimeError('upload failed')
    assert not lock.exists()


def test_publish_uploads_resumably_under_the_lock_then_registers(tmp_path, monkeypatch):
    lock = tmp_path / 'upload.lock'
    monkeypatch.setattr(blw, 'UPLOAD_LOCK', lock)
    monkeypatch.setattr(blw, 'r2_client', lambda: 's3')
    seen, registered = [], []

    def fake_upload(s3, local, key, state_dir):
        # md5 skip + multipart resume live in r2_upload_resumable (test_pipeline.py)
        assert lock.is_dir() and state_dir == blw.WORK / 'r2-uploads'
        seen.append(key)
    monkeypatch.setattr(blw.pipeline, 'r2_upload_resumable', fake_upload)
    monkeypatch.setattr(blw, 'register', lambda d, built: registered.append(d.id))
    d = blw.DATASETS[0]
    a, b = tmp_path / 'X.parquet', tmp_path / 'X.pmtiles'
    blw.publish(d, {'files': {a: 'X.parquet', b: 'X.pmtiles'}, 'features': 1, 'bakes': {}})
    assert seen == [f'{d.r2_prefix}/X.parquet', f'{d.r2_prefix}/X.pmtiles']
    assert registered == [d.id] and not lock.exists()


# ── dissolved low-zoom overview for dense polygon layers ───────────────

def _squares(tmp_path: Path) -> Path:
    """Three 0.1-degree squares in a row: A, A, B (the two A's dissolve into one)."""
    src = tmp_path / 'S.parquet'
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute(f"""COPY (SELECT cls, other, geometry, ST_XMin(geometry) xmin, ST_YMin(geometry) ymin,
                         ST_XMax(geometry) xmax, ST_YMax(geometry) ymax FROM (VALUES
        ('A', 'x', ST_GeomFromText('POLYGON((77.0 28.0, 77.1 28.0, 77.1 28.1, 77.0 28.1, 77.0 28.0))')),
        ('A', 'y', ST_GeomFromText('POLYGON((77.1 28.0, 77.2 28.0, 77.2 28.1, 77.1 28.1, 77.1 28.0))')),
        ('B', 'z', ST_GeomFromText('POLYGON((77.2 28.0, 77.3 28.0, 77.3 28.1, 77.2 28.1, 77.2 28.0))')))
        t(cls, other, geometry)) TO '{src}' (FORMAT PARQUET)""")
    return src


def test_overview_dissolves_by_class_keeps_area_and_leaves_the_parquet_alone(tmp_path):
    src = _squares(tmp_path)
    before = src.read_bytes()
    con = blw.make_con(tmp_path)
    out = blw.dissolve_overview(src, tmp_path / 'ov.geojsonl', 'cls', con, blw.Deadline(5))
    feats = [json.loads(line.strip('\x1e')) for line in out.read_text().splitlines() if line.strip()]
    assert sorted(f['properties']['cls'] for f in feats) == ['A', 'B']
    assert all(set(f['properties']) == {'cls'} for f in feats)  # class only: popups stay on detail zooms
    area = con.execute(f"SELECT sum(ST_Area(geom)) FROM ST_Read('{out}')").fetchone()[0]
    assert area == pytest.approx(0.03, rel=1e-3)
    assert src.read_bytes() == before  # generalised in tiles only
    assert blw.dissolve_overview(src, out, 'cls', con, blw.Deadline(5)) == out  # cached: no work


def test_overview_drops_vertices_closer_than_a_tile_unit(tmp_path):
    # A vertex half a tile unit off its neighbours' line cannot show at the
    # overview's max zoom; dropping such vertices cut geomorphology's 4x.
    g = blw.overview_grid()
    ring = f'77.0 28.0, 77.05 {28.0 + 2 * g}, 77.1 {28.0 + 3 * g}, 77.1 28.1, 77.0 28.1, 77.0 28.0'
    src = tmp_path / 'V.parquet'
    con = blw.make_con(tmp_path)
    con.execute(f"""COPY (SELECT 'A' AS cls, g AS geometry, ST_XMin(g) xmin, ST_YMin(g) ymin, ST_XMax(g) xmax,
                         ST_YMax(g) ymax FROM (SELECT ST_GeomFromText('POLYGON(({ring}))') g))
                    TO '{src}' (FORMAT PARQUET)""")
    out = blw.dissolve_overview(src, tmp_path / 'ov.geojsonl', 'cls', con, blw.Deadline(5))
    assert con.execute(f"SELECT ST_NPoints(geom) FROM ST_Read('{out}')").fetchone()[0] == 5


def test_overview_writes_single_polygons(tmp_path):
    # tippecanoe shrinks sub-pixel polygons per feature, not per ring: one
    # multipolygon of 155,000 ponds kept every ring and overflowed every tile.
    src = tmp_path / 'P.parquet'
    con = blw.make_con(tmp_path)
    con.execute(f"""COPY (SELECT 'pond' AS cls, g AS geometry, ST_XMin(g) xmin, ST_YMin(g) ymin, ST_XMax(g) xmax,
                         ST_YMax(g) ymax FROM (SELECT ST_Buffer(ST_Point(77.0 + range / 10, 28.5), 0.01) g
                                               FROM range(3)))
                    TO '{src}' (FORMAT PARQUET)""")
    out = blw.dissolve_overview(src, tmp_path / 'ov.geojsonl', 'cls', con, blw.Deadline(5))
    types = con.execute(f"SELECT list(ST_GeometryType(geom)::VARCHAR) FROM ST_Read('{out}')").fetchone()[0]
    assert types == ['POLYGON'] * 3


def test_overview_snaps_to_one_tile_unit_at_its_max_zoom():
    assert blw.overview_grid(8) == pytest.approx(360 / 2 ** 8 / 4096)
    assert blw.overview_grid(9) == blw.overview_grid(8) / 2


def test_overview_and_detail_tiles_split_the_zoom_range():
    m = blw.OVERVIEW_MAXZOOM
    ov = blw.tippecanoe_args(Path('o.geojsonl'), Path('o.pmtiles'), 'lyr', ['cls'], polygons=True, maxzoom=m)
    assert ov[ov.index('-Z0') + 1] == f'-z{m}'
    assert '--extend-zooms-if-still-dropping' not in ov  # must not spill into the detail zooms
    # Coalescing merged sub-pixel ponds back into many-ring features that
    # overflowed again; an overview drops the smallest polygons first.
    assert '--drop-smallest-as-needed' in ov and '--coalesce-densest-as-needed' not in ov
    assert '-D11' in ov  # half the detail below its max zoom: z5 geomorphology cover 0.70 -> 0.95
    det = blw.tippecanoe_args(Path('d.geojsonl'), Path('d.pmtiles'), 'lyr', ['cls', 'age'], polygons=True,
                              minzoom=m + 1)
    assert f'-Z{m + 1}' in det and '-zg' in det and '-Z0' not in det


def test_every_overview_class_is_a_popup_field():
    for lid, field in blw.OVERVIEW.items():
        fields, polygons = blw.TILES[lid]
        assert polygons and field in fields, lid


def test_overview_and_detail_join_into_one_tileset(tmp_path):
    src = _squares(tmp_path)
    out = tmp_path / 'S.pmtiles'
    con = blw.make_con(tmp_path)
    blw.bake_tiles(src, out, 'lyr', ['cls', 'other'], True, con, overview='cls', deadline=blw.Deadline(5))
    low = blw.decode_tile(out, 3, *blw.tile_for(77.15, 28.05, 3), tmp_path / 'low.geojson')
    z = blw.OVERVIEW_MAXZOOM + 1
    high = tmp_path / 'high.geojson'
    blw.decode_tile(out, z, *blw.tile_for(77.15, 28.05, z), high)
    assert low == 2  # dissolved A + B
    props = [f['properties'] for f in json.loads(high.read_text())['features']]
    assert sorted(p['other'] for p in props) == ['x', 'y', 'z']  # every source polygon, popup fields
    left = sorted(p.name for p in tmp_path.glob('S.*'))
    # the slow steps stay cached for a re-tune of the overview tiles; the big GeoJSON goes
    assert left == ['S.detail.pmtiles', 'S.overview.geojsonl', 'S.parquet', 'S.pmtiles', 'S.tippecanoe.log']


def test_probe_zooms_cover_both_sides_of_the_overview_seam():
    m = blw.OVERVIEW_MAXZOOM
    assert blw.probe_zooms(11, overview=False) == [5, 11]
    assert blw.probe_zooms(11, overview=True) == sorted({5, m, m + 1, 11})


def test_tiles_must_be_complete_from_the_first_detail_zoom():
    rows = [{'z': 8, 'decoded': 50, 'parquet': 900, 'cover': 0.99},
            {'z': 9, 'decoded': 300, 'parquet': 300, 'cover': 1.0},
            {'z': 11, 'decoded': 40, 'parquet': 40, 'cover': 1.0}]
    assert blw.tiles_ok(rows, 9, polygons=True)
    assert not blw.tiles_ok([rows[0], dict(rows[1], decoded=299), rows[2]], 9, polygons=True)


def test_overview_zooms_allow_the_generalisation_detail_zooms_do_not():
    z5 = {'z': 5, 'decoded': 400, 'parquet': 100_000, 'cover': 0.95}
    detail = [{'z': 9, 'decoded': 300, 'parquet': 300, 'cover': 1.0}]
    assert blw.tiles_ok([z5, *detail], 9, polygons=True, overview=True)
    assert not blw.tiles_ok([z5, *detail], 11, polygons=True)  # no overview: 0.98 everywhere
    assert not blw.tiles_ok([dict(z5, cover=0.54), *detail], 9, polygons=True, overview=True)  # real holes
    assert not blw.tiles_ok([z5, dict(detail[0], cover=0.95)], 9, polygons=True, overview=True)


def test_cover_counts_overlapping_source_polygons_once(tmp_path):
    # GSI lithology repeats rock units across overlapping sheets: summed source
    # area was 11x a z8 tile, so complete tiles read as 9% cover.
    con = blw.make_con(tmp_path)
    sq = "ST_GeomFromText('POLYGON((77.0 28.0, 77.3 28.0, 77.3 28.3, 77.0 28.3, 77.0 28.0))')"
    env = 'ST_MakeEnvelope(76, 27, 79, 29)'

    line = "ST_GeomFromText('LINESTRING(77.0 28.0, 77.3 28.0)')"

    def cover(geom: str, copies: int, polygons: bool = True) -> float:
        return con.execute(f"SELECT {blw.covered('g', env, polygons, 5)} "
                           f"FROM (SELECT {geom} AS g FROM range({copies}))").fetchone()[0]
    assert cover(sq, 3) == pytest.approx(cover(sq, 1)) == pytest.approx(0.09, rel=0.01)
    assert cover(line, 2, polygons=False) == pytest.approx(0.6)  # lines: summed length


def test_tile_report_counts_features_that_meet_the_tile_not_just_its_bbox(tmp_path, monkeypatch):
    # Big irregular landforms: 16 bboxes met a z12 tile, 9 polygons did.
    src = tmp_path / 'T.parquet'
    con = blw.make_con(tmp_path)
    tri = "ST_GeomFromText('POLYGON((77.0 28.0, 77.4 28.0, 77.0 28.9, 77.0 28.0))')"
    con.execute(f"""COPY (SELECT 1 AS n, g AS geometry, ST_XMin(g) xmin, ST_YMin(g) ymin, ST_XMax(g) xmax,
                         ST_YMax(g) ymax FROM (SELECT {tri} AS g)) TO '{src}' (FORMAT PARQUET)""")
    pm = tmp_path / 'T.pmtiles'
    blw.bake_tiles(src, pm, 'lyr', ['n'], True, con)
    monkeypatch.setattr(blw, 'PROBES', [(77.2, 28.6)])  # inside the bbox, outside the triangle
    assert blw.tile_report(pm, src, con, True, [12])[0]['parquet'] == 0


def test_no_upload_can_still_register_the_local_build(monkeypatch):
    calls = []
    monkeypatch.setattr(blw, 'build', lambda d, deadline: {'id': d.id})
    monkeypatch.setattr(blw, 'publish', lambda d, built: calls.append(('publish', d.id)))
    monkeypatch.setattr(blw, 'register', lambda d, built: calls.append(('register', d.id)))
    lid = blw.DATASETS[0].id
    assert blw.main(['x', lid, '--no-upload']) == 0 and calls == []
    assert blw.main(['x', lid, '--no-upload', '--register']) == 0 and calls == [('register', lid)]
