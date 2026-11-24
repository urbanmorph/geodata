#!/usr/bin/env python3
"""
Rebake PMTiles that stop at too low a zoom for locate.

/api/v1/locate tests a point against tile geometry at the tileset's max zoom.
Layers baked with tippecanoe -zg could stop as low as z0-z4 (bharatviz_pincodes
was z4), so a point fell inside a coarse neighbouring polygon: MG Road came
back as 562157 (Bettahalsur) instead of 560001.

Per layer: parquet (from R2) -> GeoJSON (lon,lat) -> tippecanoe -z12 ->
upload to a content-versioned key (<stem>.<md5[:8]>.pmtiles; a published key
never gets new bytes) -> patch catalog.json. Old keys stay on R2 (only
r2_prune.py prunes old tiles).

FINISHED ONE-OFF (Nov 2026): every layer in LAYERS is on z12 tiles. A layer
whose catalog tiles are already rebaked (tile_keys.is_rebaked: this script's
.z12 keys or rebake_tiles' popup-field tiles) is skipped, so a rerun cannot
put every column back over rebake_tiles' tiles; --force rebakes it anyway (to
a new key). For new tiles use scripts/rebake_tiles.py.

Run:
    set -a; source web/.dev.vars; set +a
    python3 scripts/oneoff/rebake_locate_tiles.py --no-upload   # build + check only
    python3 scripts/oneoff/rebake_locate_tiles.py [--force]     # build, upload, patch catalog

Idempotent: downloads are cached in WORK, the GeoJSON and tiles are rebuilt
only when older than what they are made from, uploads skip on a matching md5,
and catalog.json is patched (by layer id) after each layer, so a killed run
keeps every layer it finished.
"""
from __future__ import annotations

import copy
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent  # scripts/
sys.path.insert(0, str(HERE))
from bake_formats import pmtiles_args  # noqa: E402
from pipeline import (  # noqa: E402
    R2_PUBLIC,
    public_r2_key,
    atomic_output,
    download,
    file_md5,
    is_fresh,
    make_con,
    r2_client,
    r2_upload,
    write_json,
    work_dir,
)
from tile_keys import is_rebaked, versioned_key  # noqa: E402

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
WORK = work_dir('rebake_locate_tiles', legacy='/tmp/rebake_locate_tiles')
MAX_ZOOM = 12

# Polygon layers whose tiles stop below z10 (audit, Nov 2026).
LAYERS = ['bharatviz_pincodes', 'bda_jurisdiction', 'wards_hyderabad_osm', 'wards_delhi',
          'wards_chandigarh', 'wards_vadodara', 'wards_faridabad']


def tippecanoe_cmd(geojson: Path, out: Path, layer: str) -> list[str]:
    return pmtiles_args(geojson, out, layer, (), max_zoom=MAX_ZOOM)


def tiles_key(pmtiles_url: str, tiles: Path) -> str:
    """<stem>.<md5[:8]>.pmtiles beside the layer's current tiles (an earlier
    .z12 or md5 suffix replaced, not stacked)."""
    key = public_r2_key(pmtiles_url)  # the data domain or the old r2.dev address
    if key is None:
        raise ValueError(f'not an R2 public URL: {pmtiles_url}')
    return versioned_key(re.sub(rf'\.z{MAX_ZOOM}(?=\.pmtiles$)', '', key), file_md5(tiles))


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
    out = WORK / f'{lid}.pmtiles'
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
        if is_rebaked(layer.get('pmtiles')) and '--force' not in argv:
            print(f'{lid}: tiles already rebaked ({layer["pmtiles"]["url"]}); skipped (--force to rebake)', flush=True)
            continue
        out = bake(layer)
        key = tiles_key(layer['pmtiles']['url'], out)
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
