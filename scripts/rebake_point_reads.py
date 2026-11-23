#!/usr/bin/env python3
"""Lay a catalog layer's parquet out for cheap point lookups (/api/v1/ground, /surface).

A point lookup (web/functions/lib/nearby.ts) finds the rows near a point by their
bbox columns, then decodes the columns it shows for those rows only. hyparquet
(1.26) decodes a column chunk page by page and skips the pages before the first
row it needs, but it always decodes the chunk's dictionary page and it reads no
page index (column/offset index). The DuckDB-written files held each column of
a row group (up to 122,880 rows) in one large page with a dictionary, so one
Soil Health Card answer decompressed 15 such pages: 35-50% of a ground answer's
CPU. Measured on 32 points per layer (supporting numbers in the PR):

  * small data pages (8 KB) and no dictionary pages: the answer decodes one
    small page per column (slusi_soil_health 80 ms -> 6-8 ms CPU per point);
  * rows per row group trade the footer (parsed once per fresh isolate; past
    about 512 KB it takes a second read, FOOTER_READ_BYTES) against the bbox
    columns decoded per row group on a cache miss: see PLAN;
  * codec stays ZSTD (one exception in PLAN): hyparquet-compressors' LZ4 failed
    on pyarrow's LZ4 pages, its SNAPPY instantiates WebAssembly (which Workers
    refuse), and uncompressed doubled slusi_soil_health for a few ms;
  * the page index is written for readers that use it (DuckDB-WASM, a later
    hyparquet with useOffsetIndex); hyparquet as called today ignores it.

Per layer: download the published parquet (cached), rewrite it with pyarrow in
the same row order, verify, upload to <stem>.<md5[:8]>.parquet next to the old
key (md5-skipped, never overwriting: new_only), and patch catalog.json and the
ingest manifest (rebake_layer.patch_catalog). The data is never changed: the
same rows in the same order, the same columns and types, the same values and
the same key-value metadata (GeoParquet `geo`), checked by an order-sensitive
hash over every column and row. Old keys stay on R2 (nothing is deleted).

Run (R2 creds in the env: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY):
    python3 -u scripts/rebake_point_reads.py                    # every layer in PLAN
    python3 -u scripts/rebake_point_reads.py slusi_soil_health
    python3 -u scripts/rebake_point_reads.py --no-upload ...    # build + verify only
    python3 -u scripts/rebake_point_reads.py --minutes 60 ...   # stop cleanly between steps

Idempotent: a layer whose catalog key is the one this script published (WORK/report.json)
is skipped; each step's output is kept (written atomically); uploads skip on an md5 match;
the catalog patch is by layer id.
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from pipeline import (  # noqa: E402
    Deadline, OutOfTime, _remote_has, cached, download, file_md5, log, make_con, patient_r2_client,
    r2_upload_retrying, upload_lock, work_dir,
)
from rebake_layer import CATALOG, find_layer, patch_catalog, r2_key_from_url  # noqa: E402
from tile_keys import versioned_key  # noqa: E402

WORK = work_dir('point_reads', 'POINT_READS_WORK')
REPORT = 'report.json'
LOCK_OWNER = 'rebake_point_reads (data/point-read-rebake)'
ZSTD_LEVEL = 9
BATCH_ROWS = 65_536


@dataclass(frozen=True)
class Layout:
    rows_per_group: int
    page_bytes: int = 8192
    dictionary: bool = False
    compression: str = 'zstd'


# Chosen by measurement (a bench over 32 points per layer: CPU per answer with every
# cache cold, with the footer kept, and with the footer and bbox columns kept; footer
# bytes and parse; file bytes). Rows per group keep each footer under FOOTER_READ_BYTES
# (one tail read) and its parse near the old one's.
# Measured and left as published: wris_dams (5 ms an answer at most), overture_places_india
# (its answer shows no rows, so only its footer and bbox columns cost; no layout tried beat
# the published one, and pyarrow's nested encoding grew it 25%), wris_waterbodies (read from
# its map tiles, not the parquet), udise_schools (4.7 -> 1.8 ms an answer, but without
# DuckDB's dictionaries it grew from 93 to 101-105 MB, past LARGE_FILTER_BYTES (100 MB),
# which would move its Filter & export panel from the browser to the server).
PLAN: dict[str, Layout] = {
    # 80 -> 6 ms an answer; bbox columns of a row group 185 -> 108 ms; footer 180 -> 411 KB
    'slusi_soil_health': Layout(rows_per_group=65_536),
    # 20 -> 2.6 ms an answer (it shows every column); the same row groups
    'nic_health': Layout(rows_per_group=20_480),
    # One row, India's outline, read whole by a fresh isolate: unpacking its ZSTD was 57 of
    # 64 ms. Uncompressed, 3.2 -> 5.1 MB (under nearby-geometry's 8 MB whole-file limit).
    'india_boundary': Layout(rows_per_group=1, compression='none'),
}


# ── rewrite ──────────────────────────────────────────────────────────────────

def rewrite(src: Path, dst: Path, layout: Layout) -> None:
    """`src`'s rows, in order, to `dst` as `layout`: exactly rows_per_group rows a
    group (the last holds the rest), data pages of about page_bytes, its codec, page
    index and min/max statistics on, the schema and key-value metadata as they were."""
    f = pq.ParquetFile(src)
    schema = f.schema_arrow
    n = layout.rows_per_group
    with pq.ParquetWriter(
        dst, schema, compression=layout.compression,
        compression_level=ZSTD_LEVEL if layout.compression == 'zstd' else None, data_page_size=layout.page_bytes,
        use_dictionary=layout.dictionary, write_page_index=True, write_statistics=True, store_schema=False,
    ) as w:
        held: list[pa.RecordBatch] = []
        rows = 0
        for batch in f.iter_batches(batch_size=BATCH_ROWS):
            held.append(batch)
            rows += batch.num_rows
            while rows >= n:
                table = pa.Table.from_batches(held, schema=schema)
                w.write_table(table.slice(0, n), row_group_size=n)
                rest = table.slice(n)
                held, rows = rest.to_batches(), rest.num_rows
        if rows:
            w.write_table(pa.Table.from_batches(held, schema=schema), row_group_size=n)
        # The file's key-value metadata (GeoParquet `geo`), as it was: with store_schema
        # off pyarrow writes none of its own, and without `geo` geometry reads as BLOB.
        if f.metadata.metadata:
            w.add_key_value_metadata(f.metadata.metadata)


def describe(path: Path) -> dict:
    """Row groups, rows in the first, footer bytes and file bytes."""
    md = pq.ParquetFile(path).metadata
    with path.open('rb') as fh:
        fh.seek(-8, 2)
        footer = int.from_bytes(fh.read(4), 'little')
    return {'row_groups': md.num_row_groups, 'rows_per_group': md.row_group(0).num_rows if md.num_row_groups else 0,
            'footer_bytes': footer, 'bytes': path.stat().st_size}


def pages_in_first_chunk(path: Path, column: str) -> int:
    """Data pages in the first row group's chunk of `column`, counted by walking its page headers."""
    rg = pq.ParquetFile(path).metadata.row_group(0)
    col = next(rg.column(j) for j in range(rg.num_columns) if rg.column(j).path_in_schema == column)
    start = col.dictionary_page_offset or col.data_page_offset
    with path.open('rb') as fh:
        fh.seek(start)
        data = fh.read(col.total_compressed_size)
    pos = pages = 0
    while pos < len(data):
        kind, size, pos = _page_header(data, pos)
        pages += kind in (0, 3)  # DATA_PAGE, DATA_PAGE_V2
        pos += size
    return pages


