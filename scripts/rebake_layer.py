#!/usr/bin/env python3
"""Give a catalog layer's parquet the flat bbox columns /api/v1/nearby needs.

Without xmin/ymin/xmax/ymax, /nearby decodes every geometry of the layer and
runs out of Worker CPU (Cloudflare 1102). Per layer:
  1. skip it when its parquet already has the 4 columns (read from the footer)
  2. download the parquet (cached in WORK/<id>/; a killed run keeps it)
  3. rebake_flatten_bbox: add bbox columns from each geometry's extent,
     Hilbert-sort the rows, density-aware row groups, ZSTD
  4. verify: same rows, the original columns with the same names and types in
     the same order plus the 4 bbox columns, and the same values (an
     order-free hash over every original column, geometry as WKB)
  5. upload to <stem>.<md5[:8]>.parquet next to the old key (R2 objects are
     served immutable, so a key is never rewritten), md5-skipped, holding the
     shared upload lock only while uploading
  6. patch catalog.json (parquet url + bytes) and the ingest manifest in
     place, after each layer

The source data is never changed: no column is dropped, renamed or cleaned.
A GeoParquet `bbox` struct stays; the flat columns are copied from it.
build_catalog.py and ingest_ramseraph.py keep the versioned key on a rebuild
(scripts/tile_keys.py). The old keys stay on R2 until the deploy that stops
using them; delete them by hand after that.

Run (R2 creds in the env: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY):
    python3 -u scripts/rebake_layer.py --missing             # every layer without bbox columns
    python3 -u scripts/rebake_layer.py soi_states lgd_blocks
    python3 -u scripts/rebake_layer.py --missing --no-upload # build + verify only
    python3 -u scripts/rebake_layer.py --minutes 60 ...      # stop cleanly between steps

Idempotent: a layer with bbox columns is skipped, each step's output is kept
(written atomically), the key is the file's md5, uploads skip on an md5 match
and the catalog patch is by layer id.
"""
from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

import duckdb

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from bake_land_water import Deadline, OutOfTime, cached, r2_client, upload  # noqa: E402
from pipeline import (  # noqa: E402
    R2_PUBLIC, _remote_has, download, file_md5, log, make_con, rebake_flatten_bbox, write_json,
)
from tile_keys import versioned_key  # noqa: E402

CATALOG = ROOT / 'catalog.json'
MANIFEST = HERE / 'external-ingested.json'
WORK = Path(os.environ.get('REBAKE_WORK', '/tmp/rebake_layer'))
LOCK_OWNER = 'rebake_layer (fix/parquet-bbox-rebake)'
BBOX = ('xmin', 'ymin', 'xmax', 'ymax')
CRS84 = "GEOMETRY('OGC:CRS84')"
REPORT = 'report.json'


def find_layer(catalog: dict, layer_id: str) -> dict:
    for layer in catalog.get('layers', []):
        if layer.get('id') == layer_id:
            return layer
    raise KeyError(f'layer {layer_id!r} not found in catalog')


def r2_key_from_url(url: str) -> str:
    """Strip the R2 public host prefix; what's left is the bucket-relative key."""
    prefix = R2_PUBLIC + '/'
    if not url.startswith(prefix):
        raise ValueError(f'not an R2 public URL: {url}')
    return url[len(prefix):]


# ── checks ───────────────────────────────────────────────────────────────────

def _con(src: str) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    if src.startswith('http'):
        con.execute('INSTALL httpfs; LOAD httpfs')
    return con


def bbox_kind(src: str) -> str | None:
    """'flat' when the parquet (path or URL; only the footer is read) has
    top-level xmin/ymin/xmax/ymax columns, 'struct' when it has a GeoParquet
    `bbox` struct instead, else None."""
    cols = {r[0] for r in _con(src).execute('DESCRIBE SELECT * FROM read_parquet(?)', [src]).fetchall()}
    if all(c in cols for c in BBOX):
        return 'flat'
    return 'struct' if 'bbox' in cols else None


def missing_bbox(catalog: dict, kind: Callable[[str], str | None] = bbox_kind) -> dict[str, list[str]]:
    """Ids of catalog layers whose parquet lacks flat bbox columns, in catalog
    order: {'none': [...], 'struct': [...]} ('struct': only a GeoParquet `bbox`
    struct, which the rebake keeps, adding the flat columns from it)."""
    layers = [(layer['id'], layer['parquet']['url']) for layer in catalog['layers']
              if (layer.get('parquet') or {}).get('url')]
    with ThreadPoolExecutor(16) as pool:
        kinds = list(pool.map(lambda t: kind(t[1]), layers))
    return {'none': [lid for (lid, _), k in zip(layers, kinds) if k is None],
            'struct': [lid for (lid, _), k in zip(layers, kinds) if k == 'struct']}


def _fingerprint(con, path: Path, cols: list[tuple[str, str]]) -> tuple:
    """Rows and an order-free hash of every row over `cols` (geometry as WKB)."""
    exprs = ', '.join(f'ST_AsWKB("{c}")' if 'GEOMETRY' in t else f'"{c}"' for c, t in cols)
    return con.execute(f'SELECT count(*), sum(hash({exprs})::HUGEINT), bit_xor(hash({exprs})) '
                       f"FROM read_parquet('{path}')").fetchone()


def _row_groups(con, path: Path) -> int:
    return con.execute(f"SELECT count(DISTINCT row_group_id) FROM parquet_metadata('{path}')").fetchone()[0]


