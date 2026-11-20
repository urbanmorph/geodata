"""Land and water layers from ramSeraph (Nov 2026): scripts/bake_land_water.py.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_land_water.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_land_water as blw  # noqa: E402
import ingest_ramseraph as ir  # noqa: E402
import licence_watch  # noqa: E402
from tile_keys import versioned_key  # noqa: E402


# Download, cached steps and the time limit live in pipeline (test_pipeline_infra.py).


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
        # the compiler's CC0, unless the publisher's reviewed terms set the licence (Bhuvan: NRSC terms)
        reviewed = licence_watch.licence_of(d.id, default=None)
        assert (d.category, d.source, d.license) == (cat, src, reviewed or 'CC0-1.0'), d.id
        assert src in ATTR, d.id
        assert d.parquet_url.endswith(f'/{file}.parquet') and d.pmtiles_url.endswith(f'/{file}.pmtiles')
        assert ("publisher's terms" if reviewed else 'sources-and-licensing') in d.notes and 'ramSeraph' in d.notes, d.id
        # The 1:50k polygon layers are parquet + tiles only (GeoJSON was 25.6 GB).
        assert d.bake_all_formats == (d.id not in PARQUET_AND_TILES_ONLY) and d.kml_name_field, d.id
        assert '—' not in d.name + d.description, d.id  # no em-dashes in user copy
        assert d.id not in existing, d.id
        # An exact id never pulls in another layer.
        assert [x.id for x in blw.DATASETS if d.id in x.id] == [d.id]


def _built(tmp_path: Path, bakes: tuple[str, ...] = ()) -> dict:
    """A local build of DATASETS[0]: parquet, tiles and the given whole-layer bakes."""
    stem = 'SLUSI_Priority_MicroWatersheds'
    exts = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
    paths = {}
    for fmt in ('parquet', 'pmtiles', *bakes):
        paths[fmt] = tmp_path / f'{stem}.{exts[fmt]}'
        paths[fmt].write_bytes(fmt.encode())
    return blw.built_files(paths, features=3)


def test_every_file_gets_a_content_versioned_name(tmp_path):
    # R2 objects are immutable once a catalog points at them: a refresh must
    # never overwrite a published parquet or download, only add new keys.
    built = _built(tmp_path, ('geojson', 'kml', 'shapefile'))
    for fmt, path in built['paths'].items():
        assert built['names'][fmt] == versioned_key(path.name, ir.file_md5(path))
    assert built['names']['shapefile'].endswith('.shp.zip')


def test_catalog_patch_touches_only_the_given_root_file_and_is_idempotent(tmp_path):
    cat = tmp_path / 'catalog.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': []}, indent=2) + '\n')
    d = blw.DATASETS[0]
    built = _built(tmp_path, ('geojson',))
    blw.patch_root_catalog(d, built, catalog=cat)
    first = cat.read_text()
    blw.patch_root_catalog(d, built, catalog=cat)
    assert cat.read_text() == first
    layer = json.loads(first)['layers'][0]
    names = built['names']
    assert (layer['id'], layer['rows'], layer['geojson']['bytes']) == (d.id, 3, len(b'geojson'))
    for fmt in ('parquet', 'pmtiles', 'geojson'):
        assert layer[fmt]['url'] == f'{ir.R2_PUBLIC}/{d.r2_prefix}/{names[fmt]}'
    assert layer['parquet']['upstream_url'] == d.parquet_url


def test_register_points_catalog_and_manifest_at_the_versioned_files(tmp_path, monkeypatch):
    (tmp_path / 'scripts').mkdir()
    (tmp_path / 'scripts' / 'external-ingested.json').write_text('[]')
    cat = tmp_path / 'catalog.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': []}))
    monkeypatch.setattr(ir, 'ROOT', tmp_path)
    monkeypatch.setattr(blw, 'CATALOG', cat)
    d = blw.DATASETS[0]
    built = _built(tmp_path)
    blw.register(d, built)
    row = json.loads((tmp_path / 'scripts' / 'external-ingested.json').read_text())[0]
    assert (row['parquet_file'], row['pmtiles_file']) == (built['names']['parquet'], built['names']['pmtiles'])
    layer = json.loads(cat.read_text())['layers'][0]
    assert layer['parquet']['url'].endswith('/' + built['names']['parquet'])
    assert layer['pmtiles']['url'].endswith('/' + built['names']['pmtiles'])


def test_tiles_go_to_a_new_key_per_content(tmp_path):
    pm = tmp_path / 'NGDR_Lithology_50k.pmtiles'
    pm.write_bytes(b'tiles v1')
    first = blw.built_files({'pmtiles': pm}, 1)['names']['pmtiles']
    assert first == f'NGDR_Lithology_50k.{ir.file_md5(pm)[:8]}.pmtiles'
    pm.write_bytes(b'tiles v2')
    assert blw.built_files({'pmtiles': pm}, 1)['names']['pmtiles'] != first
    assert blw.CATALOG == ir.ROOT / 'catalog.json'


def test_layers_over_two_gigabytes_are_not_ingested():
    # Single-file architecture: parquet over 2 GB is skipped (no per-state split
    # pattern exists for one national layer). Land degradation 2005-06 / 2015-16
    # (3.9 GB each) and groundwater prospect zones (2.7 GB) stay out.
    ids = {d.id for d in blw.DATASETS}
    for skipped in ('bhuvan_land_degradation_0506', 'bhuvan_land_degradation_1516', 'bhuvan_gw_prospects'):
        assert skipped not in ids
    assert all(v['parquet_bytes'] > 2 * 1024**3 for v in blw.SKIPPED.values())


def test_publish_uploads_resumably_under_the_lock_then_registers(tmp_path, monkeypatch):
    import pipeline
    lock = tmp_path / 'upload.lock'
    monkeypatch.setattr(pipeline, 'UPLOAD_LOCK', lock)
    monkeypatch.setattr(blw, 'patient_r2_client', lambda: 's3')
    seen, registered = [], []

    def fake_upload(s3, local, key, state_dir):
        # md5 skip + multipart resume live in r2_upload_resumable (test_pipeline.py)
        assert lock.is_dir() and state_dir == pipeline.UPLOAD_STATE
        seen.append(key)
    monkeypatch.setattr(pipeline, 'r2_upload_resumable', fake_upload)
    monkeypatch.setattr(blw, 'register', lambda d, built: registered.append(d.id))
    d = blw.DATASETS[0]
    built = _built(tmp_path, ('geojson',))
    blw.publish(d, built)
    assert seen == [f"{d.r2_prefix}/{built['names'][fmt]}" for fmt in ('parquet', 'pmtiles', 'geojson')]
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
                         ST_YMax(g) ymax FROM (SELECT ST_Buffer(ST_Point(77.3 + range / 10, 28.5), 0.01) g
                                               FROM range(3)))
                    TO '{src}' (FORMAT PARQUET)""")
    out = blw.dissolve_overview(src, tmp_path / 'ov.geojsonl', 'cls', con, blw.Deadline(5))
    types = con.execute(f"SELECT list(ST_GeometryType(geom)::VARCHAR) FROM ST_Read('{out}')").fetchone()[0]
    assert types == ['POLYGON'] * 3


