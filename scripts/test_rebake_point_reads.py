"""Tests for rebake_point_reads.py (parquet laid out for cheap point lookups).

The R2 upload runs only for real; here: the rewrite keeps every row, column,
value, the row order and the file's key-value metadata, the layout it writes
(rows per row group, small data pages, page index, no dictionary), the
verification that refuses any change, and the skip for a layer already done.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_rebake_point_reads.py -q"""

import json
import sys
from pathlib import Path

import pyarrow.parquet as pq
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))

import rebake_point_reads as rpr  # noqa: E402
from pipeline import make_con  # noqa: E402

R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'


def _source(path: Path, n: int = 50) -> Path:
    """A small GeoParquet written by DuckDB like the published ones: strings with
    repeats and nulls, a nested column, point geometry (GeoParquet `geo` metadata)
    and flat bbox columns, in one row group with dictionary pages."""
    con = make_con()
    con.execute(f"""COPY (
        SELECT 'r' || i AS id, CASE WHEN i % 5 = 0 THEN NULL ELSE (6 + i % 3)::VARCHAR END AS "pH",
               list_transform(range(i % 3), x -> 't' || (i % 3)) AS tags,
               ST_Point(70 + i * 0.3, 10 + i % 7) AS geometry,
               (70 + i * 0.3)::DOUBLE AS xmin, (10 + i % 7)::DOUBLE AS ymin,
               (70 + i * 0.3)::DOUBLE AS xmax, (10 + i % 7)::DOUBLE AS ymax
        FROM range({n}) t(i) ORDER BY i) TO '{path}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
    return path


def test_rewrite_keeps_every_row_value_and_the_order(tmp_path: Path) -> None:
    src = _source(tmp_path / 'src.parquet')
    dst = tmp_path / 'dst.parquet'
    rpr.rewrite(src, dst, rpr.Layout(rows_per_group=8, page_bytes=64))
    a, b = pq.ParquetFile(src).read(), pq.ParquetFile(dst).read()
    assert b.schema.names == a.schema.names
    assert b.equals(a)
    assert pq.ParquetFile(dst).metadata.metadata[b'geo'] == pq.ParquetFile(src).metadata.metadata[b'geo']


def test_rewrite_writes_the_layout(tmp_path: Path) -> None:
    src = _source(tmp_path / 'src.parquet')
    dst = tmp_path / 'dst.parquet'
    rpr.rewrite(src, dst, rpr.Layout(rows_per_group=8, page_bytes=64))
    md = pq.ParquetFile(dst).metadata
    assert [md.row_group(i).num_rows for i in range(md.num_row_groups)] == [8] * 6 + [2]
    for i in range(md.num_row_groups):
        for j in range(md.num_columns):
            col = md.row_group(i).column(j)
            assert col.compression == 'ZSTD'
            assert col.has_offset_index and col.has_column_index
            assert not col.has_dictionary_page
    # the bbox columns keep min/max statistics: /nearby prunes row groups by them
    x = next(j for j in range(md.num_columns) if md.row_group(0).column(j).path_in_schema == 'xmin')
    assert md.row_group(1).column(x).statistics.min == pytest.approx(70 + 8 * 0.3)


def test_rewrite_splits_a_column_into_small_pages(tmp_path: Path) -> None:
    src = _source(tmp_path / 'src.parquet', n=6000)
    assert rpr.pages_in_first_chunk(src, 'id') == 1
    dst = tmp_path / 'dst.parquet'
    rpr.rewrite(src, dst, rpr.Layout(rows_per_group=6000, page_bytes=256))
    assert rpr.pages_in_first_chunk(dst, 'id') == 6  # a page closes past page_bytes at each 1,024-row write batch


def test_rewrite_can_store_uncompressed(tmp_path: Path) -> None:
    src = _source(tmp_path / 'src.parquet')
    dst = tmp_path / 'dst.parquet'
    rpr.rewrite(src, dst, rpr.Layout(rows_per_group=64, compression='none'))
    md = pq.ParquetFile(dst).metadata
    assert {md.row_group(0).column(j).compression for j in range(md.num_columns)} == {'UNCOMPRESSED'}
    assert rpr.verify(src, dst)['rows'] == 50


def test_layout_reads_rows_per_group_back(tmp_path: Path) -> None:
    src = _source(tmp_path / 'src.parquet')
    dst = tmp_path / 'dst.parquet'
    rpr.rewrite(src, dst, rpr.Layout(rows_per_group=16, page_bytes=64))
    assert rpr.describe(dst)['row_groups'] == 4
    assert rpr.describe(dst)['rows_per_group'] == 16


def test_verify_passes_an_identical_rewrite(tmp_path: Path) -> None:
    src = _source(tmp_path / 'src.parquet')
    dst = tmp_path / 'dst.parquet'
    rpr.rewrite(src, dst, rpr.Layout(rows_per_group=8, page_bytes=64))
    out = rpr.verify(src, dst)
    assert out['rows'] == 50 and out['columns'] == 8
    assert out['checksum'] == rpr.fingerprint(src)


def _copy(src: Path, dst: Path, select: str) -> None:
    """dst = `select` over src's rows (FROM t, with file_row_number), written by DuckDB like src."""
    relation = f"read_parquet('{src}', file_row_number = true) t"
    make_con().execute(f"COPY ({select.replace('FROM t', 'FROM ' + relation)}) TO '{dst}' (FORMAT PARQUET, COMPRESSION ZSTD)")


def test_verify_refuses_reordered_rows(tmp_path: Path) -> None:
    src = _source(tmp_path / 'src.parquet')
    dst = tmp_path / 'dst.parquet'
    _copy(src, dst, 'SELECT * EXCLUDE (file_row_number) FROM t ORDER BY file_row_number DESC')
    with pytest.raises(ValueError, match='values or order'):
        rpr.verify(src, dst)


def test_verify_refuses_a_changed_value(tmp_path: Path) -> None:
    src = _source(tmp_path / 'src.parquet')
    dst = tmp_path / 'dst.parquet'
    _copy(src, dst, """SELECT * EXCLUDE (file_row_number) REPLACE (CASE WHEN file_row_number = 3 THEN '9' ELSE "pH" END AS "pH")
                       FROM t ORDER BY file_row_number""")
    with pytest.raises(ValueError, match='values or order'):
        rpr.verify(src, dst)


def test_verify_refuses_a_dropped_column(tmp_path: Path) -> None:
    src = _source(tmp_path / 'src.parquet')
    dst = tmp_path / 'dst.parquet'
    _copy(src, dst, 'SELECT * EXCLUDE (file_row_number, tags) FROM t ORDER BY file_row_number')
    with pytest.raises(ValueError, match='columns changed'):
        rpr.verify(src, dst)


def test_verify_refuses_changed_metadata(tmp_path: Path) -> None:
    src = _source(tmp_path / 'src.parquet')
    dst = tmp_path / 'dst.parquet'
    f = pq.ParquetFile(src)
    geo = json.loads(f.metadata.metadata[b'geo'])
    geo['columns']['geometry']['geometry_types'] = ['Polygon']
    with pq.ParquetWriter(dst, f.schema_arrow, store_schema=False) as w:
        w.write_table(f.read())
        w.add_key_value_metadata({'geo': json.dumps(geo)})
    with pytest.raises(ValueError, match='metadata changed'):
        rpr.verify(src, dst)


def test_every_planned_layer_is_in_the_catalog() -> None:
    catalog = json.loads((ROOT / 'catalog.json').read_text())
    ids = {layer['id'] for layer in catalog['layers'] if layer.get('parquet')}
    assert set(rpr.PLAN) <= ids


def test_a_layer_already_rebaked_is_skipped(tmp_path: Path, monkeypatch) -> None:
    key = 'agriculture/x/X.0a1b2c3d.parquet'
    monkeypatch.setattr(rpr, 'WORK', tmp_path)
    (tmp_path / rpr.REPORT).write_text(json.dumps({'x': {'old_key': 'agriculture/x/X.parquet', 'new_key': key}}))
    monkeypatch.setattr(rpr, 'download', lambda *a, **k: pytest.fail('must not download'))
    layer = {'id': 'x', 'parquet': {'url': f'{R2}/{key}', 'bytes': 1}}
    assert rpr.rebake(layer, rpr.Layout(rows_per_group=8, page_bytes=64), rpr.Deadline(1)) is None
