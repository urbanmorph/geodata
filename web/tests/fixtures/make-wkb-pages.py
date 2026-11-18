"""Fixtures for tests/parquet-column-stream.test.ts: a WKB column over several
pages and row groups, with nulls, in the page layouts the streaming reader
supports (v1 ZSTD, v2 SNAPPY, v1 uncompressed REQUIRED) and one it refuses
(dictionary-encoded). Row i is LINESTRING of (i % 40) + 2 points (i, k);
every 7th row is null in the nullable files.

    uv run --no-project --with pyarrow python web/tests/fixtures/make-wkb-pages.py
"""
import struct
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

OUT = Path(__file__).parent
ROWS = 600


def line(i: int) -> bytes:
    n = (i % 40) + 2
    return struct.pack('<BII', 1, 2, n) + b''.join(struct.pack('<dd', i, k) for k in range(n))


def table(nullable: bool) -> pa.Table:
    geoms = [None if nullable and i % 7 == 3 else line(i) for i in range(ROWS)]
    field = pa.field('geometry', pa.binary(), nullable=nullable)
    return pa.table({'id': pa.array(list(range(ROWS)), pa.int32()), 'geometry': pa.array(geoms, pa.binary())},
                    schema=pa.schema([pa.field('id', pa.int32()), field]))


common = dict(row_group_size=250, data_page_size=4000, write_batch_size=10, write_statistics=False)
pq.write_table(table(True), OUT / 'wkb-pages-v1-zstd.parquet', compression='zstd',
               use_dictionary=False, data_page_version='1.0', **common)
pq.write_table(table(True), OUT / 'wkb-pages-v2-snappy.parquet', compression='snappy',
               use_dictionary=False, data_page_version='2.0', **common)
pq.write_table(table(False), OUT / 'wkb-pages-v1-required.parquet', compression='none',
               use_dictionary=False, data_page_version='1.0', **common)
pq.write_table(table(True), OUT / 'wkb-pages-dict.parquet', compression='zstd',
               use_dictionary=True, data_page_version='1.0', **common)