def test_overview_cells_meet_without_overlap(tmp_path):
    # GSI sheets overlap at their edges; assigned whole to the cell of their
    # centre, the strips drew twice (a darker 1-degree grid at country zoom).
    # Clipped to each cell they touch, neighbouring pieces meet on the line.
    src = tmp_path / 'C.parquet'
    con = blw.make_con(tmp_path)
    rows = [('A', 76.5, 77.2), ('A', 76.9, 77.6)]  # centres in cells 76 and 77, overlapping 76.9-77.2
    values = ', '.join(f"('{c}', ST_GeomFromText('POLYGON(({x0} 28.0, {x1} 28.0, {x1} 28.1, {x0} 28.1, {x0} 28.0))'))"
                       for c, x0, x1 in rows)
    con.execute(f"""COPY (SELECT cls, g AS geometry, ST_XMin(g) xmin, ST_YMin(g) ymin, ST_XMax(g) xmax,
                         ST_YMax(g) ymax FROM (VALUES {values}) t(cls, g)) TO '{src}' (FORMAT PARQUET)""")
    out = blw.dissolve_overview(src, tmp_path / 'ov.geojsonl', 'cls', con, blw.Deadline(5))
    area, n = con.execute(f"SELECT sum(ST_Area(geom)), count(*) FROM ST_Read('{out}')").fetchone()
    assert area == pytest.approx(1.1 * 0.1, rel=1e-3) and n == 2  # the union once, cut at 77.0


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
    # every overview feature carries the marker the viewer leaves unstroked (1-degree cell seams)
    assert ov[ov.index('--set-attribute') + 1] == f'{blw.OVERVIEW_MARKER}:1'
    assert ov[ov.index('-y', ov.index('-y') + 1) + 1] == blw.OVERVIEW_MARKER
    det = blw.tippecanoe_args(Path('d.geojsonl'), Path('d.pmtiles'), 'lyr', ['cls', 'age'], polygons=True,
                              minzoom=m + 1)
    assert f'-Z{m + 1}' in det and '-zg' in det and '-Z0' not in det
    assert '--set-attribute' not in det and blw.OVERVIEW_MARKER not in det


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
    low_props = [f['properties'] for f in json.loads((tmp_path / 'low.geojson').read_text())['features']]
    assert all(p == {'cls': p['cls'], '_ov': 1} for p in low_props)
    props = [f['properties'] for f in json.loads(high.read_text())['features']]
    assert sorted(p['other'] for p in props) == ['x', 'y', 'z']  # every source polygon, popup fields
    assert not any('_ov' in p for p in props)  # detail features are outlined as before
    left = sorted(p.name for p in tmp_path.glob('S.*'))
    # the slow steps stay cached for a re-tune of the overview tiles; the big GeoJSON goes
    assert left == ['S.detail.pmtiles', 'S.overview.geojsonl', 'S.parquet', 'S.pmtiles', 'S.tippecanoe.log']


def test_a_retune_of_the_overview_tiles_reuses_the_slow_steps(tmp_path):
    src = _squares(tmp_path)
    out = tmp_path / 'S.pmtiles'
    blw.bake_tiles(src, out, 'lyr', ['cls', 'other'], True, blw.make_con(tmp_path), overview='cls',
                   deadline=blw.Deadline(5))
    out.unlink()
    # No connection: neither the GeoJSON of every feature nor the dissolve is redone.
    blw.bake_tiles(src, out, 'lyr', ['cls', 'other'], True, None, overview='cls', deadline=blw.Deadline(5))
    assert out.exists() and not list(tmp_path.glob('S.tiles*'))


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
