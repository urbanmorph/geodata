"""Tests for rebake_layer.py (bbox columns for /api/v1/nearby).

The R2 upload runs only for real; here: key naming, the catalog and manifest
patch, the skip for layers that already have bbox columns, and the check that
a rebake adds the 4 bbox columns and changes nothing else.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_rebake_layer.py -q"""

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))

R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'
MD5 = '0a1b2c3d' + '0' * 24


def test_r2_key_from_url_strips_public_host() -> None:
    from rebake_layer import r2_key_from_url
    assert r2_key_from_url(f'{R2}/water/wetlands/x.parquet') == 'water/wetlands/x.parquet'


def test_r2_key_from_url_takes_the_data_domain_and_the_old_r2_dev_host() -> None:
    # data.bharatlas.com serves the bucket since Nov 2026; release manifests and old
    # links keep the r2.dev address, which still works.
    from rebake_layer import r2_key_from_url
    import pipeline
    assert pipeline.R2_PUBLIC == 'https://data.bharatlas.com'
    assert r2_key_from_url('https://data.bharatlas.com/water/wetlands/x.parquet') == 'water/wetlands/x.parquet'
    assert r2_key_from_url(f'{pipeline.R2_PUBLIC_LEGACY}/water/wetlands/x.parquet') == 'water/wetlands/x.parquet'


def test_r2_key_from_url_rejects_non_r2_url() -> None:
    from rebake_layer import r2_key_from_url
    with pytest.raises(ValueError):
        r2_key_from_url('https://github.com/foo/bar/release/file.parquet')


def test_find_layer() -> None:
    from rebake_layer import find_layer
    cat = {'layers': [{'id': 'lgd_states'}, {'id': 'bp_wetlands'}]}
    assert find_layer(cat, 'bp_wetlands')['id'] == 'bp_wetlands'
    with pytest.raises(KeyError):
        find_layer(cat, 'b')


def test_versioned_key_sits_next_to_the_old_key() -> None:
    from rebake_layer import versioned_key
    assert versioned_key('admin/states/LGD_States.parquet', MD5) == 'admin/states/LGD_States.0a1b2c3d.parquet'
    # a second rebake replaces the suffix instead of stacking another one
    assert versioned_key('admin/states/LGD_States.ffffffff.parquet', MD5) == 'admin/states/LGD_States.0a1b2c3d.parquet'


def _write(con, path: Path, rows: list[tuple]) -> None:
    con.execute('CREATE OR REPLACE TABLE t (code INTEGER, name VARCHAR, geometry GEOMETRY)')
    for code, name, wkt in rows:
        con.execute('INSERT INTO t VALUES (?, ?, ST_GeomFromText(?))', [code, name, wkt])
    con.execute(f"COPY t TO '{path}' (FORMAT PARQUET)")


ROWS = [
    (1, 'Karnataka', 'POLYGON((74 12, 78 12, 78 18, 74 18, 74 12))'),
    (2, 'Kerala', 'POLYGON((74.8 8.2, 77.4 8.2, 77.4 12.8, 74.8 12.8, 74.8 8.2))'),
    (3, None, 'POINT(88.3 22.5)'),
    (3, None, 'POINT(88.3 22.5)'),  # duplicate rows stay duplicate
]


@pytest.fixture
def con():
    from pipeline import make_con
    return make_con()


def test_bbox_kind(tmp_path: Path, con) -> None:
    from pipeline import rebake_flatten_bbox
    from rebake_layer import bbox_kind
    src, dst, struct = tmp_path / 'a.parquet', tmp_path / 'b.parquet', tmp_path / 's.parquet'
    _write(con, src, ROWS)
    assert bbox_kind(str(src)) is None
    rebake_flatten_bbox(src, dst)
    assert bbox_kind(str(dst)) == 'flat'
    con.execute(f"COPY (SELECT *, {{'xmin': 0.0, 'ymin': 0.0, 'xmax': 1.0, 'ymax': 1.0}} AS bbox "
                f"FROM read_parquet('{src}')) TO '{struct}' (FORMAT PARQUET)")
    assert bbox_kind(str(struct)) == 'struct'


def test_verify_passes_a_rebake_that_only_adds_bbox_columns(tmp_path: Path, con) -> None:
    from pipeline import rebake_flatten_bbox
    from rebake_layer import verify
    src, dst = tmp_path / 'a.parquet', tmp_path / 'b.parquet'
    _write(con, src, ROWS)
    rebake_flatten_bbox(src, dst)
    out = verify(src, dst)
    assert out['rows'] == 4
    assert out['row_groups'] == (1, 1)


