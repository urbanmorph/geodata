#!/usr/bin/env python3
"""
Rebake PMTiles that stop at too low a zoom for locate.

/api/v1/locate tests a point against tile geometry at the tileset's max zoom.
Layers baked with tippecanoe -zg could stop as low as z0-z4 (bharatviz_pincodes
was z4), so a point fell inside a coarse neighbouring polygon: MG Road came
back as 562157 (Bettahalsur) instead of 560001.

Per layer: parquet (from R2) -> GeoJSON (lon,lat) -> tippecanoe -z12 ->
upload to a versioned key (<name>.z12.pmtiles; the old key is served immutable
for 7 days, so it is not overwritten) -> patch catalog.json. Delete the old
keys only after the catalog change is deployed.

Run:
    set -a; source web/.dev.vars; set +a
    python3 scripts/rebake_locate_tiles.py --no-upload   # build + check only
    python3 scripts/rebake_locate_tiles.py               # build, upload, patch catalog

Idempotent: downloads are cached in WORK, uploads skip on a matching md5,
and the catalog patch is keyed by layer id.
"""
from __future__ import annotations

import copy
import json
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from ingest_ramseraph import R2_PUBLIC, r2_client, r2_upload  # noqa: E402

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
WORK = Path('/tmp/rebake_locate_tiles')
MAX_ZOOM = 12

# Polygon layers whose tiles stop below z10 (audit, Nov 2026).
LAYERS = ['bharatviz_pincodes', 'bda_jurisdiction', 'wards_hyderabad', 'wards_delhi',
          'wards_chandigarh', 'wards_vadodara', 'wards_faridabad']


def tippecanoe_cmd(geojson: Path, out: Path, layer: str) -> list[str]:
    return ['tippecanoe', '-o', str(out), '-l', layer, '-Z0', f'-z{MAX_ZOOM}',
            '--drop-densest-as-needed', '--extend-zooms-if-still-dropping',
            '--force', '--quiet', str(geojson)]


def versioned_key(pmtiles_url: str) -> str:
    key = pmtiles_url.split('.r2.dev/', 1)[1]
    stem = key[:-len('.pmtiles')]
    suffix = f'.z{MAX_ZOOM}'
    return key if stem.endswith(suffix) else f'{stem}{suffix}.pmtiles'


def patched_layer(layer: dict, r2_public: str, key: str, nbytes: int) -> dict:
    out = copy.deepcopy(layer)
    out['pmtiles'] = {**out.get('pmtiles', {}), 'url': f'{r2_public}/{key}', 'bytes': nbytes}
    return out


def download(url: str, dest: Path) -> None:
    # R2's public endpoint rejects Python's default User-Agent (403).
    if dest.exists() and dest.stat().st_size > 0:
        return
    req = urllib.request.Request(url, headers={'User-Agent': 'curl/8'})
    with urllib.request.urlopen(req, timeout=300) as r, dest.open('wb') as f:
        shutil.copyfileobj(r, f)


def bake(layer: dict) -> Path:
    lid = layer['id']
    WORK.mkdir(parents=True, exist_ok=True)
    pq = WORK / f'{lid}.parquet'
    download(layer['parquet']['url'], pq)
    gj = WORK / f'{lid}.geojson'
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute('SET geometry_always_xy = true')  # else EPSG:4326 writes lat,lon
    cols = con.execute(f"DESCRIBE SELECT * FROM '{pq}'").fetchall()
    geom = next(c for c, t, *_ in cols if 'GEOMETRY' in t or c in ('geometry', 'geom', 'wkb_geometry'))
    # The bbox columns serve /nearby, not map popups; leave them out of tiles.
    drop = [c for c, *_ in cols if c in ('bbox', 'xmin', 'ymin', 'xmax', 'ymax')]
    exclude = f"EXCLUDE ({', '.join(drop)})" if drop else ''
    con.execute(f"COPY (SELECT * {exclude} FROM '{pq}' WHERE {geom} IS NOT NULL) "
                f"TO '{gj}' WITH (FORMAT GDAL, DRIVER 'GeoJSON')")
    out = WORK / Path(versioned_key(layer['pmtiles']['url'])).name
    subprocess.run(tippecanoe_cmd(gj, out, lid), check=True, capture_output=True, timeout=1800)
    return out


def main(argv: list[str]) -> int:
    upload = '--no-upload' not in argv
    catalog = json.loads(CATALOG.read_text())
    by_id = {l['id']: l for l in catalog['layers']}
    s3 = r2_client() if upload else None
    for lid in LAYERS:
        layer = by_id[lid]
        out = bake(layer)
        key = versioned_key(layer['pmtiles']['url'])
        print(f'{lid}: {out} ({out.stat().st_size:,} bytes) -> {key}')
        if upload:
            r2_upload(s3, out, key)
            by_id[lid] = patched_layer(layer, R2_PUBLIC, key, out.stat().st_size)
    if upload:
        catalog['layers'] = [by_id[l['id']] for l in catalog['layers']]
        CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=True) + '\n')
        print('catalog.json patched')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
