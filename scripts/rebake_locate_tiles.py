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

Idempotent: downloads are cached in WORK, the GeoJSON and tiles are rebuilt
only when older than what they are made from, uploads skip on a matching md5,
and catalog.json is patched (by layer id) after each layer, so a killed run
keeps every layer it finished.
"""
from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from bake_formats import pmtiles_args  # noqa: E402
from pipeline import (  # noqa: E402
    R2_PUBLIC,
    atomic_output,
    download,
    is_fresh,
    make_con,
    r2_client,
    r2_upload,
    write_json,
)

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
WORK = Path('/tmp/rebake_locate_tiles')
MAX_ZOOM = 12

# Polygon layers whose tiles stop below z10 (audit, Nov 2026).
LAYERS = ['bharatviz_pincodes', 'bda_jurisdiction', 'wards_hyderabad_osm', 'wards_delhi',
          'wards_chandigarh', 'wards_vadodara', 'wards_faridabad']


def tippecanoe_cmd(geojson: Path, out: Path, layer: str) -> list[str]:
    return pmtiles_args(geojson, out, layer, (), max_zoom=MAX_ZOOM)


def versioned_key(pmtiles_url: str) -> str:
    key = pmtiles_url.split('.r2.dev/', 1)[1]
    stem = key[:-len('.pmtiles')]
    suffix = f'.z{MAX_ZOOM}'
    return key if stem.endswith(suffix) else f'{stem}{suffix}.pmtiles'


def patched_layer(layer: dict, r2_public: str, key: str, nbytes: int) -> dict:
    out = copy.deepcopy(layer)
    out['pmtiles'] = {**out.get('pmtiles', {}), 'url': f'{r2_public}/{key}', 'bytes': nbytes}
    return out


def bake(layer: dict) -> Path:
    lid = layer['id']
    WORK.mkdir(parents=True, exist_ok=True)
    pq = WORK / f'{lid}.parquet'
    download(layer['parquet']['url'], pq)
    gj = WORK / f'{lid}.geojson'
    if not is_fresh(gj, pq):
        con = make_con()  # keeps lon,lat for EPSG:4326-tagged geometry
        cols = con.execute(f"DESCRIBE SELECT * FROM '{pq}'").fetchall()
        geom = next(c for c, t, *_ in cols if 'GEOMETRY' in t or c in ('geometry', 'geom', 'wkb_geometry'))
        # The bbox columns serve /nearby, not map popups; leave them out of tiles.
        drop = [c for c, *_ in cols if c in ('bbox', 'xmin', 'ymin', 'xmax', 'ymax')]
        exclude = f"EXCLUDE ({', '.join(drop)})" if drop else ''
        with atomic_output(gj) as part:
            con.execute(f"COPY (SELECT * {exclude} FROM '{pq}' WHERE {geom} IS NOT NULL) "
                        f"TO '{part}' WITH (FORMAT GDAL, DRIVER 'GeoJSON')")
    out = WORK / Path(versioned_key(layer['pmtiles']['url'])).name
    if not is_fresh(out, gj):
        with atomic_output(out) as part:
            subprocess.run(tippecanoe_cmd(gj, part, lid), check=True, capture_output=True, timeout=1800)
    return out


def main(argv: list[str]) -> int:
    upload = '--no-upload' not in argv
    s3 = r2_client() if upload else None
    for lid in LAYERS:
        catalog = json.loads(CATALOG.read_text())
        layer = next(l for l in catalog['layers'] if l['id'] == lid)
        out = bake(layer)
        key = versioned_key(layer['pmtiles']['url'])
        print(f'{lid}: {out} ({out.stat().st_size:,} bytes) -> {key}', flush=True)
        if upload:
            r2_upload(s3, out, key)
            new = patched_layer(layer, R2_PUBLIC, key, out.stat().st_size)
            catalog['layers'] = [new if l['id'] == lid else l for l in catalog['layers']]
            write_json(CATALOG, catalog)  # after each layer: a kill keeps the finished ones
            print(f'  catalog.json patched for {lid}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
