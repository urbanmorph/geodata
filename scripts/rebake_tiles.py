#!/usr/bin/env python3
"""
Rebake a catalog layer's map tiles (PMTiles) with popup fields only, or
build them for a layer that has none, from the layer's own parquet (or
GeoJSON when it has no parquet). The source data is never changed: the
parquet and downloads stay as they are; only the tiles are new.

Per layer:
  1. fetch the source (resumable; kept in WORK/<id>/)
  2. a local parquet with flat xmin/ymin/xmax/ymax for the checks (the
     catalog parquet as is, or the GeoJSON read into one)
  3. line-delimited GeoJSON of the popup fields, then tippecanoe with the
     house settings plus a smaller tile budget: polygons coalesce (merged
     shapes still cover the ground), lines and points thin out
  4. checks, by decoding tiles (never by HTTP status or size): at a low,
     a mid and the max zoom, decoded features and the area (polygons) or
     length (lines) they cover against the parquet; and the audit rule
     (audit_tiles.flag) must pass on the new file
  5. upload to a new, versioned key (<stem>.<md5[:8]>.pmtiles; the old key
     is cached immutable for 7 days, and stays until the deploy that stops
     using it), then patch catalog.json (and the ingest manifest) in place

Popup fields: every column a click popup or /api/v1/locate would show (the
locate response already leaves out GIS artefact columns), minus geometry,
the flat bbox and nested columns. POPUP_FIELDS narrows a layer whose rows
carry dozens of columns; every column stays in the parquet and downloads.
The tiles also carry each low-cardinality column the Filter panel filters on
(build_filter_stats.tile_filter_columns), so the map can draw every filter.

Run (R2 creds in the env: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY):
    python3 -u scripts/rebake_tiles.py fsi_beats gb_adm1      # build, check, upload, patch
    python3 -u scripts/rebake_tiles.py --flagged              # every layer audit_tiles flags
    python3 -u scripts/rebake_tiles.py fsi_beats --no-upload  # build + check only
    python3 -u scripts/rebake_tiles.py --minutes 120 ...      # stop cleanly between steps

Idempotent: each step's output is kept (written atomically, so a killed run
redoes only the step it was in), the key is the file's md5, uploads skip on
an md5 match, and the catalog patch is by layer id.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import audit_tiles as at  # noqa: E402
from bake_formats import (  # noqa: E402
    BBOX,
    gis_artefact_columns,
    pmtiles_args,
    plain_popup_fields,
    tile_fields,
)
from build_filter_stats import stats_for_parquet, tile_filter_columns  # noqa: E402
from bake_land_water import (  # noqa: E402
    Deadline,
    OutOfTime,
    cached,
    decode_tile,
    fetch,
    r2_client,
    tile_bounds,
    tile_for,
    upload,
)
from pipeline import (  # noqa: E402
    R2_PUBLIC,
    _remote_has,
    file_md5,
    make_con,
    write_json,
)

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
MANIFEST = HERE / 'external-ingested.json'
WORK = Path(os.environ.get('TILES_WORK', '/tmp/ramseraph/tiles'))
LOCK = Path('/tmp/bharatlas-upload.lock')
LOCK_OWNER = f'rebake_tiles pid {os.getpid()}'

# tippecanoe's default budget is 500,000 bytes a tile, and dense layers fill
# their low-zoom tiles right up to it. A smaller budget keeps country-zoom
# tiles quick; coalescing (polygons, lines) keeps the ground covered.
MAX_TILE_BYTES = 300_000
# Coordinates per tile edge below the max zoom: 2^10 = 1,024 is still finer
# than the 512 px a tile is drawn at; the max zoom keeps tippecanoe's 4,096.
LOW_DETAIL = 10
# Detail settings tried in turn, with each try's file suffix: the lower detail
# first; when its tiles fail the checks (fine parcels in a small area turn to
# dust at country zoom), tippecanoe's default detail. Never worse coverage.
DETAIL_TRIES = ((LOW_DETAIL, ''), (None, '.full-detail'))
# Never bake fewer zooms than the tiles being replaced had (locate tests a
# point at the max zoom), nor fewer than this for a layer that had none.
MIN_MAX_ZOOM = 10
STEP_TIMEOUT_S = 4 * 3600
COVER_AT_MAX = (0.98, 1.02)     # polygon area in a decoded tile / the parquet's
COVER_BELOW_MAX = (0.9, 1.15)
DUCKDB_MEMORY = os.environ.get('TILES_DUCKDB_MEMORY', '12GB')
NOTE = ('Map tiles rebaked by bharatlas with the popup fields only; every column is in the'
        ' parquet and the downloads.')
NOTE_MARK = 'with the popup fields only'

# Layers whose rows carry more columns than a popup can show. Same choice as
# fsi_recorded_forest_area (scripts/ingest_big_layers.py TILE_FIELDS): names.
POPUP_FIELDS: dict[str, list[str]] = {
    'fsi_beats': ['Beat_Name', 'Name_of_RF', 'Name', 'COMP_NO', 'Range', 'Division', 'Circle_Nam',
                  'ST_Name', 'DT_Name'],
    'fsi_ranges': ['Range', 'Division', 'Circle_Nam', 'ST_Name', 'DT_Name'],
    'fsi_divisions': ['Division', 'Circle_Nam', 'ST_Name'],
    'fsi_circles': ['Circle_Nam', 'ST_Name'],
    'slusi_soil_health': ['VILLAGE', 'DISTRICT', 'STATE', 'cycle', 'N', 'P', 'K', 'pH', 'EC', 'OC'],
}


def log(*msg: object) -> None:
    print(*msg, flush=True)


# ── fields ───────────────────────────────────────────────────────────────────

def popup_fields(layer_id: str, schema: list[tuple[str, str]], junk: set[str],
                 live_fields: list[str] | None = None) -> list[str]:
    """The columns the tiles carry, in parquet order: POPUP_FIELDS when the
    layer is listed, else every plain column but GIS artefacts, kept to the
    fields the live tiles already carry (a bake that chose popup fields, or
    what /api/v1/locate answers with, is never widened)."""
    names = {c for c, _ in schema}
    if layer_id in POPUP_FIELDS:
        missing = [f for f in POPUP_FIELDS[layer_id] if f not in names]
        if missing:
            raise ValueError(f'{layer_id}: popup fields {missing} are not in the source')
        return list(POPUP_FIELDS[layer_id])
    fields = plain_popup_fields(schema, junk)
    if live_fields is not None:
        fields = [c for c in fields if c in set(live_fields)]
        if live_fields and not fields:
            raise ValueError(f'{layer_id}: none of the live tile fields {live_fields} are in the source')
    return fields


def filter_stats(baked: dict | None, src: Path, fmt: str, con, cache: Path) -> dict | None:
    """The column stats the viewer's Filter panel ranks: the catalog's baked
    filter_stats, else what its live probe of the parquet finds (computed
    once, cached). None without a parquet: the viewer has no Filter then."""
    if baked or fmt != 'parquet':
        return baked
    return json.loads(cached(cache, lambda p: p.write_text(
        json.dumps(stats_for_parquet(src, con, probe=True), default=str))).read_text())


# ── tiles ────────────────────────────────────────────────────────────────────

def tippecanoe_args(src: Path, out: Path, layer: str, fields: list[str], kind: str,
                    min_max_zoom: int, low_detail: int | None = LOW_DETAIL) -> list[str]:
    """bake_formats.pmtiles_args (popup fields, -zg, extend zooms while
    still dropping) with a smaller tile budget and lower detail below the
    max zoom; polygons coalesce instead of dropping, so low zooms keep
    covering the ground. Lines and points thin out at low zoom: merging
    lines keeps every vertex, so it cannot shrink a tile of dense roads."""
    args = pmtiles_args(src, out, layer, fields, parallel=True)
    if kind == 'polygon':
        args[args.index('--drop-densest-as-needed')] = '--coalesce-densest-as-needed'
    if kind == 'point':
        # No fixed thinning rate: each low-zoom tile keeps as many points as
        # the budget holds (the densest go first), not a sparse sample.
        args.insert(args.index('--force'), '-r1')
    if not fields:
        args.insert(args.index('--force'), '-X')  # no attributes at all (-y with none keeps every one)
    extra = [f'--maximum-tile-bytes={MAX_TILE_BYTES}', f'--smallest-maximum-zoom-guess={min_max_zoom}']
    if low_detail is not None:
        extra.insert(1, f'--low-detail={low_detail}')
    if kind == 'polygon':
        extra.append('--detect-shared-borders')  # neighbours simplify alike: no slivers or gaps
    i = args.index('--force')
    return args[:i] + extra + args[i:]


def geometry_kind(con, parquet: Path) -> str:
    """'point', 'line' or 'polygon': the layer's most common geometry type."""
    t = con.execute(f"SELECT ST_GeometryType(geometry)::VARCHAR t, count(*) n FROM read_parquet('{parquet}') "
                    f"WHERE geometry IS NOT NULL GROUP BY t ORDER BY n DESC LIMIT 1").fetchone()[0].upper()
    return 'point' if 'POINT' in t else 'line' if 'LINE' in t else 'polygon'