def test_verify_fails_when_a_value_changed(tmp_path: Path, con) -> None:
    from pipeline import rebake_flatten_bbox
    from rebake_layer import verify
    src, mid, dst = tmp_path / 'a.parquet', tmp_path / 'm.parquet', tmp_path / 'b.parquet'
    _write(con, src, ROWS)
    _write(con, mid, [ROWS[0], (2, 'Kerala ', ROWS[1][2]), *ROWS[2:]])
    rebake_flatten_bbox(mid, dst)
    with pytest.raises(ValueError, match='values'):
        verify(src, dst)


def test_verify_fails_when_a_row_or_column_is_lost(tmp_path: Path, con) -> None:
    from rebake_layer import verify
    src, dst = tmp_path / 'a.parquet', tmp_path / 'b.parquet'
    _write(con, src, ROWS)
    _write(con, dst, ROWS[:3])
    with pytest.raises(ValueError, match='rows'):
        verify(src, dst)
    con.execute(f"COPY (SELECT code, geometry, 0.0 AS xmin, 0.0 AS ymin, 0.0 AS xmax, 0.0 AS ymax "
                f"FROM read_parquet('{src}')) TO '{dst}' (FORMAT PARQUET)")
    with pytest.raises(ValueError, match='columns'):
        verify(src, dst)


def test_verify_lets_geometry_without_a_crs_read_back_as_crs84_only(tmp_path: Path, con) -> None:
    """GeoParquet without a crs means OGC:CRS84; DuckDB writes it explicitly.
    Any other CRS change fails."""
    from rebake_layer import verify
    src, dst = tmp_path / 'a.parquet', tmp_path / 'b.parquet'
    con.execute(f"COPY (SELECT 1 AS a, ST_GeomFromText('POINT(77 12)')::GEOMETRY AS geometry) TO '{src}' "
                "(FORMAT PARQUET)")
    for crs, ok in (('OGC:CRS84', True), ('EPSG:3857', False)):
        con.execute(f"COPY (SELECT a, ST_SetCRS(geometry, '{crs}') AS geometry, 77.0 AS xmin, 12.0 AS ymin, "
                    f"77.0 AS xmax, 12.0 AS ymax FROM read_parquet('{src}')) TO '{dst}' (FORMAT PARQUET)")
        if ok:
            verify(src, dst)
        else:
            with pytest.raises(ValueError, match='columns'):
                verify(src, dst)


def test_patch_catalog_points_the_parquet_at_the_new_key(tmp_path: Path) -> None:
    from rebake_layer import patch_catalog
    cat, man = tmp_path / 'catalog.json', tmp_path / 'manifest.json'
    cat.write_text(json.dumps({'layers': [
        {'id': 'a', 'parquet': {'url': f'{R2}/x/a.parquet', 'bytes': 1}},
        {'id': 'wards_x', 'parquet': {'url': f'{R2}/admin/wards-x/wards_x.parquet', 'upstream_url': 'u', 'bytes': 2},
         'pmtiles': {'url': f'{R2}/admin/wards-x/wards_x.pmtiles', 'bytes': 3}},
    ]}))
    man.write_text(json.dumps([{'id': 'wards_x', 'r2_prefix': 'admin/wards-x', 'parquet_file': 'wards_x.parquet',
                                'parquet_bytes': 2}]))
    patch_catalog('wards_x', 'admin/wards-x/wards_x.0a1b2c3d.parquet', 99, cat, man)
    out = json.loads(cat.read_text())
    assert out['layers'][0] == {'id': 'a', 'parquet': {'url': f'{R2}/x/a.parquet', 'bytes': 1}}
    # the new key on the data domain; the old r2.dev entry it replaces was read fine
    assert out['layers'][1]['parquet'] == {'url': 'https://data.bharatlas.com/admin/wards-x/wards_x.0a1b2c3d.parquet',
                                           'upstream_url': 'u', 'bytes': 99}
    assert out['layers'][1]['pmtiles']['bytes'] == 3
    assert json.loads(man.read_text()) == [{'id': 'wards_x', 'r2_prefix': 'admin/wards-x',
                                            'parquet_file': 'wards_x.0a1b2c3d.parquet', 'parquet_bytes': 99}]
    before = cat.read_text()
    patch_catalog('wards_x', 'admin/wards-x/wards_x.0a1b2c3d.parquet', 99, cat, man)
    assert cat.read_text() == before  # idempotent