def verify(src: Path, dst: Path) -> dict:
    """Raise ValueError unless `dst` is `src` plus the 4 bbox columns: same
    rows, same columns (names, types, order) and the same values. Geometry
    without a CRS reads back as OGC:CRS84, the GeoParquet default it meant."""
    con = make_con()
    old = [(r[0], r[1]) for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{src}')").fetchall()]
    same = [(c, CRS84 if t == 'GEOMETRY' else t) for c, t in old]
    new = [(r[0], r[1]) for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{dst}')").fetchall()]
    rows_old, rows_new = (con.execute(f"SELECT count(*) FROM read_parquet('{p}')").fetchone()[0] for p in (src, dst))
    if rows_old != rows_new:
        raise ValueError(f'rows changed: {rows_old:,} -> {rows_new:,}')
    if [c for c in new if c[0] not in BBOX] != same or [c for c, _ in new if c in BBOX] != list(BBOX):
        raise ValueError(f'columns changed: {old} -> {new}')
    if _fingerprint(con, src, old) != _fingerprint(con, dst, old):
        raise ValueError('values changed: the hash over the original columns differs')
    return {'rows': rows_new, 'columns': len(old), 'row_groups': (_row_groups(con, src), _row_groups(con, dst))}


# ── publish ──────────────────────────────────────────────────────────────────

def patch_catalog(lid: str, key: str, nbytes: int, catalog: Path = CATALOG, manifest: Path = MANIFEST) -> None:
    """Point the layer's parquet block at `key` (url + bytes; the rest stays),
    and the ingest manifest row too: build_catalog.py templates the URL from it."""
    c = json.loads(catalog.read_text())
    layer = find_layer(c, lid)
    layer['parquet'] = {**layer['parquet'], 'url': f'{R2_PUBLIC}/{key}', 'bytes': nbytes}
    write_json(catalog, c)
    rows = json.loads(manifest.read_text())
    for r in rows:
        if r.get('id') == lid and key.startswith(f"{r.get('r2_prefix')}/"):
            r['parquet_file'], r['parquet_bytes'] = key.rsplit('/', 1)[1], nbytes
    write_json(manifest, rows)


def publish(local: Path, key: str) -> None:
    from rebake_tiles import upload_lock
    s3 = r2_client()
    if not _remote_has(s3, key, file_md5(local)):  # the md5 skip, before taking the upload lock
        with upload_lock(owner=LOCK_OWNER):
            upload(s3, local, key)


def rebake(layer: dict, deadline: Deadline, upload: bool = True) -> dict | None:
    """Rebake one layer; None when it already has flat bbox columns. A `bbox`
    struct stays as it is; the flat columns are added beside it."""
    lid, url = layer['id'], layer['parquet']['url']
    if bbox_kind(url) == 'flat':
        log(f'  {lid}: has flat bbox columns, skipped')
        return None
    work = WORK / lid
    src = work / url.rsplit('/', 1)[1]
    deadline.check(f'{lid} download')
    download(url, src)
    deadline.check(f'{lid} rebake')
    dst = cached(work / f'{lid}.bbox.parquet',
                 lambda part: rebake_flatten_bbox(src, part, make_con(), keep_struct=True))
    checks = verify(src, dst)
    key = versioned_key(r2_key_from_url(url), file_md5(dst))
    out = {'old_key': r2_key_from_url(url), 'new_key': key, 'old_bytes': src.stat().st_size,
           'new_bytes': dst.stat().st_size, **checks}
    log(f"  {lid}: {out['rows']:,} rows, {out['columns']} columns unchanged; row groups "
        f"{checks['row_groups'][0]} -> {checks['row_groups'][1]}; {out['old_bytes']:,} -> {out['new_bytes']:,} bytes")
    if upload:
        deadline.check(f'{lid} upload')
        publish(dst, key)
        patch_catalog(lid, key, out['new_bytes'])
        log(f'  {lid}: on R2 as {key}; catalog.json patched')
    return out


def save_report(lid: str, out: dict) -> None:
    path = WORK / REPORT
    report = json.loads(path.read_text()) if path.exists() else {}
    report[lid] = out
    WORK.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + '\n')


# ── CLI ──────────────────────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    args = argv[1:]
    do_upload = '--no-upload' not in args
    minutes = 600.0
    if '--minutes' in args:
        i = args.index('--minutes')
        minutes = float(args.pop(i + 1))
    ids = [a for a in args if not a.startswith('--')]
    catalog = json.loads(CATALOG.read_text())
    if '--missing' in args:
        found = missing_bbox(catalog)
        log(f"{len(found['none'])} layers without bbox columns: {found['none']}")
        log(f"{len(found['struct'])} with only a bbox struct (kept; flat columns added): {found['struct']}")
        ids += [i for i in found['none'] + found['struct'] if i not in ids]
    if not ids and '--missing' in args:
        log('nothing to rebake')
        return 0
    if not ids:
        log('Usage: rebake_layer.py [--missing] [--no-upload] [--minutes N] [<layer_id> ...]')
        return 2
    if do_upload:
        missing = [k for k in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
                   if k not in os.environ]
        if missing:
            log(f'ERROR: not set in env: {missing}')
            return 2
    deadline = Deadline(minutes)
    failed = []
    for n, lid in enumerate(ids, 1):
        log(f'\n-> [{n}/{len(ids)}] {lid}')
        try:
            out = rebake(find_layer(json.loads(CATALOG.read_text()), lid), deadline, do_upload)
            if out:
                save_report(lid, out)
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
