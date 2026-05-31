"""Test that rebake_flatten_bbox spatially sorts rows so parquet row-group
bbox statistics are useful for /api/v1/nearby pruning.

Spec: rows in the output parquet should be spatially clustered — consecutive
rows are geographically close to each other, not in upstream order. The
metric we use is the ratio of mean-consecutive-distance to mean-random-pair
distance. A Hilbert-sorted file should have a ratio well under 0.3; random
order is ~1.0.

Run: python3 -m pytest scripts/test_hilbert_sort.py -v"""
import sys
from pathlib import Path

import duckdb
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))


def make_test_parquet(path: Path, n_rows: int = 2000) -> None:
    """Write a parquet with n_rows random points across India bbox, with a
    bbox STRUCT mimicking ramSeraph's release format. Deliberately not
    spatially ordered so the rebake has something to fix."""
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute(f"""
        COPY (
          WITH pts AS (
            SELECT
              i AS id,
              68.0 + ((i * 2654435761) % 1000) / 1000.0 * 30 AS x,
              6.0  + ((i * 1597334677) % 1000) / 1000.0 * 32 AS y
            FROM range({n_rows}) t(i)
          )
          SELECT
            id,
            ST_AsWKB(ST_Point(x, y))::BLOB AS geometry,
            {{xmin: x, ymin: y, xmax: x, ymax: y}} AS bbox
          FROM pts
        ) TO '{path}' (FORMAT PARQUET)
    """)


def mean_consecutive_distance(path: Path) -> float:
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    row = con.execute(f"""
        WITH ordered AS (
          SELECT row_number() OVER () AS rn, xmin AS x, ymin AS y
          FROM read_parquet('{path}')
        ),
        pairs AS (
          SELECT a.x AS ax, a.y AS ay, b.x AS bx, b.y AS byy
          FROM ordered a JOIN ordered b ON b.rn = a.rn + 1
        )
        SELECT avg(sqrt((ax - bx) * (ax - bx) + (ay - byy) * (ay - byy))) FROM pairs
    """).fetchone()
    return float(row[0])


def mean_random_pair_distance(path: Path, sample: int = 500) -> float:
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    row = con.execute(f"""
        WITH pts AS (SELECT xmin AS x, ymin AS y FROM read_parquet('{path}') USING SAMPLE {sample} ROWS),
             pairs AS (SELECT a.x AS ax, a.y AS ay, b.x AS bx, b.y AS byy FROM pts a CROSS JOIN pts b WHERE a.x <> b.x OR a.y <> b.y)
        SELECT avg(sqrt((ax - bx) * (ax - bx) + (ay - byy) * (ay - byy))) FROM pairs
    """).fetchone()
    return float(row[0])


def test_rebake_flatten_bbox_spatially_clusters_rows(tmp_path: Path) -> None:
    """The acceptance test: after rebake, consecutive rows are geographically
    much closer than random pairs. Without spatial sort this would be ~1.0."""
    from ingest_ramseraph import rebake_flatten_bbox

    src = tmp_path / 'src.parquet'
    dst = tmp_path / 'dst.parquet'
    make_test_parquet(src, n_rows=2000)

    n, cols = rebake_flatten_bbox(src, dst)
    assert n == 2000
    assert set(['xmin', 'ymin', 'xmax', 'ymax']).issubset(cols)

    consecutive = mean_consecutive_distance(dst)
    random_pair = mean_random_pair_distance(dst)
    ratio = consecutive / random_pair
    assert ratio < 0.3, (
        f'rebake should spatially cluster rows. consecutive={consecutive:.3f}, '
        f'random_pair={random_pair:.3f}, ratio={ratio:.3f} (expected < 0.3)'
    )


def test_rebake_preserves_row_count(tmp_path: Path) -> None:
    from ingest_ramseraph import rebake_flatten_bbox

    src = tmp_path / 'src.parquet'
    dst = tmp_path / 'dst.parquet'
    make_test_parquet(src, n_rows=500)

    n, _ = rebake_flatten_bbox(src, dst)
    assert n == 500