def test_rebake_skips_a_layer_that_already_has_bbox_columns(tmp_path: Path, con, monkeypatch) -> None:
    import rebake_layer
    from pipeline import rebake_flatten_bbox
    src, dst = tmp_path / 'a.parquet', tmp_path / 'b.parquet'
    _write(con, src, ROWS)
    rebake_flatten_bbox(src, dst)
    monkeypatch.setattr(rebake_layer, 'WORK', tmp_path / 'work')
    layer = {'id': 'x', 'parquet': {'url': str(dst)}}
    assert rebake_layer.rebake(layer, rebake_layer.Deadline(10), upload=False) is None
    assert not (tmp_path / 'work').exists()


def test_missing_bbox_lists_layers_without_flat_columns() -> None:
    from rebake_layer import missing_bbox
    cat = {'layers': [{'id': 'a', 'parquet': {'url': 'u1'}}, {'id': 'b', 'parquet': {'url': 'u2'}},
                      {'id': 'c', 'parquet': None}, {'id': 'd'}, {'id': 'e', 'parquet': {'url': 'u3'}}]}
    kinds = {'u1': None, 'u2': 'flat', 'u3': 'struct'}
    assert missing_bbox(cat, kinds.get) == {'none': ['a'], 'struct': ['e']}


def _write_struct(con, path: Path) -> None:
    """A ramSeraph-shaped parquet: geometry plus a GeoParquet `bbox` struct."""
    _write(con, path, ROWS)
    con.execute(f"COPY (SELECT *, {{'xmin': ST_XMin(geometry), 'ymin': ST_YMin(geometry), "
                f"'xmax': ST_XMax(geometry), 'ymax': ST_YMax(geometry)}} AS bbox "
                f"FROM read_parquet('{path}')) TO '{path}.tmp' (FORMAT PARQUET)")
    Path(f'{path}.tmp').replace(path)


def test_rebake_flatten_bbox_can_keep_the_struct(tmp_path: Path, con) -> None:
    from pipeline import rebake_flatten_bbox
    src, dst = tmp_path / 'a.parquet', tmp_path / 'b.parquet'
    _write_struct(con, src)
    rebake_flatten_bbox(src, dst, keep_struct=True)
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{dst}')").fetchall()]
    assert cols == ['code', 'name', 'geometry', 'bbox', 'xmin', 'ymin', 'xmax', 'ymax']
    assert con.execute(f"SELECT count(*) FROM read_parquet('{dst}') WHERE xmin <> bbox.xmin OR ymin <> bbox.ymin "
                       "OR xmax <> bbox.xmax OR ymax <> bbox.ymax").fetchone()[0] == 0


def test_rebake_adds_flat_columns_beside_a_bbox_struct(tmp_path: Path, con, monkeypatch) -> None:
    """A layer with only the struct keeps it, untouched, and gains the 4 columns."""
    import shutil
    import rebake_layer
    src = tmp_path / 'a.parquet'
    _write_struct(con, src)
    monkeypatch.setattr(rebake_layer, 'WORK', tmp_path / 'work')
    kind = rebake_layer.bbox_kind
    monkeypatch.setattr(rebake_layer, 'bbox_kind', lambda url: kind(str(src)))

    def copy(url: str, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(src, dest)
    monkeypatch.setattr(rebake_layer, 'download', copy)
    layer = {'id': 'x', 'parquet': {'url': f'{R2}/water/x/X.parquet'}}
    out = rebake_layer.rebake(layer, rebake_layer.Deadline(10), upload=False)
    assert out['rows'] == 4 and out['columns'] == 4  # code, name, geometry, bbox
    assert out['new_key'].startswith('water/x/X.') and out['new_key'].endswith('.parquet')
    assert kind(str(tmp_path / 'work' / 'x' / 'x.bbox.parquet')) == 'flat'


def test_main_rebakes_struct_layers_too(monkeypatch) -> None:
    import rebake_layer
    monkeypatch.setattr(rebake_layer, 'missing_bbox', lambda cat: {'none': ['a'], 'struct': ['e']})
    seen = []
    monkeypatch.setattr(rebake_layer, 'rebake', lambda layer, deadline, upload: seen.append(layer['id']))
    monkeypatch.setattr(rebake_layer, 'find_layer', lambda cat, lid: {'id': lid})
    assert rebake_layer.main(['x', '--missing', '--no-upload']) == 0
    assert seen == ['a', 'e']
