#!/usr/bin/env python3
"""
Land and water layers from ramSeraph releases (Nov 2026), republished under
policy B (bharatlas.com/about#sources-and-licensing): the government
publishers (NRSC Bhuvan, GSI NGDR, SLUSI) state no open licence, so the
compiler's CC0 applies, crediting DataMeet, ramSeraph and the publisher.

  slusi_priority_micro_watersheds  SLUSI micro-watersheds with a soil-conservation priority
  bhuvan_gw_prospect_structures    structures (faults, dykes, lineaments) on the RGNDWM groundwater prospect maps
  bhuvan_lineaments_50k            NRSC lineaments 1:50k (2005-06)
  gsi_lithology_50k                GSI lithology 1:50k
  bhuvan_geomorphology_50k         NRSC geomorphology 1:50k (2005-06)

Not ingested (see SKIPPED): parquet over 2 GB does not fit the one-file-per-
layer architecture, and the catalog has no pattern for splitting one national
layer into per-state layers.

Same pipeline as scripts/ingest_ramseraph.py (its helpers are imported, not
copied), with what multi-GB inputs need: resumable downloads, every step
cached and written atomically (a killed run resumes; a second run does no
work), a time limit that stops cleanly between steps, and checks before
anything goes live (lon,lat first coordinates; decoded tile counts).

Run (R2 creds in the env: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY):
    python3 -u scripts/bake_land_water.py                     # all, smallest first
    python3 -u scripts/bake_land_water.py gsi_lithology_50k   # one layer
    python3 -u scripts/bake_land_water.py --no-upload         # build + check locally only
    python3 -u scripts/bake_land_water.py --minutes 300       # stop cleanly after 5 h
"""
from __future__ import annotations

import contextlib
import dataclasses
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable

import boto3
import duckdb
from boto3.s3.transfer import TransferConfig
from botocore.config import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest_ramseraph as ir  # noqa: E402
from bake_formats import atomic_output, pmtiles_args  # noqa: E402

WORK = ir.WORK / 'land_water'
UA = 'Mozilla/5.0 (compatible; bharatlas-data-fetch)'
CHUNK = 1 << 20
PROGRESS_EVERY = 200 * CHUNK


def parquet_and_tiles_only(d: ir.Dataset) -> ir.Dataset:
    """No whole-layer GeoJSON/KML/shapefile: for 4 million detailed 1:50k
    polygons the GeoJSON alone came to 25.6 GB. The parquet (and the viewer's
    Filter & export, and the API) serve parts of the layer."""
    return dataclasses.replace(d, bake_all_formats=False, notes=d.notes + (
        ' Parquet and map tiles only: a whole-layer GeoJSON would be tens of GB;'
        ' use Filter & export on the map, or the API, to download an area.'))


