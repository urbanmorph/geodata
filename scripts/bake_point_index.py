#!/usr/bin/env python3
"""
The merged point index: the polygon layers /api/v1/locate and the point profiles
(/api/v1/surface, /api/v1/ground) ask most, in two PMTiles archives at one zoom
(ZOOM), so a point lookup reads one tile of each instead of one of every layer.

  place  the admin layers and the open ward layers, each feature with its popup
         fields (what /locate answers today)
  zones  the national zone layers, ids only (the feature's parquet row + 1); each
         layer's popup fields are a small JSON file, one entry per row

Shapes come from each layer's parquet (exact geometry, not its tiles'); the popup
fields are the ones the layer's own tiles carry now (their vector_layers), minus GIS
artefact columns (locate leaves those out anyway). Share-alike layers (ODbL, CC-BY-SA:
the OSM-derived city wards) are never merged with others; they stay on their own tiles.

web/public/api-data/point-index.json records, per layer, the parquet (url, bytes,
etag) and the tiles (url) the index was built from. The reader
(web/functions/lib/point-index.ts) answers a layer from the index only while the
catalog still names those files; a rebaked or refreshed layer falls back to its own
tiles until this bake runs again.

Idempotent and restartable: every download and build step is cached under
data/work/point-index/ by the source's etag and the fields (written atomically, so a
killed run redoes only the step it was in); archives go to new content-versioned
keys (<name>.<md5[:8]>.pmtiles), uploads skip on an md5 match and never overwrite a
key; the manifest is rewritten only when it changes. The sources are bharatlas's own
R2 files, so the cache is the local work folder (a lost one re-downloads).

Run (R2 creds in the env: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY):
    python3 -u scripts/bake_point_index.py                 # build, upload, write the manifest
    python3 -u scripts/bake_point_index.py --no-upload     # build only
    python3 -u scripts/bake_point_index.py --minutes 60    # stop cleanly between steps
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import time
from collections.abc import Iterable
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import audit_tiles as at  # noqa: E402
from bake_filter_stats import CATALOG, source_of  # noqa: E402
from bake_formats import gis_artefact_columns  # noqa: E402
from bake_value_index import remote_etag  # noqa: E402
from pipeline import (  # noqa: E402
    ROOT, Deadline, OutOfTime, R2_PUBLIC, atomic_output, cached, download, file_md5, log, make_con,
    r2_client, r2_upload, with_retries, work_dir, write_if_changed,
)
from tile_keys import versioned_key  # noqa: E402

ZOOM = 12
MANIFEST = ROOT / 'web' / 'public' / 'api-data' / 'point-index.json'
WORK = work_dir('point-index', 'POINT_INDEX_WORK')
PREFIX = 'point-index'
TILE_TIMEOUT_S = 3600

ADMIN = ['lgd_states', 'lgd_districts', 'lgd_subdistricts', 'lgd_blocks', 'lgd_assembly', 'lgd_parliament']
WARDS = ['sbm_wards', 'wb_amrut_wards', 'wards_bengaluru_gba', 'wards_chennai', 'wards_hyderabad',
         'wards_hyderabad_osm', 'wards_mumbai', 'wards_delhi', 'wards_kolkata']
ZONES = ['seismic_zones', 'agro_climatic_zones', 'agro_ecological_zones', 'bm_eco_zones', 'biogeographic_zones',
         'wris_basin', 'wris_subbasin', 'cgwb_aquifers', 'gs_wildlife', 'cgwb_gw_extraction',
         'glhymps_permeability', 'gsi_geology_2m']
# props: 'tiles' (popup fields in each feature) or 'sidecar' (ids only; fields in a JSON per layer).
ARCHIVES = {
    'place': {'layers': ADMIN + WARDS, 'props': 'tiles'},
    'zones': {'layers': ZONES, 'props': 'sidecar'},
}

_SHARE_ALIKE = re.compile(r'odbl|share-?alike|(^|[^a-z])sa([^a-z]|$)', re.I)


def share_alike(licence: str | None) -> bool:
    """ODbL or a CC BY-SA licence: its share-alike terms would reach a file merged with other layers."""
    return bool(licence and _SHARE_ALIKE.search(licence))


def plan(catalog: dict, archives: dict = ARCHIVES) -> dict[str, list[dict]]:
    """{archive: [catalog layer, ...]}: each archive's layers that have a parquet and tiles,
    share-alike ones left out (they keep their own tiles)."""
    by_id = {layer['id']: layer for layer in catalog['layers']}
    out: dict[str, list[dict]] = {}
    for name, spec in archives.items():
        rows = []
        for lid in spec['layers']:
            layer = by_id.get(lid)
            if not layer or not (layer.get('parquet') or {}).get('url') or not (layer.get('pmtiles') or {}).get('url'):
                log(f'  {lid}: not in the catalog with a parquet and tiles; left out')
            elif share_alike(layer.get('licence')):
                log(f'  {lid}: {layer["licence"]} is share-alike; it keeps its own tiles')
            else:
                rows.append(layer)
        out[name] = rows
    return out


def tile_value(v):
    """A property as tippecanoe stores it: lists and objects become JSON text."""
    return json.dumps(v, separators=(',', ':'), ensure_ascii=False) if isinstance(v, (list, dict)) else v


def sidecar_props(lines: Iterable[str], junk: set[str]) -> list[dict | None]:
    """Each row's popup fields (nulls and GIS artefacts left out, values as the tiles hold
    them) from the layer's GeoJSONSeq, at index f - 1; None for a row with no polygon."""
    rows: dict[int, dict] = {}
    for line in lines:
        props = json.loads(line)['properties']
        f = int(props.pop('f'))
        rows[f - 1] = {k: tile_value(v) for k, v in props.items() if v is not None and k.lower() not in junk}
    return [rows.get(i) for i in range(max(rows, default=-1) + 1)]