def _page_header(data: bytes, pos: int) -> tuple[int, int, int]:
    """(page type, compressed size, end of header) of the thrift-compact PageHeader at `pos`."""
    def varint() -> int:
        nonlocal pos
        out = shift = 0
        while True:
            b = data[pos]
            pos += 1
            out |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                return out

    def zigzag(v: int) -> int:
        return (v >> 1) ^ -(v & 1)

    def skip(kind: int) -> None:  # one value of a compact type
        nonlocal pos
        if kind in (3, 4, 5, 6):  # byte, i16, i32, i64
            varint()
        elif kind == 7:  # double
            pos += 8
        elif kind == 8:  # binary
            pos += varint()
        elif kind in (9, 10):  # list, set
            head = data[pos]
            pos += 1
            for _ in range(head >> 4 if head >> 4 != 15 else varint()):
                skip(head & 0x0F)
        elif kind == 12:  # struct
            struct()

    def struct() -> dict[int, int]:
        nonlocal pos
        ints: dict[int, int] = {}
        fid = 0
        while True:
            b = data[pos]
            pos += 1
            if b == 0:
                return ints
            fid = fid + (b >> 4) if b >> 4 else zigzag(varint())
            if b & 0x0F == 5:
                ints[fid] = zigzag(varint())
            else:
                skip(b & 0x0F)

    ints = struct()
    return ints[1], ints[3], pos


# ── checks ───────────────────────────────────────────────────────────────────

def _columns(con, path: Path) -> list[tuple[str, str]]:
    return [(r[0], r[1]) for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()]


def fingerprint(path: Path) -> list:
    """Rows and an order-sensitive hash of every row over every column (geometry as WKB):
    each row's hash includes its row number, so a reordered file differs."""
    con = make_con()
    exprs = ', '.join(f'ST_AsWKB("{c}")' if 'GEOMETRY' in t else f'"{c}"' for c, t in _columns(con, path))
    row = con.execute(
        f'SELECT count(*), sum(hash(file_row_number, {exprs})::HUGEINT), bit_xor(hash(file_row_number, {exprs})) '
        f"FROM read_parquet('{path}', file_row_number = true)").fetchone()
    return [int(v) for v in row]


