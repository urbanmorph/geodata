#!/usr/bin/env python3
"""
Bake the whole-layer downloads (GeoJSON, KML, zipped shapefile) a curated
layer's catalog entry lacks, from its published parquet.

Nov 2026: downloads of these formats were rising, and 22 layers shipped only
parquet + pmtiles. The layers under bake_whole_layer.py's 100 MB cap get the
missing files here; the bigger ones are measured first (`estimate`) and only
those whose files stay a reasonable size are baked.

Steps (each takes layer ids; `--max-minutes N` stops cleanly between files):
    bake      parquet (from R2, md5-checked) -> data/formats/<layer>/<stem>.{geojson,kml,shp.zip}
    verify    every file: feature count = parquet rows, first coordinate lon,lat in India,
              the parquet's columns, opens with ogrinfo
    estimate  bake a 1-in-N sample of the rows and scale its sizes up (for the big layers)
    plan      data/formats/upload_plan.json: content-versioned R2 key, md5 and bytes of each
              missing file up to --max-gb (default 1; bigger ones go to held_files.json),
              and data/formats/catalog.patch (the catalog.json diff `patch` would make)
    upload    the plan's files to their keys (never overwrites a published key)   [owner approval]
    patch     write the plan's blocks into catalog.json, by layer id              [owner approval]

Run:
    python3 scripts/oneoff/bake_missing_formats.py bake bharatviz_pincodes nic_health
    python3 scripts/oneoff/bake_missing_formats.py verify bharatviz_pincodes nic_health
    python3 scripts/oneoff/bake_missing_formats.py plan bharatviz_pincodes nic_health
    set -a; source web/.dev.vars; set +a    # R2 keys, only for upload
    python3 scripts/oneoff/bake_missing_formats.py upload
    python3 scripts/oneoff/bake_missing_formats.py patch

Idempotent: each file is written atomically with a .src-md5 sidecar naming
the parquet it came from; a rerun skips a file whose sidecar matches. Uploads
skip a key that already holds the same md5 and refuse one that holds other bytes.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent  # scripts/
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from bake_extracts import write_kml_from_geojson  # noqa: E402
from bake_formats import ShapefileTooBig, shapefile_zip_from_geojson, short_field_names  # noqa: E402
from bake_whole_layer import _detect_geom_col, write_geojson_whole  # noqa: E402
from pipeline import (  # noqa: E402
    BUCKET, R2_PUBLIC, Deadline, OutOfTime, atomic_output, download, file_md5, log, make_con, run, write_json)
from tile_keys import REBAKE_SUFFIX, versioned_key  # noqa: E402

CATALOG = ROOT / 'catalog.json'
WORK = ROOT / 'data' / 'formats'
FORMATS = ('geojson', 'kml', 'shapefile')
EXT = {'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
DOWNLOADS = ('parquet', 'pmtiles', *FORMATS)
INDIA = (68.0, 6.0, 98.0, 38.0)  # lon/lat box around India and its islands
NUM = r'(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)'
FIRST_COORD = {'geojson': re.compile(r'"coordinates":\s*\[[\[\s]*' + NUM + r'\s*,\s*' + NUM),
               'kml': re.compile(r'<coordinates>\s*' + NUM + ',' + NUM)}


# ── what to make ─────────────────────────────────────────────────────────────

def layers_by_id(catalog: dict) -> dict[str, dict]:
    return {x['id']: x for x in catalog['layers']}


def missing_formats(layer: dict) -> list[str]:
    return [f for f in FORMATS if not layer.get(f)]  # some entries carry "kml": null


def stem(url: str) -> str:
    """The file stem of a published parquet without its version suffix:
    .../IND_ADM1.3f41867b.parquet -> IND_ADM1."""
    return REBAKE_SUFFIX.sub('', Path(url).name).removesuffix('.parquet')


def r2_prefix(url: str) -> str:
    """The R2 folder of a published file: https://data.bharatlas.com/a/b/x.parquet -> a/b."""
    if not url.startswith(R2_PUBLIC + '/'):
        raise ValueError(f'not on {R2_PUBLIC}: {url}')
    return url[len(R2_PUBLIC) + 1:].rsplit('/', 1)[0]