def tippecanoe_cmd(out: Path, inputs: list[tuple[str, Path]], ids_only: bool) -> list[str]:
    """One zoom, every feature kept (no dropping, no tile size limit), no buffer (a point is
    tested in its own tile), each layer named by its id, the feature id from `f`."""
    layers = [x for lid, path in inputs for x in ('-L', f'{lid}:{path}')]
    return ['tippecanoe', '-o', str(out), f'-Z{ZOOM}', f'-z{ZOOM}', '-pk', '-pf', '-b0', '--read-parallel',
            '--quiet', '--force', '--use-attribute-for-id=f', *(['-y', 'f'] if ids_only else []), *layers]


def build_key(inputs: list[tuple[str, str, list[str]]], ids_only: bool) -> str:
    """A short hash of what an archive is built from: layers, their parquet etags and fields,
    and the command; the same inputs give the same file name, so a re-run builds nothing."""
    spec = {'inputs': inputs, 'ids_only': ids_only, 'cmd': tippecanoe_cmd(Path('o'), [], ids_only)}
    return hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:12]


def manifest(archives: dict[str, dict], layers: list[tuple[str, dict, str, dict | None]]) -> dict:
    """The reader's manifest: each archive's url and size, and per layer the files it was built from."""
    return {
        'zoom': ZOOM,
        'archives': archives,
        'layers': {layer['id']: {
            'archive': name, 'parquet': source_of(layer), 'etag': etag, 'pmtiles': layer['pmtiles']['url'],
            **({'props': props} if props else {}),
        } for name, layer, etag, props in layers},
    }


# ── steps ────────────────────────────────────────────────────────────────────

def _q(col: str) -> str:
    return '"' + col.replace('"', '""') + '"'


def fetch(layer: dict, etag: str) -> Path:
    """The layer's parquet, downloaded once per etag (resumable)."""
    dest = WORK / 'src' / f"{layer['id']}.{etag}.parquet"
    download(layer['parquet']['url'], dest)
    want = layer['parquet'].get('bytes')
    if want is not None and dest.stat().st_size != want:
        dest.unlink()
        raise OSError(f"{layer['id']}: downloaded {dest.name} is not the catalog's {want:,} bytes; re-run")
    return dest


def fields_of(layer: dict, tiles_etag: str, junk: set[str]) -> list[str]:
    """The popup fields the layer's tiles carry now (two range reads, cached by the tiles' etag,
    so tiles uploaded again under the same key are read again)."""
    url = layer['pmtiles']['url']
    out = WORK / 'fields' / f"{layer['id']}.{tiles_etag}.json"
    cached(out, lambda p: p.write_text(json.dumps(at.archive_fields(at.http_reader(url)))))
    return [f for f in json.loads(out.read_text()) if f.lower() not in junk]


def export(con, src: Path, fields: list[str], out: Path) -> None:
    """GeoJSONSeq of the layer's polygons (the polygon parts of a collection) with its popup
    fields and f = the parquet row + 1, written as the per-layer tile bake writes it."""
    described = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{src}')").fetchall()
    cols = {r[0]: r[1] for r in described}
    geom = next((c for c, t in cols.items() if t.upper().startswith('GEOMETRY')), None)
    g = _q(geom) if geom else f"ST_GeomFromWKB({_q(next(c for c in cols if c.lower() in ('geometry', 'geom')))})"
    if 'f' in fields:
        raise ValueError(f'{src.name}: a popup field named "f" clashes with the feature id')
    missing = [c for c in fields if c not in cols]
    if missing:  # the layer's own tiles carry a field the parquet lacks: the index would answer without it
        raise ValueError(f'{src.name}: its tiles carry {missing}, which the parquet has not; '
                         'leave the layer out or rebake its tiles')
    keep = ''.join(f'{_q(c)}, ' for c in fields)
    con.execute(f"""COPY (SELECT * FROM (
          SELECT {keep}(file_row_number + 1)::BIGINT AS f,
                 CASE WHEN ST_GeometryType({g})::VARCHAR IN ('POLYGON', 'MULTIPOLYGON') THEN {g}
                      ELSE ST_CollectionExtract({g}, 3) END AS geometry
          FROM read_parquet('{src}', file_row_number = true) WHERE {g} IS NOT NULL)
        WHERE NOT ST_IsEmpty(geometry))
        TO '{out}' WITH (FORMAT GDAL, DRIVER 'GeoJSONSeq')""")


