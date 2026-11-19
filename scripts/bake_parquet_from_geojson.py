#!/usr/bin/env python3
"""Give a layer that bharatlas publishes as GeoJSON only its parquet.

Every curated layer needs parquet: the viewer's Filter and export panel and the
API (query, nearby, schema) read it. gb_adm1-4 and india_boundary were published
as GeoJSON and map tiles only. Per layer:
  1. skip it when the catalog already names a parquet
  2. download the published GeoJSON (cached in WORK/<id>/, resumed after a kill,
     size and md5 checked)
  3. GeoJSON -> parquet: every feature and property as published (nothing dropped,
     renamed or cleaned), geometry as `geometry`, plus flat xmin/ymin/xmax/ymax in
     Hilbert order for /api/v1/nearby (pipeline.geojson_to_parquet)
  4. verify: the row count equals the GeoJSON's features and the catalog's rows
  5. upload to <prefix>/<stem>.<md5[:8]>.parquet next to the GeoJSON (md5-skipped,
     under the shared upload lock)
  6. fill the layer's parquet block in catalog.json in place (url + bytes)

The versioned key survives a catalog rebuild (tile_keys.keep_rebaked).

Run (R2 creds in the env: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY):
    python3 -u scripts/bake_parquet_from_geojson.py gb_adm1 gb_adm2 gb_adm3 gb_adm4 india_boundary
    python3 -u scripts/bake_parquet_from_geojson.py --no-upload gb_adm1   # build + verify only
    ... --max-minutes 60    # own time limit (default 120): stops cleanly between steps

Idempotent: a layer with a parquet is skipped, the download, the build and the
GeoJSON's feature count are cached (in data/work/), the key is the file's md5
and the upload skips on an md5 match. A run past its time limit exits 3; a
re-run continues from the cached steps.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from pipeline import (  # noqa: E402
    R2_PUBLIC, Deadline, OutOfTime, cached, download, file_md5, geojson_to_parquet, log, make_con,
    take_max_minutes, work_dir, write_json,
)
from rebake_layer import find_layer, publish, r2_key_from_url  # noqa: E402
from tile_keys import versioned_key  # noqa: E402

CATALOG = ROOT / 'catalog.json'
WORK = work_dir('bake_parquet_from_geojson', 'GEOJSON_PARQUET_WORK', legacy='/tmp/bake_parquet_from_geojson')
MAX_MINUTES = 120.0


def needs_parquet(layer: dict) -> bool:
    return not (layer.get('parquet') or {}).get('url') and bool((layer.get('geojson') or {}).get('url'))


def parquet_key(layer: dict, md5: str) -> str:
    """<prefix>/<stem>.<md5[:8]>.parquet beside the layer's GeoJSON."""
    return versioned_key(r2_key_from_url(layer['geojson']['url']), md5, 'parquet')


def build(gj: Path, out: Path, expected_rows: int | None) -> dict:
    """GeoJSON -> parquet (cached); raise ValueError when the row count is not the
    catalog's. Returns rows and columns."""
    cached(out, lambda part: geojson_to_parquet(gj, part, 'geometry', make_con()))
    con = make_con()
    rows = con.execute(f"SELECT count(*) FROM read_parquet('{out}')").fetchone()[0]
    # Counted once and kept beside the parquet: a cached run need not re-read the GeoJSON.
    count = cached(out.with_name(f'{out.stem}.features'), lambda part: part.write_text(
        str(con.execute(f"SELECT count(*) FROM ST_Read('{gj}')").fetchone()[0])))
    features = int(count.read_text())
    if rows != features:
        raise ValueError(f'{out.name}: {rows} rows from {features} GeoJSON features')
    if expected_rows is not None and rows != expected_rows:
        raise ValueError(f'{out.name}: {rows} rows, catalog says {expected_rows}')
    columns = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{out}')").fetchall()]
    return {'rows': rows, 'columns': columns}


def patch_catalog(lid: str, key: str, nbytes: int, catalog: Path = CATALOG) -> None:
    """Set the layer's parquet block to {url, bytes}, in its place in the entry."""
    c = json.loads(catalog.read_text())
    find_layer(c, lid)['parquet'] = {'url': f'{R2_PUBLIC}/{key}', 'bytes': nbytes}
    write_json(catalog, c)


def bake(layer: dict, upload: bool = True, deadline: Deadline | None = None) -> dict | None:
    lid = layer['id']
    if not needs_parquet(layer):
        log(f'  {lid}: has a parquet (or no GeoJSON), skipped')
        return None
    url = layer['geojson']['url']
    work = WORK / lid
    gj = work / url.rsplit('/', 1)[1]
    download(url, gj)
    out = work / f'{gj.stem}.parquet'
    report = build(gj, out, layer.get('rows'))
    if deadline:
        deadline.check(f'{lid} upload')
    key = parquet_key(layer, file_md5(out))
    log(f"  {lid}: {report['rows']:,} rows, {len(report['columns'])} columns, {out.stat().st_size:,} bytes -> {key}")
    if upload:
        publish(out, key)
        patch_catalog(lid, key, out.stat().st_size)
        log(f'  {lid}: on R2; catalog.json patched')
    return {**report, 'key': key, 'bytes': out.stat().st_size}


def main(argv: list[str]) -> int:
    argv, minutes = take_max_minutes(argv, MAX_MINUTES)
    upload = '--no-upload' not in argv
    ids = [a for a in argv if not a.startswith('--')]
    if not ids:
        print(__doc__)
        return 2
    deadline = Deadline(minutes)
    catalog = json.loads(CATALOG.read_text())
    try:
        for lid in ids:
            deadline.check(lid)
            bake(find_layer(catalog, lid), upload, deadline)
    except OutOfTime as e:
        print(f'STOPPED: {e}; finished steps are cached, re-run to continue', flush=True)
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