DATASETS: list[ir.Dataset] = [
    ir.republished(
        'slusi_priority_micro_watersheds', 'Priority micro-watersheds (SLUSI)', 'water', 'SLUSI',
        'indian_water_features/hydro-boundaries', 'SLUSI_Priority_MicroWatersheds',
        ('Micro-watersheds ranked by the Soil and Land Use Survey of India for soil conservation '
         '(priority from very high to very low), with hydrologic unit code. '
         'Use with the SLUSI micro-watershed boundaries.'),
        'micro-watersheds', 'https://slusi.dacnet.nic.in/', 'SLUSI (Soil & Land Use Survey of India)',
        'HU_CODE', 'water/slusi-priority-micro-watersheds'),
    ir.republished(
        'bhuvan_gw_prospect_structures', 'Groundwater prospect structures (Bhuvan)', 'water', 'Bhuvan',
        'indian_land_features/groundwater-prospects', 'Bhuvan_Groundwater_Prospects_STRU',
        ('Faults, fractures, dykes and lineaments mapped on the groundwater prospect maps of the Rajiv '
         'Gandhi National Drinking Water Mission (NRSC, 1:50k). Columns vary by state in the source. '
         'The prospect zones themselves are not included (too large for one file).'),
        'structures', 'https://bhuvan-app1.nrsc.gov.in/gwis/', 'Bhuvan (NRSC, ISRO)',
        'STRU', 'water/bhuvan-gw-prospect-structures'),
    ir.republished(
        'bhuvan_lineaments_50k', 'Lineaments 1:50k (Bhuvan 2005-06)', 'environment', 'Bhuvan',
        'indian_land_features/geomorphology', 'Bhuvan_Lineament_50k_0506',
        ('Geological and geomorphic lineaments mapped at 1:50,000 by NRSC in the 2005-06 national '
         'geomorphology mapping. Mizoram, Lakshadweep and some UTs are missing in the source.'),
        'lineaments', 'https://bhuvan.nrsc.gov.in/', 'Bhuvan (NRSC, ISRO)',
        'Des', 'environment/bhuvan-lineaments-50k'),
    parquet_and_tiles_only(ir.republished(
        'gsi_lithology_50k', 'Lithology 1:50k (GSI)', 'environment', 'NGDR',
        'indian_land_features/geology', 'NGDR_Lithology_50k',
        ('Rock units mapped at 1:50,000 by the Geological Survey of India: lithology, age, '
         'supergroup, group, formation and stratigraphy, by toposheet.'),
        'rock units', 'https://bhukosh.gsi.gov.in/', 'Geological Survey of India (NGDR / Bhukosh)',
        'lithologic', 'environment/gsi-lithology-50k')),
    parquet_and_tiles_only(ir.republished(
        'bhuvan_geomorphology_50k', 'Geomorphology 1:50k (Bhuvan 2005-06)', 'environment', 'Bhuvan',
        'indian_land_features/geomorphology', 'Bhuvan_Geomorphology_50k_0506',
        ('Landforms mapped at 1:50,000 by NRSC in the 2005-06 national geomorphology mapping, in '
         'three levels (origin, process, landform). Mizoram, Lakshadweep and some UTs are missing '
         'in the source.'),
        'landform polygons', 'https://bhuvan.nrsc.gov.in/', 'Bhuvan (NRSC, ISRO)',
        'Des', 'environment/bhuvan-geomorphology-50k')),
]

# Tile attributes = the popup fields (the parquet and downloads keep every
# column); True = polygons (coalesce at low zoom, checked for holes).
TILES: dict[str, tuple[list[str], bool]] = {
    'slusi_priority_micro_watersheds': (['Priority', 'HU_CODE', 'HYDRO_UNIT', 'REP_CODE'], True),
    'bhuvan_gw_prospect_structures': (['STRU', 'SUB_STRU', 'SUB_STRUC', 'STRUCTURE_', 'NAME', 'sname'], False),
    'bhuvan_lineaments_50k': (['Des', 'Level1', 'Level2', 'Magnitude', 'st_code'], False),
    'gsi_lithology_50k': (['lithologic', 'age', 'supergroup', 'group_name', 'formation', 'stratigraphy_new',
                           'toposheet_'], True),
    'bhuvan_geomorphology_50k': (['Des', 'Level1', 'Level2', 'Level3', 'st_code'], True),
}

# Checked 2026-11-17 against the ramSeraph release assets (parquet total over all shards).
SKIPPED: dict[str, dict] = {
    'bhuvan_gw_prospects': {
        'file': 'indian_land_features/groundwater-prospects/Bhuvan_Groundwater_Prospects_LGEOM.{00,01}.parquet',
        'features': 820_552, 'parquet_bytes': 2_700_148_317, 'pmtiles_bytes': 856_905_481},
    'bhuvan_land_degradation_0506': {
        'file': 'indian_land_features/degradation/Bhuvan_Land_Degradation_50k_0506.{000,001,010,011}.parquet',
        'features': 1_110_598, 'parquet_bytes': 3_937_014_492, 'pmtiles_bytes': 672_575_832},
    'bhuvan_land_degradation_1516': {
        'file': 'indian_land_features/degradation/Bhuvan_Land_Degradation_50k_1516.{000,001,010,011}.parquet',
        'features': 1_106_126, 'parquet_bytes': 3_925_747_962, 'pmtiles_bytes': 673_950_856},
}


# ── download ───────────────────────────────────────────────────────────

def part_path(dest: Path) -> Path:
    return dest.with_name(dest.name + '.part')