def upload(s3, path: Path, key: str) -> dict:
    """`path` at `key` (skipped on an md5 match; never over other bytes): its public url and size."""
    if s3 is not None:
        r2_upload(s3, path, key, new_only=True)
    return {'url': f'{R2_PUBLIC}/{key}', 'bytes': path.stat().st_size}


def bake(catalog: dict, deadline: Deadline, s3=None) -> dict:
    junk = gis_artefact_columns()
    con = make_con()
    archives: dict[str, dict] = {}
    rows: list[tuple[str, dict, str, dict | None]] = []
    for name, layers in plan(catalog).items():
        ids_only = ARCHIVES[name]['props'] == 'sidecar'
        inputs, keyed = [], []
        for i, layer in enumerate(layers, 1):
            lid = layer['id']
            deadline.check(f'{lid}: source')
            etag = with_retries(lambda: remote_etag(layer['parquet']['url']))
            if not etag:
                raise OSError(f'{lid}: no etag for {layer["parquet"]["url"]}')
            tiles_etag = with_retries(lambda: remote_etag(layer['pmtiles']['url']))
            fields = fields_of(layer, tiles_etag or 'none', junk)
            seq = WORK / 'seq' / f'{lid}.{etag}.{build_key([(lid, etag, fields)], False)}.geojsonl'
            if not seq.exists():
                src = fetch(layer, etag)
                deadline.check(f'{lid}: export')
                t0 = time.monotonic()
                cached(seq, lambda p: export(con, src, fields, p))
                log(f'  [{name} {i}/{len(layers)}] {lid}: exported in {time.monotonic() - t0:,.0f} s '
                    f'({seq.stat().st_size / 1e6:,.1f} MB)')
            else:
                log(f'  [{name} {i}/{len(layers)}] {lid}: export cached')
            props = None
            if ids_only:
                side = WORK / 'out' / 'props' / f'{seq.stem}.json'
                if not side.exists():
                    with seq.open() as lines:
                        data = sidecar_props(lines, junk)
                    side.parent.mkdir(parents=True, exist_ok=True)
                    with atomic_output(side) as part:
                        part.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
                props = upload(s3, side, versioned_key(f'{PREFIX}/props/{lid}.json', file_md5(side)))
            inputs.append((lid, seq))
            keyed.append((lid, etag, fields))
            rows.append((name, layer, etag, props))
        deadline.check(f'{name}: tippecanoe')
        out = WORK / 'out' / f'{name}.{build_key(keyed, ids_only)}.pmtiles'
        if not out.exists():
            log(f'  {name}: tippecanoe, {len(inputs)} layers at z{ZOOM}')
            t0 = time.monotonic()
            cached(out, lambda p: subprocess.run(tippecanoe_cmd(p, inputs, ids_only), check=True, capture_output=True,
                                                 timeout=max(60, min(TILE_TIMEOUT_S, deadline.left()))))
            log(f'  {name}: {out.stat().st_size / 1e6:,.1f} MB in {time.monotonic() - t0:,.0f} s')
        archives[name] = upload(s3, out, versioned_key(f'{PREFIX}/{name}.pmtiles', file_md5(out)))
        log(f'  {name}: {archives[name]["url"]}')
    return manifest(archives, rows)


def main(argv: list[str]) -> int:
    args = argv[1:]
    minutes = float(args[args.index('--minutes') + 1]) if '--minutes' in args else 600.0
    no_upload = '--no-upload' in args
    catalog = json.loads(CATALOG.read_text())
    try:
        m = bake(catalog, Deadline(minutes), None if no_upload else r2_client())
    except OutOfTime as e:
        log(f'STOPPED: {e}; everything done so far is cached, re-run to continue')
        return 1
    if no_upload:
        log('built (not uploaded); the manifest is left as it is')
        return 0
    wrote = write_if_changed(MANIFEST, json.dumps(m, indent=2, ensure_ascii=True) + '\n')
    log(f'manifest {"written" if wrote else "unchanged"}: {MANIFEST.relative_to(ROOT)} '
        f'({len(m["layers"])} layers in {len(m["archives"])} archives)')
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(line_buffering=True)
    sys.exit(main(sys.argv))