def local_paths(layer: dict, work: Path = WORK) -> dict[str, Path]:
    s = stem(layer['parquet']['url'])
    return {fmt: work / layer['id'] / f'{s}.{EXT[fmt]}' for fmt in FORMATS}


def source_path(layer: dict, work: Path = WORK) -> Path:
    return work / '_src' / Path(layer['parquet']['url']).name


FID_COLUMN = 'OGC_FID'  # GDAL writes this column as each GeoJSON feature's "id", not a property


def source_columns(con, src: Path) -> list[str]:
    """The parquet's columns but its geometry, in order: what the shapefile carries."""
    geom = _detect_geom_col(con, src)
    return [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM '{src}'").fetchall() if r[0] != geom]


def property_columns(columns: list[str]) -> list[str]:
    """The columns a GeoJSON (and the KML made from it) carries as properties."""
    return [c for c in columns if c != FID_COLUMN]


# ── caching: a file counts as made from a parquet when its sidecar names it ──

def sidecar(out: Path) -> Path:
    return out.with_name(out.name + '.src-md5')


def is_done(out: Path, src_md5: str) -> bool:
    try:
        return out.stat().st_size > 0 and sidecar(out).read_text().strip() == src_md5
    except FileNotFoundError:
        return False


def mark_done(out: Path, src_md5: str) -> None:
    sidecar(out).write_text(src_md5 + '\n')


# ── bake ─────────────────────────────────────────────────────────────────────

def bake_layer(layer: dict, src: Path, paths: dict[str, Path], formats: list[str], deadline: Deadline,
               con=None) -> dict[str, str]:
    """Make `formats` (plus the GeoJSON the KML and shapefile are built from)
    from the parquet `src`. Returns {format: 'wrote' | 'skip' | 'too big: ...' |
    'failed: ...' | 'needs the geojson'}: one format failing never stops the run."""
    con = con or make_con()
    src_md5 = file_md5(src)
    columns = source_columns(con, src)
    builders = {
        'geojson': lambda part: write_geojson_whole(con, src, part),
        'kml': lambda part: write_kml_from_geojson(paths['geojson'], stem(layer['parquet']['url']), part),
    }
    result: dict[str, str] = {}
    for fmt in ('geojson', *[f for f in formats if f != 'geojson']):
        out = paths[fmt]
        if is_done(out, src_md5):
            result[fmt] = 'skip'
            log(f'skip  {layer["id"]} {fmt} ({out.stat().st_size:,} bytes)')
            continue
        if fmt != 'geojson' and result['geojson'].startswith(('failed', 'too big')):
            result[fmt] = 'needs the geojson'
            continue
        deadline.check(f'{layer["id"]} {fmt}')
        log(f'make  {layer["id"]} {fmt}')
        out.parent.mkdir(parents=True, exist_ok=True)
        try:
            if fmt == 'shapefile':  # write_stable_zip writes the zip atomically
                shapefile_zip_from_geojson(paths['geojson'], out, short_field_names(columns), fid_column=FID_COLUMN)
            else:
                with atomic_output(out) as part:
                    builders[fmt](part)
        except ShapefileTooBig as e:
            result[fmt] = f'too big: {e}'
            log(f'SKIP  {layer["id"]} {fmt}: {e}')
            continue
        except Exception as e:  # noqa: BLE001  (reported; the other layers still bake)
            result[fmt] = f'failed: {str(e).strip()[-500:]}'
            log(f'FAIL  {layer["id"]} {fmt}: {result[fmt]}')
            continue
        mark_done(out, src_md5)
        result[fmt] = 'wrote'
        log(f'wrote {layer["id"]} {fmt} ({out.stat().st_size:,} bytes)')
    return result


# ── verify ───────────────────────────────────────────────────────────────────

def first_coord(path: Path, fmt: str) -> tuple[float, float]:
    """The first coordinate pair as written in the file's text (not as a
    reader reorders it): the lat,lon swap only shows in the bytes."""
    with path.open(encoding='utf-8') as f:
        head = f.read(1 << 20)
    m = FIRST_COORD[fmt].search(head)
    if not m:
        raise ValueError(f'{path.name}: no coordinate in the first MB')
    return float(m.group(1)), float(m.group(2))


def in_india(lon: float, lat: float) -> bool:
    return INDIA[0] <= lon <= INDIA[2] and INDIA[1] <= lat <= INDIA[3]


def ogr_summary(ds: str) -> tuple[int, list[str]]:
    """(feature count, field names) of the first layer GDAL opens in `ds`."""
    out = run(['ogrinfo', '-ro', '-so', '-al', ds], timeout=3600, text=True).stdout
    count = int(re.search(r'Feature Count: (\d+)', out).group(1))
    fields = re.findall(r'^(\S[^:]*): (?:String|Integer|Integer64|Real|Date|DateTime|Time|Binary)',
                        out.split('Geometry Column', 1)[-1].split('Layer SRS', 1)[-1], re.M)
    return count, fields


def shp_first_coord(zip_path: Path) -> tuple[float, float]:
    out = run(['ogrinfo', '-ro', '-al', '-q', '-limit', '1', '-geom=YES', f'/vsizip/{zip_path}'],
              timeout=600, text=True).stdout
    m = re.search(r'\(+\s*' + NUM + r'\s+' + NUM, out)
    return float(m.group(1)), float(m.group(2))


def kml_data_names(path: Path, chunk: int = 1 << 24) -> set[str]:
    """Every <Data name="..."> in a KML, read in chunks (files run to GBs)."""
    from html import unescape
    pat = re.compile(r'<Data name="([^"]*)">')
    names, tail = set(), ''
    with path.open(encoding='utf-8') as f:
        while block := f.read(chunk):
            text = tail + block
            names.update(pat.findall(text))
            tail = text[-1024:]
    return {unescape(n) for n in names}


def non_empty_columns(con, src: Path, columns: list[str]) -> list[str]:
    """The columns with at least one non-null, non-empty value (the KML writer skips the others)."""
    counts = con.execute('SELECT ' + ', '.join(f'count(NULLIF("{c}"::VARCHAR, \'\'))' for c in columns)
                         + f" FROM '{src}'").fetchone()
    return [c for c, n in zip(columns, counts) if n]


def expected_fields(con, src: Path, fmt: str, columns: list[str]) -> list[str]:
    """The fields a `fmt` file made from `src` carries: every column in the
    shapefile (short names), every property column in the GeoJSON, and those
    with a value in the KML (its writer leaves out empty values)."""
    if fmt == 'shapefile':
        return list(short_field_names(columns).values())
    props = property_columns(columns)
    return non_empty_columns(con, src, props) if fmt == 'kml' else props


def verify_file(fmt: str, path: Path, rows: int, columns: list[str],
                ) -> list[str]:
    """What is wrong with one baked file ([] when nothing). `columns`: the
    fields it should carry, in order (expected_fields)."""
    problems = []
    ds = f'/vsizip/{path}' if fmt == 'shapefile' else str(path)
    count, fields = ogr_summary(ds)
    if count != rows:
        problems.append(f'{count:,} features, parquet has {rows:,}')
    if fmt == 'kml':
        # GDAL merges a "name" Data into its own Name field: read the Data names from the file itself.
        got, want = kml_data_names(path), set(columns)
        if got != want:
            problems.append(f'KML Data names differ: missing {sorted(want - got)}, extra {sorted(got - want)}')
    elif [f.lower() for f in fields] != [c.lower() for c in columns]:
        problems.append(f'columns {fields} differ from {columns}')
    lon, lat = shp_first_coord(path) if fmt == 'shapefile' else first_coord(path, fmt)
    if not in_india(lon, lat):
        problems.append(f'first coordinate {lon},{lat} is not lon,lat in India')
    return problems


def verify_layer(layer: dict, src: Path, paths: dict[str, Path], formats: list[str], con=None) -> dict[str, list[str]]:
    con = con or make_con()
    rows = con.execute(f"SELECT count(*) FROM '{src}'").fetchone()[0]
    columns = source_columns(con, src)
    report = {}
    for fmt in formats:
        if not paths[fmt].exists():
            continue
        report[fmt] = verify_file(fmt, paths[fmt], rows, expected_fields(con, src, fmt, columns))
        log(f'{"ok   " if not report[fmt] else "FAIL "} {layer["id"]} {fmt}: {report[fmt] or "verified"}')
    return report


# ── plan + catalog patch ─────────────────────────────────────────────────────

def plan_entry(layer: dict, fmt: str, path: Path) -> dict:
    md5 = file_md5(path)
    key = f'{r2_prefix(layer["parquet"]["url"])}/{versioned_key(path.name, md5)}'
    return {'layer': layer['id'], 'format': fmt, 'file': str(path.relative_to(ROOT)), 'key': key,
            'md5': md5, 'bytes': path.stat().st_size, 'url': f'{R2_PUBLIC}/{key}'}


def with_blocks(layer: dict, blocks: dict[str, dict]) -> dict:
    """`layer` with each download block in `blocks` set: a new one goes after
    the entry's last download block, an existing one keeps its place."""
    last = max((i for i, k in enumerate(layer) if k in DOWNLOADS), default=len(layer) - 1)
    items = list(layer.items())
    out = dict(items[:last + 1])
    out.update({f: b for f, b in blocks.items() if f not in layer})
    out.update(items[last + 1:])
    out.update({f: b for f, b in blocks.items() if f in layer})
    return out


def patch_catalog(catalog: dict, plan: list[dict]) -> dict:
    """The catalog with each plan entry's {url, bytes} block on its layer."""
    by_layer: dict[str, dict] = {}
    for p in plan:
        by_layer.setdefault(p['layer'], {})[p['format']] = {'url': p['url'], 'bytes': p['bytes']}
    catalog['layers'] = [with_blocks(x, by_layer[x['id']]) if x['id'] in by_layer else x for x in catalog['layers']]
    return catalog


# ── estimate (big layers) ────────────────────────────────────────────────────

def estimate_layer(layer: dict, src: Path, every: int, con=None) -> dict:
    """Bake every `every`-th row (by file order) and scale the sizes up by
    rows / sample rows; zipped sizes come from gzip of the sample."""
    import gzip
    import shutil
    con = con or make_con()
    tmp = WORK / '_estimate' / layer['id']
    tmp.mkdir(parents=True, exist_ok=True)
    sample = tmp / 'sample.parquet'
    rows = con.execute(f"SELECT count(*) FROM '{src}'").fetchone()[0]
    con.execute(f"COPY (SELECT * EXCLUDE (rn) FROM (SELECT *, row_number() OVER () AS rn FROM '{src}') "
                f"WHERE rn % {every} = 0) TO '{sample}' (FORMAT PARQUET)")
    n = con.execute(f"SELECT count(*) FROM '{sample}'").fetchone()[0]
    paths = {fmt: tmp / f'sample.{EXT[fmt]}' for fmt in FORMATS}
    for p in [*paths.values(), *map(sidecar, paths.values())]:
        p.unlink(missing_ok=True)
    result = bake_layer(layer, sample, paths, list(FORMATS), Deadline(10_000), con)
    scale = rows / n
    est = {'rows': rows, 'sample_rows': n, 'result': result}
    for fmt in [f for f in ('geojson', 'kml') if result[f] == 'wrote']:
        gz = paths[fmt].with_name(paths[fmt].name + '.gz')
        with paths[fmt].open('rb') as a, gzip.open(gz, 'wb', compresslevel=6) as b:
            shutil.copyfileobj(a, b)
        est[fmt] = {'bytes': int(paths[fmt].stat().st_size * scale), 'zipped': int(gz.stat().st_size * scale)}
    if result['shapefile'] == 'wrote':
        import zipfile
        with zipfile.ZipFile(paths['shapefile']) as z:
            parts = {Path(i.filename).suffix: i.file_size for i in z.infolist()}
        est['shapefile'] = {'zip': int(paths['shapefile'].stat().st_size * scale),
                            'shp': int(parts.get('.shp', 0) * scale), 'dbf': int(parts.get('.dbf', 0) * scale)}
    return est


# ── command line ─────────────────────────────────────────────────────────────

def _targets(args, catalog: dict) -> list[dict]:
    by_id = layers_by_id(catalog)
    return [by_id[i] for i in args.layers]


def _fetch(layer: dict) -> Path:
    src = source_path(layer)
    size = download(layer['parquet']['url'], src)
    if size != layer['parquet']['bytes']:
        raise ValueError(f'{src.name}: {size:,} bytes, the catalog says {layer["parquet"]["bytes"]:,}')
    return src


def cmd_bake(args) -> int:
    deadline = Deadline(args.max_minutes)
    catalog = json.loads(CATALOG.read_text())
    failed = 0
    try:
        for layer in _targets(args, catalog):
            result = bake_layer(layer, _fetch(layer), local_paths(layer), missing_formats(layer), deadline)
            failed += sum(r.startswith('failed') for r in result.values())
    except OutOfTime as e:
        log(f'stopped: {e}; rerun to continue')
        return 3
    return 1 if failed else 0


def cmd_verify(args) -> int:
    catalog = json.loads(CATALOG.read_text())
    bad = 0
    for layer in _targets(args, catalog):
        report = verify_layer(layer, _fetch(layer), local_paths(layer), list(FORMATS))
        bad += sum(bool(v) for v in report.values())
    return 1 if bad else 0


def cmd_estimate(args) -> int:
    catalog = json.loads(CATALOG.read_text())
    out = WORK / 'estimates.json'
    estimates = json.loads(out.read_text()) if out.exists() else {}
    for layer in _targets(args, catalog):
        if layer['id'] in estimates and not args.force:
            log(f'skip  {layer["id"]} (estimated)')
            continue
        estimates[layer['id']] = estimate_layer(layer, _fetch(layer), args.every)
        log(f'{layer["id"]}: {json.dumps(estimates[layer["id"]])}')
        write_json(out, estimates)
    return 0


def cmd_plan(args) -> int:
    """Only files the catalog lacks, only ones that verify, and only those up to
    --max-gb; bigger verified files are listed in held_files.json for the owner."""
    import difflib
    catalog = json.loads(CATALOG.read_text())
    plan, held = [], []
    for layer in _targets(args, catalog):
        paths = local_paths(layer)
        want = [f for f in missing_formats(layer) if paths[f].exists()]
        report = verify_layer(layer, _fetch(layer), paths, want)
        for f in want:
            if not report[f]:
                entry = plan_entry(layer, f, paths[f])
                (plan if entry['bytes'] <= args.max_gb * 1e9 else held).append(entry)
    write_json(WORK / 'upload_plan.json', plan)
    write_json(WORK / 'held_files.json', held)
    before = CATALOG.read_text()
    after = json.dumps(patch_catalog(catalog, plan), indent=2, ensure_ascii=True) + '\n'  # write_json's style
    (WORK / 'catalog.patch').write_text(''.join(difflib.unified_diff(
        before.splitlines(keepends=True), after.splitlines(keepends=True), 'a/catalog.json', 'b/catalog.json')))
    log(f'{len(plan)} files, {sum(p["bytes"] for p in plan):,} bytes -> {WORK / "upload_plan.json"}; '
        f'{len(held)} over {args.max_gb} GB held')
    return 0


def cmd_upload(args) -> int:
    from pipeline import patient_r2_client, r2_upload_retrying, r2_verify
    plan = json.loads((WORK / 'upload_plan.json').read_text())
    s3 = patient_r2_client()
    for p in plan:
        local = ROOT / p['file']
        if file_md5(local) != p['md5']:
            raise ValueError(f'{local.name} changed since the plan: re-run plan')
        r2_upload_retrying(s3, local, p['key'], WORK / '_upload_state', new_only=True)
        r2_verify(s3, local, p['key'])
        log(f'on R2: s3://{BUCKET}/{p["key"]}')
    return 0


def cmd_patch(args) -> int:
    plan = json.loads((WORK / 'upload_plan.json').read_text())
    write_json(CATALOG, patch_catalog(json.loads(CATALOG.read_text()), plan))
    log(f'catalog.json: {len(plan)} download blocks set')
    return 0


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['bake', 'verify', 'estimate', 'plan', 'upload', 'patch'])
    ap.add_argument('layers', nargs='*')
    ap.add_argument('--max-minutes', type=float, default=240)
    ap.add_argument('--every', type=int, default=20, help='estimate: sample 1 row in N')
    ap.add_argument('--force', action='store_true', help='estimate: measure again')
    ap.add_argument('--max-gb', type=float, default=1.0, help='plan: hold files bigger than this')
    args = ap.parse_args(argv)
    return {'bake': cmd_bake, 'verify': cmd_verify, 'estimate': cmd_estimate, 'plan': cmd_plan,
            'upload': cmd_upload, 'patch': cmd_patch}[args.step](args)


if __name__ == '__main__':
    sys.exit(main())