def _kv(path: Path) -> dict[bytes, bytes]:
    return dict(pq.ParquetFile(path).metadata.metadata or {})


def verify(src: Path, dst: Path) -> dict:
    """Raise ValueError unless `dst` holds exactly `src`'s data: the same columns
    (names, types, order), the same key-value metadata, and the same rows with the
    same values in the same order."""
    con = make_con()
    old, new = _columns(con, src), _columns(con, dst)
    if old != new:
        raise ValueError(f'columns changed: {old} -> {new}')
    if _kv(src) != _kv(dst):
        raise ValueError(f'metadata changed: {sorted(_kv(src))} -> {sorted(_kv(dst))}')
    a, b = fingerprint(src), fingerprint(dst)
    if a[0] != b[0]:
        raise ValueError(f'rows changed: {a[0]:,} -> {b[0]:,}')
    if a != b:
        raise ValueError('values or order changed: the order-sensitive hash over every column differs')
    return {'rows': a[0], 'columns': len(old), 'checksum': a}


# ── publish ──────────────────────────────────────────────────────────────────

def publish(local: Path, key: str) -> None:
    """Upload to a new key; never overwrite other bytes (new_only), skip the same bytes."""
    s3 = patient_r2_client()
    if not _remote_has(s3, key, file_md5(local), new_only=True):
        with upload_lock(owner=LOCK_OWNER):
            r2_upload_retrying(s3, local, key, new_only=True)


def load_report() -> dict:
    path = WORK / REPORT
    return json.loads(path.read_text()) if path.exists() else {}


def save_report(lid: str, out: dict) -> None:
    report = load_report()
    report[lid] = out
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / REPORT).write_text(json.dumps(report, indent=2) + '\n')


def rebake(layer: dict, layout: Layout, deadline: Deadline, upload: bool = True) -> dict | None:
    """Re-lay one layer; None when its catalog key is already the one this script made."""
    lid, url = layer['id'], layer['parquet']['url']
    key_now = r2_key_from_url(url)
    if load_report().get(lid, {}).get('new_key') == key_now:
        log(f'  {lid}: already laid out for point reads ({key_now}), skipped')
        return None
    work = WORK / lid
    src = work / url.rsplit('/', 1)[1]
    deadline.check(f'{lid} download')
    download(url, src)
    deadline.check(f'{lid} rewrite')
    dst = cached(work / f'{lid}.point_reads.parquet', lambda part: rewrite(src, part, layout))
    deadline.check(f'{lid} verify')
    checks = verify(src, dst)
    key = versioned_key(key_now, file_md5(dst))
    out = {'old_key': key_now, 'new_key': key, 'layout': asdict(layout),
           'old': describe(src), 'new': describe(dst), **checks}
    log(f"  {lid}: {out['rows']:,} rows, {out['columns']} columns, same values in the same order; row groups "
        f"{out['old']['row_groups']} -> {out['new']['row_groups']}; footer {out['old']['footer_bytes']:,} -> "
        f"{out['new']['footer_bytes']:,} B; {out['old']['bytes']:,} -> {out['new']['bytes']:,} B")
    if upload:
        deadline.check(f'{lid} upload')
        publish(dst, key)
        patch_catalog(lid, key, out['new']['bytes'])
        log(f'  {lid}: on R2 as {key}; catalog.json patched')
        save_report(lid, out)
    return out


# ── CLI ──────────────────────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    args = argv[1:]
    do_upload = '--no-upload' not in args
    minutes = 600.0
    if '--minutes' in args:
        i = args.index('--minutes')
        minutes = float(args.pop(i + 1))
    ids = [a for a in args if not a.startswith('--')] or list(PLAN)
    unknown = [i for i in ids if i not in PLAN]
    if unknown:
        log(f'ERROR: no layout planned for {unknown}; add them to PLAN')
        return 2
    if do_upload:
        missing = [k for k in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY') if k not in os.environ]
        if missing:
            log(f'ERROR: not set in env: {missing}')
            return 2
    deadline = Deadline(minutes)
    failed = []
    for n, lid in enumerate(ids, 1):
        log(f'\n-> [{n}/{len(ids)}] {lid}')
        try:
            rebake(find_layer(json.loads(CATALOG.read_text()), lid), PLAN[lid], deadline, do_upload)
        except OutOfTime as e:
            log(f'STOPPED: {e}; finished steps are kept, re-run to continue')
            return 3
        except (KeyError, ValueError, OSError, duckdb.Error) as e:
            log(f'  FAILED {lid}: {e}')
            failed.append(lid)
    if failed:
        log(f'\nfailed: {failed}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.stdout.reconfigure(line_buffering=True)
    sys.exit(main(sys.argv))