def _total_size(resp, start: int) -> int | None:
    cr = resp.headers.get('Content-Range')
    if cr and '/' in cr and not cr.endswith('/*'):
        return int(cr.rsplit('/', 1)[1])
    cl = resp.headers.get('Content-Length')
    return start + int(cl) if cl is not None else None


def fetch(url: str, dest: Path, retries: int = 6, backoff: float = 15.0) -> Path:
    """Download `url` to `dest`, resuming a `.part` file left by a killed run
    or a dropped connection (HTTP Range). The file gets its real name only
    once its size matches the server's, so an existing `dest` is complete."""
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = part_path(dest)
    for attempt in range(retries + 1):
        start = part.stat().st_size if part.exists() else 0
        req = urllib.request.Request(url, headers={'User-Agent': UA, **({'Range': f'bytes={start}-'} if start else {})})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                if start and resp.status != 206:
                    start = 0  # server ignored the Range: start over
                total = _total_size(resp, start)
                print(f'  fetch {dest.name}: {start:,} of {total or 0:,} bytes on disk', flush=True)
                with part.open('ab' if start else 'wb') as f:
                    n, mark = start, start
                    while chunk := resp.read(CHUNK):
                        f.write(chunk)
                        n += len(chunk)
                        if n - mark >= PROGRESS_EVERY:
                            print(f'    {dest.name}: {n / 1e6:,.0f} / {(total or 0) / 1e6:,.0f} MB', flush=True)
                            mark = n
            size = part.stat().st_size
            if total is not None and size != total:
                raise OSError(f'short read: {size:,} of {total:,} bytes')
            os.replace(part, dest)
            return dest
        except urllib.error.HTTPError as e:
            if e.code == 416 and part.exists():  # the .part already holds every byte
                os.replace(part, dest)
                return dest
            err: Exception = e
        except (OSError, urllib.error.URLError) as e:
            err = e
        if attempt == retries:
            raise err
        wait = backoff * 2 ** attempt
        print(f'  fetch {dest.name}: {err}; retry {attempt + 1}/{retries} in {wait:.0f} s', flush=True)
        time.sleep(wait)
    return dest


# ── cached steps + time limit ──────────────────────────────────────────

def cached(out: Path, build: Callable[[Path], object]) -> Path:
    """Run `build(part)` only when `out` does not exist yet; `out` appears
    only if the build finished, so a killed run redoes just this step."""
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        with atomic_output(out) as part:
            build(part)
    return out


class OutOfTime(Exception):
    pass


class Deadline:
    """Stop between steps once `minutes` have passed (everything finished so
    far is cached on disk, so the next run continues from there)."""

    def __init__(self, minutes: float, clock: Callable[[], float] = time.monotonic):
        self.clock = clock
        self.end = clock() + minutes * 60

    def check(self, step: str) -> None:
        if self.clock() > self.end:
            raise OutOfTime(f'time limit reached before {step}')


# ── verification ───────────────────────────────────────────────────────

KML_VERTEX = re.compile(r'<coordinates>\s*([^,\s<]+),([^,\s<]+)')


def _vertex(geom: dict | None) -> tuple[float, float] | None:
    coords = (geom or {}).get('coordinates')
    while coords and isinstance(coords[0], list):
        coords = coords[0]
    if not coords:
        return None
    x, y = float(coords[0]), float(coords[1])
    return (x, y) if math.isfinite(x) and math.isfinite(y) else None


def first_coord(path: Path) -> tuple[float, float]:
    """First vertex of the first feature with a real geometry (sources carry a
    few empty ones) in a GeoJSON, KML or zipped shapefile. Streams the file:
    GDAL's KML reader loads all of it and runs out of memory on GBs."""
    if path.name.endswith('.kml'):
        with path.open(encoding='utf-8') as f:
            tail = ''
            while chunk := f.read(CHUNK):
                buf = tail + chunk
                for m in KML_VERTEX.finditer(buf):
                    with contextlib.suppress(ValueError):
                        if v := _vertex({'coordinates': [m[1], m[2]]}):
                            return v
                tail = buf[-256:]
        raise ValueError(f'{path.name}: no coordinates')
    src = str(path)
    if path.name.endswith('.shp.zip'):
        shp = next(n for n in sorted(zipfile.ZipFile(path).namelist()) if n.endswith('.shp'))
        src = f'/vsizip/{path}/{shp}'
    proc = subprocess.Popen(['ogr2ogr', '-f', 'GeoJSONSeq', '/vsistdout/', src],
                            stdout=subprocess.PIPE, text=True, env=ir.OGR_ENV)
    try:
        for line in proc.stdout:
            if v := _vertex(json.loads(line.strip('\x1e'))['geometry']):
                return v
    finally:
        proc.kill()
        proc.wait()
    raise ValueError(f'{path.name}: no coordinates')