def schema(con, parquet: Path) -> list[tuple[str, str]]:
    return [(r[0], r[1]) for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{parquet}')").fetchall()]


# ── checks ───────────────────────────────────────────────────────────────────

def probe_points(con, parquet: Path, n: int = 4) -> list[tuple[float, float]]:
    """Points inside features spread through the file (bakes sort rows along a
    Hilbert curve, so row order spreads them over the map)."""
    rows = con.execute(f"SELECT count(*) FROM read_parquet('{parquet}')").fetchone()[0]
    picks = sorted({int(rows * q) for q in (0.15, 0.4, 0.65, 0.9)[:n]} | {0})[-n:]
    pts = []
    for i in picks:
        x, y = con.execute(f"SELECT ST_X(p), ST_Y(p) FROM (SELECT ST_PointOnSurface(geometry) p "
                           f"FROM read_parquet('{parquet}') WHERE geometry IS NOT NULL LIMIT 1 OFFSET {i})"
                           ).fetchone()
        pts.append((x, y))
    return pts


def amount_sql(kind: str, col: str, env: str) -> str:
    """SQL for the area (polygons) or length (lines) of `col` inside `env`,
    summed; '0' for points. Only the parts of the measured dimension are
    intersected (GEOS refuses a mixed-dimension overlay input). A shape whose
    ST_MakeValid GEOS rejects (a ring of identical points beside a real one)
    falls back to ST_Buffer(0), which drops the zero-area ring."""
    dim = {'polygon': 3, 'line': 2}.get(kind)
    if dim is None:
        return '0'
    measure = 'ST_Area' if kind == 'polygon' else 'ST_Length'
    fallback = f'ST_Buffer({col}, 0)' if kind == 'polygon' else col
    valid = f'ST_CollectionExtract(coalesce(TRY(ST_MakeValid({col})), {fallback}), {dim})'
    return f'coalesce(sum({measure}(ST_Intersection({valid}, {env}))), 0)'


def check_zooms(max_zoom: int) -> list[int]:
    return sorted({min(3, max_zoom), min(5, max_zoom), min(8, max_zoom), max_zoom})


def tile_report(pm: Path, parquet: Path, con, kind: str) -> list[dict]:
    """Per probe tile at a low, a mid and the max zoom: decoded features vs
    parquet features meeting the tile, and the area (polygons) or length
    (lines) each covers inside it. Points compare counts only."""
    measured = kind in ('polygon', 'line')
    max_zoom = at.parse_header(pm.read_bytes()[:127]).max_zoom
    tmp = pm.with_name(f'{pm.stem}.decoded.geojson')
    rows, seen = [], set()
    for lon, lat in probe_points(con, parquet):
        for z in check_zooms(max_zoom):
            x, y = tile_for(lon, lat, z)
            if (z, x, y) in seen:  # probes close together share their low-zoom tiles
                continue
            seen.add((z, x, y))
            w, s, e, n = tile_bounds(z, x, y)
            env = f'ST_MakeEnvelope({w}, {s}, {e}, {n})'
            expect, want = con.execute(
                f"SELECT count(*), {amount_sql(kind, 'geometry', env)} FROM read_parquet('{parquet}') "
                f"WHERE xmax >= ? AND xmin <= ? AND ymax >= ? AND ymin <= ? AND ST_Intersects(geometry, {env})",
                [w, e, s, n]).fetchone()
            decoded = decode_tile(pm, z, x, y, tmp)
            got = con.execute(
                f"SELECT {amount_sql(kind, 'geom', env)} FROM ST_Read('{tmp}')").fetchone()[0] \
                if decoded and measured else 0
            rows.append({'z': z, 'x': x, 'y': y, 'decoded': decoded, 'parquet': expect,
                         'cover': round(got / want, 3) if want else None})
    tmp.unlink(missing_ok=True)
    return rows


def report_problems(rows: list[dict], max_zoom: int, kind: str) -> list[str]:
    """The max zoom keeps every feature at its true area; below it, polygons
    still cover the ground (coalesced shapes do; a dropped one is a hole;
    tippecanoe turns sub-pixel polygons into dust squares of about the same
    total area, hence the band)."""
    out = []
    for r in rows:
        tile = f"z{r['z']}/{r['x']}/{r['y']}"
        at_max = r['z'] == max_zoom
        if at_max and r['decoded'] < r['parquet']:
            out.append(f"{tile}: {r['decoded']:,} decoded < {r['parquet']:,} in the parquet")
        low, high = COVER_AT_MAX if at_max else COVER_BELOW_MAX
        if kind == 'polygon' and r['cover'] is not None and not low <= r['cover'] <= high:
            out.append(f"{tile}: polygons cover {r['cover']:.0%} of the parquet's area")
        if kind == 'line' and r['z'] == max_zoom and r['cover'] is not None and r['cover'] < 0.95:
            out.append(f"{tile}: lines keep {r['cover']:.0%} of the parquet's length")
    return out


# ── build ────────────────────────────────────────────────────────────────────

def source_of(layer: dict) -> tuple[str, str]:
    """(url, 'parquet' | 'geojson'): the parquet when the layer has one."""
    for fmt in ('parquet', 'geojson'):
        if (layer.get(fmt) or {}).get('url'):
            return layer[fmt]['url'], fmt
    raise ValueError(f"{layer['id']}: no parquet or geojson to bake tiles from")


def geometry_column(columns: list[tuple[str, str]]) -> str:
    return next(c for c, t in columns if 'GEOMETRY' in t.upper())


def flat_parquet(con, src: Path, fmt: str, part: Path) -> None:
    """A parquet with `geometry` and flat xmin/ymin/xmax/ymax, for the checks."""
    read = f"read_parquet('{src}')" if fmt == 'parquet' else f"ST_Read('{src}')"
    described = [(r[0], r[1]) for r in con.execute(f'DESCRIBE SELECT * FROM {read}').fetchall()]
    geom = geometry_column(described)
    cols = [c for c, _ in described]
    keep = ', '.join(f'"{c}"' for c in cols if c not in (*BBOX, geom))
    con.execute(f"""COPY (SELECT {keep + ', ' if keep else ''}{geom} AS geometry,
                    ST_XMin({geom}) xmin, ST_YMin({geom}) ymin, ST_XMax({geom}) xmax, ST_YMax({geom}) ymax
                    FROM {read} WHERE {geom} IS NOT NULL) TO '{part}' (FORMAT PARQUET)""")


def build(layer: dict, deadline: Deadline, baked_stats: dict | None = None) -> tuple[Path, dict]:
    """The checked PMTiles file for one layer and its check record."""
    lid = layer['id']
    work = WORK / lid
    url, fmt = source_of(layer)
    src = fetch(url, work / f'source.{fmt}')
    con = make_con()
    con.execute(f"SET temp_directory = '{work / 'duckdb_tmp'}'")
    con.execute('SET preserve_insertion_order = false')
    con.execute(f"SET memory_limit = '{DUCKDB_MEMORY}'")  # several bakes can share the host

    deadline.check(f'{lid}: flat parquet')
    src_cols = schema(con, src) if fmt == 'parquet' else []
    ready = {'xmin', 'ymax'} <= {c for c, _ in src_cols} and geometry_column(src_cols) == 'geometry'
    flat = src if ready else cached(work / 'flat.parquet', lambda p: flat_parquet(con, src, fmt, p))
    kind = geometry_kind(con, flat)
    columns = schema(con, flat)
    live = live_tiles(layer)
    junk = gis_artefact_columns()
    stats = filter_stats(baked_stats, src, fmt, con, work / 'filter_stats.json')
    fields = tile_fields(popup_fields(lid, columns, junk, live['fields'] if live else None),
                         tile_filter_columns(stats) if stats else [], columns)
    # Narrowed: the tiles leave out a column a reader could want (not just artefacts).
    narrowed = bool(set(popup_fields('', columns, junk)) - set(fields))
    log(f'  {lid}: {kind}s, tile fields {fields}')

    seq = work / 'tiles.geojsonl'
    try:
        for i, (detail, suffix) in enumerate(DETAIL_TRIES):
            pm = work / f'tiles{suffix}.pmtiles'
            if not pm.exists():
                deadline.check(f'{lid}: GeoJSONSeq')
                cols = ''.join(f'"{f}", ' for f in fields)
                cached(seq, lambda p: con.execute(
                    f"COPY (SELECT {cols}geometry FROM read_parquet('{flat}') WHERE geometry IS NOT NULL) "
                    f"TO '{p}' WITH (FORMAT GDAL, DRIVER 'GeoJSONSeq')"))
                deadline.check(f'{lid}: tippecanoe')
                min_max_zoom = max(live['max_zoom'] if live else 0, MIN_MAX_ZOOM)
                log(f'  {lid}: tippecanoe, low detail {detail or "default"} ({seq.stat().st_size / 1e6:,.0f} MB in)')
                t0 = time.monotonic()
                cached(pm, lambda p: subprocess.run(
                    tippecanoe_args(seq, p, lid, fields, kind, min_max_zoom, detail), check=True, capture_output=True,
                    timeout=min(STEP_TIMEOUT_S, max(60, deadline.end - deadline.clock()))))
                log(f'  {lid}: {pm.stat().st_size / 1e6:,.1f} MB of tiles in {time.monotonic() - t0:,.0f} s')
            deadline.check(f'{lid}: checks')
            checks, record = tile_checks(layer, pm, flat, con, kind, fields, narrowed, work / f'checks{suffix}.json')
            failed = checks['flags'] + checks['problems']
            if not failed:
                return pm, checks
            if i + 1 < len(DETAIL_TRIES):
                log(f'  {lid}: {failed}; trying the next detail setting')
        raise RuntimeError(f"{lid}: tiles fail the checks: {failed} (see {record})")
    finally:
        if not isinstance(sys.exc_info()[1], OutOfTime):  # a stopped run keeps it for the re-run
            seq.unlink(missing_ok=True)


def tile_checks(layer: dict, pm: Path, flat: Path, con, kind: str, fields: list[str], narrowed: bool,
                record: Path) -> tuple[dict, Path]:
    """The check record of one tiles file (written once), with today's rule applied."""
    if not record.exists():
        audit = at.audit_archive(at.file_reader(pm))
        rows = tile_report(pm, flat, con, kind)
        out = {'kind': kind, 'fields': fields, 'narrowed': narrowed, 'audit': audit, 'tiles': rows}
        record.write_text(json.dumps(out, indent=1))
    checks = json.loads(record.read_text())
    # The rule may have changed since the record was written: apply today's.
    checks['flags'] = at.flag(checks['audit'], layer.get('rows'))
    checks['problems'] = report_problems(checks['tiles'], checks['audit']['max_zoom'], checks['kind'])
    for r in checks['tiles']:
        log(f"    z{r['z']}/{r['x']}/{r['y']}: decoded {r['decoded']:,}  parquet {r['parquet']:,}  cover {r['cover']}")
    return checks, record


def live_tiles(layer: dict) -> dict | None:
    """The audit of the tiles the catalog points at now (cached), or None."""
    pm = layer.get('pmtiles') or {}
    return at.cached_audit(pm['url'], pm.get('bytes')) if pm.get('url') else None


# ── publish ──────────────────────────────────────────────────────────────────

def versioned_key(layer: dict, md5: str) -> str:
    """<stem>.<md5[:8]>.pmtiles next to the current tiles, or next to the
    file the tiles were made from when the layer had none."""
    url = (layer.get('pmtiles') or {}).get('url') or source_of(layer)[0]
    key = url.split('.r2.dev/', 1)[1]
    stem = re.sub(r'(\.[0-9a-f]{8})?\.(pmtiles|parquet|geojson)$', '', key)
    return f'{stem}.{md5[:8]}.pmtiles'


def with_note(notes: str | None) -> str:
    """Notes that say the tiles carry the popup fields only (said once)."""
    if notes and NOTE_MARK in notes:
        return notes
    if not notes:
        return NOTE
    return f"{notes}{'' if notes.rstrip().endswith(('.', ')')) else '.'} {NOTE}"


def patched_layer(layer: dict, key: str, nbytes: int, narrowed: bool) -> dict:
    """The layer pointing at the new tiles. The tiles are bharatlas's own
    now, so the compiler's tile link goes."""
    out = {**layer, 'pmtiles': {'url': f'{R2_PUBLIC}/{key}', 'bytes': nbytes}}
    if narrowed:
        out['notes'] = with_note(out.get('notes'))
    return out


def patch_catalog(lid: str, key: str, nbytes: int, narrowed: bool, catalog: Path = CATALOG,
                  manifest: Path = MANIFEST) -> None:
    c = json.loads(catalog.read_text())
    c['layers'] = [patched_layer(layer, key, nbytes, narrowed) if layer['id'] == lid else layer
                   for layer in c['layers']]
    catalog.write_text(json.dumps(c, indent=2) + '\n')
    # build_catalog.py rebuilds ingested layers from this manifest: keep it in step.
    rows = json.loads(manifest.read_text())
    for r in rows:
        if r.get('id') == lid and key.startswith(f"{r.get('r2_prefix')}/"):
            r['pmtiles_file'], r['pmtiles_bytes'] = key.rsplit('/', 1)[1], nbytes
            if narrowed:
                r['notes'] = with_note(r.get('notes'))
    write_json(manifest, rows)


@contextlib.contextmanager
def upload_lock(lock: Path = LOCK, owner: str = LOCK_OWNER, wait_s: float = 30) -> Iterator[None]:
    """One upload at a time across agents: mkdir is atomic. Released on any
    exit, SIGTERM included."""
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            who = (lock / 'owner').read_text().strip() if (lock / 'owner').exists() else '?'
            log(f'  upload lock held by {who}; retry in {wait_s:.0f} s')
            time.sleep(wait_s)
    (lock / 'owner').write_text(owner + '\n')
    previous = signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        yield
    finally:
        shutil.rmtree(lock, ignore_errors=True)
        signal.signal(signal.SIGTERM, previous)


def publish(layer: dict, pm: Path, checks: dict) -> str:
    md5 = file_md5(pm)
    key = versioned_key(layer, md5)
    s3 = r2_client()
    if not _remote_has(s3, key, md5):  # the md5 skip, before taking the upload lock
        with upload_lock():
            upload(s3, pm, key)
    patch_catalog(layer['id'], key, pm.stat().st_size, checks['narrowed'])
    return key


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
    if '--flagged' in args:
        report = json.loads((at.CACHE / 'report.json').read_text())
        ids += [i for i, r in report.items() if r['reasons'] and i not in ids]
    if do_upload:
        missing = [k for k in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
                   if k not in os.environ]
        if missing:
            log(f'ERROR: not set in env: {missing}')
            return 2
    deadline = Deadline(minutes)
    failed = []
    for lid in ids:
        layer = next((x for x in catalog['layers'] if x['id'] == lid), None)
        if layer is None:
            log(f'{lid}: not in catalog.json')
            failed.append(lid)
            continue
        log(f'\n-> {lid}')
        try:
            pm, checks = build(layer, deadline, catalog.get('filter_stats', {}).get(lid))
            if do_upload:
                log(f'  {lid}: on R2 as {publish(layer, pm, checks)}')
        except OutOfTime as e:
            log(f'STOPPED: {e}; finished steps are kept, re-run to continue')
            return 3
        except (RuntimeError, ValueError, StopIteration, duckdb.Error,
                subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            tail = (getattr(e, 'stderr', None) or b'')[-800:]
            log(f'  FAILED {lid}: {e}' + (f"\n{tail.decode(errors='replace')}" if tail else ''))
            failed.append(lid)
    if failed:
        log(f'\nfailed: {failed}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.stdout.reconfigure(line_buffering=True)
    sys.exit(main(sys.argv))