def test_rebake_handles_geometry_typed_column(tmp_path: Path) -> None:
    """ramSeraph parquet stores `geometry` as the GEOMETRY logical type, not
    raw BLOB. Earlier impl wrapped it in ST_GeomFromWKB which broke on the
    real file shape. Regression test for that."""
    from ingest_ramseraph import rebake_flatten_bbox

    src = tmp_path / 'src.parquet'
    dst = tmp_path / 'dst.parquet'
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    # No ::BLOB cast — geometry is stored with the spatial logical type.
    con.execute(f"""
        COPY (
          WITH pts AS (
            SELECT
              i AS id,
              68.0 + ((i * 2654435761) % 1000) / 1000.0 * 30 AS x,
              6.0  + ((i * 1597334677) % 1000) / 1000.0 * 32 AS y
            FROM range(500) t(i)
          )
          SELECT id, ST_Point(x, y) AS geometry, {{xmin: x, ymin: y, xmax: x, ymax: y}} AS bbox
          FROM pts
        ) TO '{src}' (FORMAT PARQUET)
    """)
    n, cols = rebake_flatten_bbox(src, dst)
    assert n == 500
    assert set(['xmin', 'ymin', 'xmax', 'ymax']).issubset(cols)


def test_row_group_size_for_scales_with_density() -> None:
    """Dense layers want many small groups (tight Hilbert chunks per group);
    sparse layers want one or two big groups. Spec the buckets."""
    from ingest_ramseraph import row_group_size_for
    assert row_group_size_for(100) is None         # single group is fine
    assert row_group_size_for(9_999) is None
    assert row_group_size_for(50_000) == 5_000     # ~10 groups
    assert row_group_size_for(99_999) == 5_000
    assert row_group_size_for(500_000) == 20_000   # ~25 groups
    assert row_group_size_for(999_999) == 20_000
    assert row_group_size_for(2_700_000) == 50_000  # Overture: ~54 groups
    assert row_group_size_for(5_000_000) == 50_000


def test_rebake_uses_tight_row_groups_for_dense_layers(tmp_path: Path) -> None:
    """End-to-end: a dense layer should end up with many small row groups
    after rebake, so /api/v1/nearby's bbox prune can be effective."""
    from ingest_ramseraph import rebake_flatten_bbox
    import pyarrow.parquet as pq

    src = tmp_path / 'src.parquet'
    dst = tmp_path / 'dst.parquet'
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    # 60k random points across India — dense enough to trigger the 5k bucket
    con.execute(f"""
        COPY (
          WITH pts AS (
            SELECT
              i AS id,
              68.0 + ((i * 2654435761) % 10000) / 10000.0 * 30 AS x,
              6.0  + ((i * 1597334677) % 10000) / 10000.0 * 32 AS y
            FROM range(60000) t(i)
          )
          SELECT id, ST_Point(x, y) AS geometry FROM pts
        ) TO '{src}' (FORMAT PARQUET)
    """)
    rebake_flatten_bbox(src, dst)
    pf = pq.ParquetFile(dst)
    # 60k rows / 5k per group = 12 groups expected
    assert pf.num_row_groups >= 8, f'expected dense layer to be split into many groups, got {pf.num_row_groups}'


def test_rebake_synthesizes_bbox_cols_when_absent(tmp_path: Path) -> None:
    """Own-bake layers (LGD villages/panchayats etc.) ship without any bbox
    representation. rebake should synthesise flat xmin/ymin/xmax/ymax from
    the geometry so /api/v1/nearby's bbox-prune path can work on them."""
    from ingest_ramseraph import rebake_flatten_bbox

    src = tmp_path / 'src.parquet'
    dst = tmp_path / 'dst.parquet'
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    # GEOMETRY-typed column (matches LGD parquet shape), NO bbox struct, NO flat cols
    con.execute(f"""
        COPY (SELECT i AS id, ST_Point(68 + (i % 30), 6 + (i % 32)) AS geometry FROM range(500) t(i))
        TO '{src}' (FORMAT PARQUET)
    """)

    n, cols = rebake_flatten_bbox(src, dst)
    assert n == 500
    assert set(['xmin', 'ymin', 'xmax', 'ymax']).issubset(cols), (
        f'rebake should add flat bbox cols when source has neither struct nor flat. Got: {cols}'
    )