def assert_lon_lat(path: Path) -> None:
    x, y = first_coord(path)
    assert 68 <= x <= 98 and 6 <= y <= 38, f'{path.name}: first coordinate {x},{y} is not lon,lat in India'


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """(west, south, east, north) in degrees of a web-mercator tile."""
    n = 2 ** z

    def lat(yy: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))
    return x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)


def tile_for(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def decode_tile(pmtiles: Path, z: int, x: int, y: int, out: Path) -> int:
    """Write one decoded tile's features (lon,lat) to a GeoJSON file; return their count."""
    text = subprocess.run(['tippecanoe-decode', '-c', str(pmtiles), str(z), str(x), str(y)],
                          check=True, capture_output=True, text=True).stdout
    feats = [line.rstrip(',') for line in text.splitlines() if line.startswith('{ "type": "Feature"')]
    out.write_text('{"type": "FeatureCollection", "features": [' + ','.join(feats) + ']}')
    return len(feats)


def pmtiles_maxzoom(pmtiles: Path) -> int:
    with pmtiles.open('rb') as f:
        header = f.read(127)
    return header[101]


# Check points: Delhi ridge, Deccan (Pune), Chota Nagpur (Ranchi), Kerala coast.
PROBES = [(77.2, 28.6), (73.85, 18.5), (85.3, 23.35), (76.3, 9.95)]


def tile_report(pmtiles: Path, parquet: Path, con: duckdb.DuckDBPyConnection, polygons: bool) -> list[dict]:
    """Per probe tile at z5 and the max zoom: decoded features vs parquet
    features meeting the tile, and the area (polygons) or length (lines)
    each covers inside the tile. tippecanoe can silently drop polygons and
    leave holes; decoded tiles, not HTTP statuses, show it."""
    measure = 'ST_Area' if polygons else 'ST_Length'
    rows = []
    zmax = pmtiles_maxzoom(pmtiles)
    tmp = pmtiles.with_name(f'{pmtiles.stem}.decoded.geojson')
    for lon, lat in PROBES:
        for z in sorted({5, zmax}):
            x, y = tile_for(lon, lat, z)
            w, s, e, n = tile_bounds(z, x, y)
            env = f'ST_MakeEnvelope({w}, {s}, {e}, {n})'
            expect, want = con.execute(
                f"SELECT count(*), coalesce(sum({measure}(ST_Intersection(ST_MakeValid(geometry), {env}))), 0) "
                f"FROM read_parquet('{parquet}') WHERE xmax >= ? AND xmin <= ? AND ymax >= ? AND ymin <= ?",
                [w, e, s, n]).fetchone()
            decoded = decode_tile(pmtiles, z, x, y, tmp)
            got = con.execute(
                f"SELECT coalesce(sum({measure}(ST_Intersection(ST_MakeValid(geom), {env}))), 0) FROM ST_Read('{tmp}')"
            ).fetchone()[0] if decoded else 0
            rows.append({'z': z, 'x': x, 'y': y, 'decoded': decoded, 'parquet': expect,
                         'cover': round(got / want, 3) if want else None})
    tmp.unlink(missing_ok=True)
    return rows


def tiles_ok(rows: list[dict], zmax: int, polygons: bool) -> bool:
    """Max zoom keeps every feature; polygons also cover the land at z5 (no holes)."""
    for r in rows:
        if r['parquet'] == 0:
            continue
        if r['z'] == zmax and r['decoded'] < r['parquet']:
            return False
        if polygons and r['cover'] is not None and r['cover'] < 0.98:
            return False
    return True


def tippecanoe_args(src: Path, out: Path, layer: str, fields: list[str], polygons: bool) -> list[str]:
    """The house tile settings (bake_formats.pmtiles_args: popup fields only),
    but polygons coalesce instead of dropping at low zoom: dropping left half
    of a z5 tile of micro-watersheds empty, coalescing covers all of it."""
    args = pmtiles_args(src, out, layer, fields, parallel=True)
    if polygons:
        args[args.index('--drop-densest-as-needed')] = '--coalesce-densest-as-needed'
    return args


def bake_tiles(flat: Path, out: Path, layer: str, fields: list[str], polygons: bool,
               con: duckdb.DuckDBPyConnection) -> None:
    """Line-delimited GeoJSON of the popup fields (rows with a real geometry
    only: two source rows are LINESTRING(nan nan, ...)), then tippecanoe."""
    if out.exists():
        return
    seq = out.with_name(f'{out.stem}.tiles.geojsonl')
    cols = ', '.join(f'"{f}"' for f in fields)
    cached(seq, lambda part: con.execute(
        f"COPY (SELECT {cols}, geometry FROM read_parquet('{flat}') WHERE xmin <= 180) "
        f"TO '{part}' WITH (FORMAT GDAL, DRIVER 'GeoJSONSeq')"))
    cached(out, lambda part: subprocess.run(tippecanoe_args(seq, part, layer, fields, polygons),
                                            check=True, capture_output=True))
    seq.unlink(missing_ok=True)


# ── pipeline ───────────────────────────────────────────────────────────

def make_con(work: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute('SET geometry_always_xy = true')  # else EPSG:4326 writes lat,lon
    con.execute(f"SET temp_directory = '{work / 'duckdb_tmp'}'")
    con.execute('SET preserve_insertion_order = false')
    con.execute("SET memory_limit = '24GB'")
    return con


def build(d: ir.Dataset, deadline: Deadline) -> dict:
    """Every local file for one layer, each step cached. Returns
    {'files': {local: r2 name}, 'features': n, 'bakes': {fmt: path}}."""
    work = WORK / d.id
    pq_name, pm_name = Path(d.parquet_url).name, Path(d.pmtiles_url).name
    raw_pq = fetch(d.parquet_url, WORK / 'raw' / pq_name)
    deadline.check('parquet rebake')

    con = make_con(work)
    flat = cached(work / pq_name, lambda part: ir.rebake_flatten_bbox(raw_pq, part, con))
    features = con.execute(f"SELECT count(*) FROM read_parquet('{flat}')").fetchone()[0]
    print(f'  {d.id}: {features:,} features in {flat.name} ({flat.stat().st_size:,} bytes)', flush=True)

    deadline.check('whole-layer bakes')
    record = work / 'bakes.json'
    if not record.exists():
        bakes = ir.bake_whole_layer(d, flat, work / 'bake', Path(pq_name).stem)
        record.write_text(json.dumps({fmt: str(p) for fmt, p in bakes.items()}))
    bakes = {fmt: Path(p) for fmt, p in json.loads(record.read_text()).items()}
    for p in bakes.values():  # every run: nothing goes live with lat,lon swapped
        assert_lon_lat(p)
    print(f'  {d.id}: bakes {sorted(bakes)}', flush=True)

    deadline.check('tiles')
    fields, polygons = TILES[d.id]
    pm = work / pm_name
    bake_tiles(flat, pm, d.id, fields, polygons, con)
    report = work / 'tiles.json'
    if not report.exists():
        report.write_text(json.dumps(tile_report(pm, flat, con, polygons), indent=1))
    rows = json.loads(report.read_text())
    for r in rows:
        print(f"    z{r['z']}/{r['x']}/{r['y']}: decoded {r['decoded']:,}  parquet {r['parquet']:,}"
              f"  cover {r['cover']}", flush=True)
    if not tiles_ok(rows, pmtiles_maxzoom(pm), polygons):
        raise RuntimeError(f'{d.id}: tiles lose features or leave holes; see {report}')

    files = {flat: pq_name, pm: pm_name, **{p: p.name for p in bakes.values()}}
    return {'files': files, 'features': features, 'bakes': bakes}


CATALOG = ir.ROOT / 'catalog.json'


def patch_root_catalog(d: ir.Dataset, pq_bytes: int, pm_bytes: int, features: int,
                       bakes: dict[str, Path], catalog: Path = CATALOG) -> None:
    """Patch the repo-root catalog.json only: web/public/catalog.json is a
    gitignored copy the prerender overwrites on every build."""
    c = json.loads(catalog.read_text())
    info = {fmt: {'name': p.name, 'bytes': p.stat().st_size} for fmt, p in bakes.items()}
    ir.merge_layer_into_catalog(c, d, pq_bytes, pm_bytes, features, info)
    # The tiles are baked here (popup fields), not the compiler's file.
    next(lyr for lyr in c['layers'] if lyr['id'] == d.id)['pmtiles'].pop('upstream_url', None)
    catalog.write_text(json.dumps(c, indent=2) + '\n')


def upload(s3, local: Path, key: str, retries: int = 5, backoff: float = 30.0) -> None:
    """ir.r2_upload (md5-skips unchanged files) with retries: a dropped TLS
    connection mid-multipart killed a 316 MB upload once."""
    for attempt in range(retries + 1):
        try:
            return ir.r2_upload(s3, local, key)
        except (BotoCoreError, ClientError, OSError) as e:
            if attempt == retries:
                raise
            wait = backoff * 2 ** attempt
            print(f'  upload {key}: {e.__class__.__name__}; retry {attempt + 1}/{retries} in {wait:.0f} s', flush=True)
            time.sleep(wait)


class GentleS3:
    """The R2 client with fewer parallel parts and more per-request retries:
    ten parallel 64 MB parts kept dropping TLS connections from this host.
    ir.r2_upload passes its own TransferConfig; this one replaces it."""
    TRANSFER = TransferConfig(multipart_threshold=64 * 1024 * 1024, multipart_chunksize=32 * 1024 * 1024,
                              max_concurrency=2)

    def __init__(self, s3):
        self._s3 = s3

    def __getattr__(self, name):
        return getattr(self._s3, name)

    def upload_file(self, *args, Config=None, **kwargs):  # noqa: N803 (boto3's name)
        return self._s3.upload_file(*args, Config=self.TRANSFER, **kwargs)


def r2_client() -> GentleS3:
    return GentleS3(boto3.client(
        's3', endpoint_url=f'https://{os.environ["CLOUDFLARE_ACCOUNT_ID"]}.r2.cloudflarestorage.com',
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        config=BotoConfig(signature_version='s3v4', retries={'max_attempts': 10, 'mode': 'adaptive'})))


def publish(d: ir.Dataset, built: dict) -> None:
    s3 = r2_client()
    for local, name in built['files'].items():
        upload(s3, local, f'{d.r2_prefix}/{name}')
    files = {name: local for local, name in built['files'].items()}
    pq_bytes = files[Path(d.parquet_url).name].stat().st_size
    pm_bytes = files[Path(d.pmtiles_url).name].stat().st_size
    ir.append_manifest(d, pq_bytes, pm_bytes, built['features'])
    patch_root_catalog(d, pq_bytes, pm_bytes, built['features'], built['bakes'])
    print(f'  {d.id}: on R2 and in the catalog', flush=True)


def main(argv: list[str]) -> int:
    args = argv[1:]
    do_upload = '--no-upload' not in args
    minutes = 600.0
    if '--minutes' in args:
        i = args.index('--minutes')
        minutes = float(args.pop(i + 1))
    ids = [a for a in args if not a.startswith('--')]
    if do_upload:
        missing = [k for k in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY') if k not in os.environ]
        if missing:
            print(f'ERROR: not set in env: {missing}')
            return 2
    targets = [d for d in DATASETS if not ids or d.id in ids]
    deadline = Deadline(minutes)
    for d in targets:
        print(f'\n-> {d.id}', flush=True)
        try:
            built = build(d, deadline)
            if do_upload:
                publish(d, built)
        except OutOfTime as e:
            print(f'STOPPED: {e}; finished steps are cached, re-run to continue', flush=True)
            return 3
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
