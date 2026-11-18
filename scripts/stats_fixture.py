"""A small parquet for the filter / API stats tests (test_build_filter_stats.py,
test_build_api_indexes.py), plus a connection that counts parquet scans."""
from __future__ import annotations

from pathlib import Path

import duckdb


def write_fixture(path: Path) -> Path:
    """60 rows: a 3-value name with a bijective code (counts 30/20/10, no ties),
    a boolean, a row-unique number, a column with nulls, an all-null column,
    a one-value column, a struct and a geometry."""
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial')
    con.execute(f"""
        COPY (
          SELECT
            CASE WHEN i < 30 THEN 'Alpha' WHEN i < 50 THEN 'Beta' ELSE 'Gamma' END AS state,
            CASE WHEN i < 30 THEN 1 WHEN i < 50 THEN 2 ELSE 3 END AS state_code,
            i < 40 AS flag,
            i * 1.5 AS val,
            CASE WHEN i % 4 = 0 THEN NULL WHEN i < 33 THEN 'x' ELSE 'y' END AS sometimes,
            NULL::VARCHAR AS never,
            'same' AS constant,
            {{'k': i % 2}} AS nested,
            ST_Point(70 + i / 10, 20 + i / 20) AS geometry
          FROM range(60) t(i)
        ) TO '{path}' (FORMAT PARQUET)""")
    return path


class CountingCon:
    """A DuckDB connection that counts the queries reading `path` (DESCRIBE
    reads only the footer, so it isn't a scan)."""

    def __init__(self, path: Path):
        self.con = duckdb.connect()
        self.con.execute('INSTALL spatial; LOAD spatial')
        self.path, self.scans = str(path), 0

    def execute(self, sql: str, *a):
        if self.path in sql and not sql.lstrip().upper().startswith('DESCRIBE'):
            self.scans += 1
        return self.con.execute(sql, *a)

    def __getattr__(self, name):
        return getattr(self.con, name)
