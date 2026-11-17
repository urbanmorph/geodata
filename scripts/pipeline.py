"""Shared helpers for the data pipeline: logging, retries, atomic files,
DuckDB connections, R2 uploads, the parquet bbox/Hilbert rebake and the
whole-layer download bakes.

Importing this module has no side effects (no directories, no network, no
heavy imports): boto3 and duckdb load inside the functions that need them.
"""
from __future__ import annotations

import contextlib
import hashlib
import http.client
import json
import os
import re
import subprocess
import time
from collections.abc import Callable, Iterable, Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent

BUCKET = 'geodata-data'
R2_PUBLIC = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'

CONTENT_TYPES = {
    '.parquet': 'application/vnd.apache.parquet',
    '.pmtiles': 'application/vnd.pmtiles',
    '.geojson': 'application/geo+json',
    '.kml':     'application/vnd.google-earth.kml+xml',
    '.kmz':     'application/vnd.google-earth.kmz',
    '.json':    'application/json',
    '.zip':     'application/zip',  # for *.shp.zip
}

# Whole-layer geojson/kml/shapefile bakes only run when the source parquet is
# small enough that the GeoJSON expansion (typically 3-5x parquet) is still
# tractable as a single download. Anything larger is gated to per-state
# slices in the viewer.
WHOLE_LAYER_MAX_MB = int(os.environ.get('WHOLE_LAYER_MAX_MB', '100'))

# Lift GDAL's 200 MB per-feature GeoJSON read limit: one CRZ 2019 line alone
# is larger, and ogr2ogr then fails the KML and shapefile conversions.
OGR_ENV = {**os.environ, 'OGR_GEOJSON_MAX_OBJ_SIZE': '0'}

DBF_MAX_BYTES = 2 * 1024**3  # most GIS tools refuse a .dbf of 2 GB or more


# ── logging + retries ────────────────────────────────────────────────────────

def log(*msg: Any) -> None:
    print(*msg, flush=True)


def with_retries(fn: Callable[[], Any], tries: int = 6, wait: Callable[[int], None] | None = None,
                 give_up: Callable[[Exception], bool] = lambda e: False) -> Any:
    """Retry network errors, including a response cut off mid-transfer
    (http.client.IncompleteRead is not an OSError). `give_up(e)` stops early
    on an error that won't heal (a 404). Messages never hold the URL, so an
    API key in a query string stays out of the log."""
    wait = wait or (lambda n: time.sleep(5 * n))
    for attempt in range(1, tries + 1):
        try:
            return fn()
        except (OSError, http.client.HTTPException, json.JSONDecodeError) as e:
            if attempt == tries or give_up(e):
                raise
            log(f'  retry {attempt}: {type(e).__name__}')
            wait(attempt)
    raise AssertionError('unreachable')


# A plain, generic client name: r2.dev and some portals refuse urllib's default.
USER_AGENT = 'Mozilla/5.0 (compatible; bharatlas-pipeline/1.0; +https://bharatlas.com)'


def _client_error(e: Exception) -> bool:
    import urllib.error
    return isinstance(e, urllib.error.HTTPError) and 400 <= e.code < 500 and e.code not in (408, 429)


def download(url: str, dest: Path, *, tries: int = 4, timeout: float = 300,
             wait: Callable[[int], None] | None = None) -> int:
    """Stream `url` to `dest` unless it is already there; returns its size.
    The body goes to a .part file renamed into place only when complete, so
    a killed or failed run never leaves a truncated file that counts as done.
    Retries network errors and 5xx/429 with backoff; a 4xx fails at once."""
    import shutil
    import urllib.request
    if dest.exists():
        return dest.stat().st_size
    dest.parent.mkdir(parents=True, exist_ok=True)

    def once() -> None:
        log(f'  fetching {url}')
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with atomic_output(dest) as part, urllib.request.urlopen(req, timeout=timeout) as r, \
                part.open('wb') as f:
            shutil.copyfileobj(r, f, 1 << 20)

    with_retries(once, tries, wait, give_up=_client_error)
    return dest.stat().st_size


# ── files ────────────────────────────────────────────────────────────────────

@contextlib.contextmanager
def atomic_output(final: Path) -> Iterator[Path]:
    """Yield a temporary path; move it to `final` only if the block succeeds,
    so an interrupted bake never leaves a truncated file under the real name
    (bakes skip outputs that exist). The real extension stays last
    (`x.part.pmtiles`): tippecanoe and GDAL pick the format from it."""
    part = final.with_name(f'{final.stem}.part{final.suffix}')
    part.unlink(missing_ok=True)
    try:
        yield part
        os.replace(part, final)
    finally:
        part.unlink(missing_ok=True)


def file_md5(path: Path) -> str:
    h = hashlib.md5()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def is_fresh(out: Path, *sources: Path) -> bool:
    """True when `out` exists, is non-empty and is at least as new as every
    source: a rebake skips it. A partial file can't pass (writers go through
    atomic_output) and a refreshed source makes it stale."""
    try:
        st = out.stat()
    except FileNotFoundError:
        return False
    return st.st_size > 0 and all(st.st_mtime >= s.stat().st_mtime for s in sources)


def write_stable_zip(files: Iterable[Path], out: Path) -> None:
    """Zip `files` (flat, in the given order) with a fixed timestamp, so the
    same input gives the same bytes and md5 (no needless re-upload)."""
    import zipfile
    with atomic_output(out) as part, zipfile.ZipFile(part, 'w', zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            info = zipfile.ZipInfo(f.name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, f.read_bytes())


def write_json(path: Path, data: Any) -> None:
    """The house JSON style for catalog.json and the manifest: 2-space
    indent, ASCII escapes, trailing newline (no diff churn)."""
    path.write_text(json.dumps(data, indent=2, ensure_ascii=True) + '\n')


def parquet_rows(path: Path) -> int:
    import duckdb
    return duckdb.connect().execute('SELECT count(*) FROM read_parquet(?)', [str(path)]).fetchone()[0]


def slug(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', '_', str(value).lower()).strip('_') or 'unknown'


# ── DuckDB ───────────────────────────────────────────────────────────────────

def make_con():
    """A DuckDB connection with spatial loaded and GDAL kept in lon,lat order."""
    import duckdb
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial')
    # GDAL writes EPSG:4326-tagged geometry as lat,lon unless told otherwise,
    # which put every city ward layer's downloads in the wrong place.
    con.execute('SET geometry_always_xy = true')
    return con


# ── R2 ───────────────────────────────────────────────────────────────────────

def r2_client():
    import boto3
    from botocore.config import Config
    return boto3.client(
        's3',
        endpoint_url=f'https://{os.environ["CLOUDFLARE_ACCOUNT_ID"]}.r2.cloudflarestorage.com',
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        config=Config(signature_version='s3v4'),
    )


def r2_upload(s3, local: Path, key: str) -> None:
    from boto3.s3.transfer import TransferConfig
    ext = ''.join(local.suffixes[-1:])
    ct = CONTENT_TYPES.get(ext, 'application/octet-stream')
    # Skip only when the remote holds the same bytes. Sizes can't tell (a
    # lat,lon swap keeps the byte count) and a multipart ETag isn't an MD5,
    # so each upload stores its MD5 in metadata and that is compared.
    md5 = file_md5(local)
    try:
        head = s3.head_object(Bucket=BUCKET, Key=key)
        # Objects put by older uploaders carry no md5 metadata; a single-part
        # ETag is the body's MD5 (a multipart one has a "-N" suffix and isn't).
        remote = head.get('Metadata', {}).get('md5') or head.get('ETag', '').strip('"')
        if remote == md5:
            log(f'  R2 skip (md5 match): s3://{BUCKET}/{key}')
            return
    except s3.exceptions.ClientError:
        pass

    transfer = TransferConfig(multipart_threshold=64 * 1024 * 1024, multipart_chunksize=64 * 1024 * 1024)
    extra = {
        'ContentType': ct,
        # Downloads save as files (cross-origin links to r2.dev ignore the
        # HTML download attribute); pmtiles stays inline for MapLibre's range reads.
        'ContentDisposition': 'inline' if ext == '.pmtiles' else f'attachment; filename="{local.name}"',
        'CacheControl': 'public, max-age=604800, immutable',
        'Metadata': {'md5': md5},
    }
    log(f'  uploading → s3://{BUCKET}/{key}  ({local.stat().st_size:,} bytes)')
    s3.upload_file(str(local), BUCKET, key, ExtraArgs=extra, Config=transfer)


# ── catalog.json + external-ingested.json patching ───────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def upsert_by_id(rows: list[dict], row: dict) -> list[dict]:
    """Replace the row with row['id'] where it stands, or append it. Keeping
    the position means a re-run moves nothing (no diff)."""
    out = [row if r.get('id') == row['id'] else r for r in rows]
    return out if any(r.get('id') == row['id'] for r in rows) else [*out, row]


def upsert_layer(catalog: dict, entry: dict, level_meta: dict, level: str | None = None,
                 attribution: tuple[str, dict] | None = None,
                 category: tuple[str, str] | None = None) -> dict:
    """Patch one layer into a catalog dict in place (never rebuild the catalog).

    Idempotent: the layer keeps its place and its first `fetched_at` (the
    card's "Updated" date), so a second run with the same inputs changes
    nothing. Also sets level_meta[level], appends the level to level_order
    (the home page iterates it), and adds the attribution and the category
    (before 'other', which stays last) when given."""
    prev = next((l for l in catalog.setdefault('layers', []) if l.get('id') == entry['id']), {})
    entry = {**entry, 'fetched_at': prev.get('fetched_at') or entry.get('fetched_at') or now_iso()}
    catalog['layers'] = upsert_by_id(catalog['layers'], entry)
    level = level or entry.get('level') or entry['id']
    catalog.setdefault('level_meta', {})[level] = level_meta
    order = catalog.setdefault('level_order', [])
    if level not in order:
        order.append(level)
    if attribution:
        catalog.setdefault('attribution', {})[attribution[0]] = dict(attribution[1])
    if category:
        cats = catalog.setdefault('categories', {})
        if category[0] not in cats:
            other = cats.pop('other', None)
            cats[category[0]] = category[1]
            if other is not None:
                cats['other'] = other
    return catalog


def register_layer(catalog_path: Path, manifest_path: Path, entry: dict, manifest_row: dict,
                   level_meta: dict, **kw) -> None:
    """upsert_layer into catalog.json and upsert_by_id into the manifest, on disk."""
    catalog = json.loads(catalog_path.read_text())
    write_json(catalog_path, upsert_layer(catalog, entry, level_meta, **kw))
    write_json(manifest_path, upsert_by_id(json.loads(manifest_path.read_text()), manifest_row))


# ── parquet: flat bbox + Hilbert order ───────────────────────────────────────

def row_group_size_for(feature_count: int) -> int | None:
    """Tighter row groups → tighter per-group bbox stats → more effective
    /api/v1/nearby pruning. Default (122880) wastes pruning on dense layers
    because a single group still covers a meaningful chunk of India even
    after Hilbert sort. Bucket by feature count so each layer ends up with
    enough groups that even Hilbert curve discontinuities (zigzag points
    that span large bboxes) only pull in ~120k rows post-prune.

    Returns None for tiny layers where a single group is fine.

    Cap at 20k: a 50k tier was tried for >1M-row layers and left Mumbai
    and Delhi Overture queries 503-ing because 5-6 row groups matched
    their bbox including a Hilbert outlier spanning half of west India.
    """
    if feature_count < 10_000:    return None
    if feature_count < 100_000:   return 5_000
    return 20_000


def rebake_flatten_bbox(src: Path, dst: Path, con=None) -> tuple[int, list[str]]:
    """Re-emit parquet so /api/v1/nearby can prune efficiently:
      1. Top-level flat xmin/ymin/xmax/ymax columns — either flattened from
         an existing `bbox` STRUCT (ramSeraph shape) or synthesised from the
         geometry's extent when neither is present (own-bake LGD shape).
      2. Rows ordered along a Hilbert curve over India's bbox so row-group
         bbox stats are tight enough for hyparquet to skip entire groups.

    Without (1) /nearby falls through to a full WKB scan that's capped at
    200 MB; without (2) the row-group bbox stats span all of India and no
    pruning happens regardless of how good the filter is.

    Pass `con` to run on a caller's connection (big bakes set temp_directory
    and preserve_insertion_order there so the Hilbert sort can spill).

    Returns (feature_count, non-geom column names).
    """
    if con is None:
        import duckdb
        con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    cols = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{src}')").fetchall()
    col_names = [c[0] for c in cols]
    has_bbox_struct = 'bbox' in col_names
    has_flat_bbox = all(c in col_names for c in ('xmin', 'ymin', 'xmax', 'ymax'))
    # ramSeraph parquet stores `geometry` already typed as GEOMETRY; a few
    # older / simpler files store it as raw BLOB (WKB) or name the column
    # `geom` / `wkb_geometry` (e.g. own-bake point layers like nic_health).
    # Detect the column name + its type rather than assuming `geometry`.
    geom_col = next((c[0] for c in cols if c[0] in ('geometry', 'wkb_geometry', 'geom')), 'geometry')
    geom_type = next((c[1] for c in cols if c[0] == geom_col), 'BLOB')
    geom_expr = geom_col if 'GEOMETRY' in geom_type else f'ST_GeomFromWKB({geom_col})'
    # India bbox; ST_Hilbert uses this as the curve's domain so the 32-bit
    # index has max resolution over the country instead of the whole world.
    india_bbox = "ST_Extent(ST_MakeEnvelope(68, 6, 98, 38))"

    if has_bbox_struct:
        # Flatten the struct into top-level cols, drop the struct itself.
        bbox_clause = (
            "SELECT * EXCLUDE (bbox), "
            "bbox.xmin AS xmin, bbox.ymin AS ymin, "
            "bbox.xmax AS xmax, bbox.ymax AS ymax"
        )
    elif has_flat_bbox:
        bbox_clause = "SELECT *"
    else:
        # No bbox in source; compute from the geometry's extent per row.
        bbox_clause = (
            f"SELECT *, "
            f"ST_XMin({geom_expr}) AS xmin, ST_YMin({geom_expr}) AS ymin, "
            f"ST_XMax({geom_expr}) AS xmax, ST_YMax({geom_expr}) AS ymax"
        )

    row_count = con.execute(f"SELECT COUNT(*) FROM read_parquet('{src}')").fetchone()[0]
    rgs = row_group_size_for(row_count)
    rgs_clause = f", ROW_GROUP_SIZE {rgs}" if rgs is not None else ""
    # Ties on the Hilbert key (many features at one point) break on the source
    # row number: a parallel sort otherwise orders them differently each run,
    # changing the bytes (and the md5) of an unchanged layer.
    con.execute(
        f"COPY (SELECT * EXCLUDE (file_row_number) FROM ("
        f"{bbox_clause} FROM read_parquet('{src}', file_row_number = true)) "
        f"ORDER BY ST_Hilbert({geom_expr}, {india_bbox}), file_row_number) TO '{dst}' "
        f"(FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9{rgs_clause})"
    )

    n = con.execute(f"SELECT COUNT(*) FROM read_parquet('{dst}')").fetchone()[0]
    final_cols = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{dst}')").fetchall()
    non_geom = [c[0] for c in final_cols if 'GEOMETRY' not in c[1] and c[0] not in ('geometry',)]
    return n, non_geom


def geojson_to_parquet(gj: Path, out: Path, geometry_name: str | None = None, con=None) -> int:
    """GeoJSON -> parquet with flat bbox columns in Hilbert order (what
    /api/v1/nearby needs). ST_Read names the geometry `geom`; pass
    `geometry_name` to rename it. Returns the feature count."""
    if con is None:
        import duckdb
        con = duckdb.connect()
        con.execute('INSTALL spatial; LOAD spatial;')
    geom = f'* EXCLUDE (geom), geom AS "{geometry_name}"' if geometry_name else '*'
    raw = out.with_name(f'{out.stem}.raw.parquet')
    try:
        con.execute(f"COPY (SELECT {geom} FROM ST_Read('{gj}')) TO '{raw}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        n, _ = rebake_flatten_bbox(raw, out, con)
    finally:
        raw.unlink(missing_ok=True)
    return n


# ── whole-layer downloads: geojson + kml + shapefile ─────────────────────────

def write_split_shapefiles(src_parquet: Path, out_dir: Path, basename: str, column: str) -> None:
    """One shapefile per distinct `column` value (e.g. state), so each .dbf
    stays under 2 GB. Read from the parquet, not the GeoJSON: one scan per
    value of a multi-GB GeoJSON would be slow. Same columns as the GeoJSON."""
    con = make_con()
    src = f"read_parquet('{src_parquet}')"
    for (value,) in con.execute(f'SELECT DISTINCT "{column}" FROM {src} ORDER BY 1').fetchall():
        cond = f'"{column}" IS NULL' if value is None else f'"{column}" = ?'
        con.execute(
            f"COPY (SELECT * FROM {src} WHERE {cond}) TO '{out_dir / f'{basename}_{slug(value)}.shp'}' "
            "WITH (FORMAT GDAL, DRIVER 'ESRI Shapefile', LAYER_CREATION_OPTIONS ('ENCODING=UTF-8', 'RESIZE=YES'))",
            [] if value is None else [value])


def bake_whole_layer(d, src_parquet: Path, bake_dir: Path, basename: str | None = None) -> dict[str, Path]:
    """Bake geojson + kml + shapefile.zip from the source parquet so the
    catalog card surfaces "Download whole layer" buttons. Skips silently if
    the parquet exceeds WHOLE_LAYER_MAX_MB (default 100), unless the layer sets
    bake_all_formats. Returns a dict of {format: local_path} for successfully
    baked outputs.

    `d` is any layer description with bake_all_formats, kml_name_field (opt),
    shp_split_by and parquet_url (used for the default basename).

    The parquet (always baked) drives the viewer, query and filter; these
    extras serve QGIS / Google Earth / ArcGIS users. A failure here doesn't
    block the ingest.
    """
    import duckdb
    pq_bytes = src_parquet.stat().st_size
    if not d.bake_all_formats and pq_bytes > WHOLE_LAYER_MAX_MB * 1024 * 1024:
        log(f'  whole-layer bake skipped (parquet {pq_bytes / 1024 / 1024:.0f} MB > {WHOLE_LAYER_MAX_MB} MB cap)')
        return {}

    bake_dir.mkdir(parents=True, exist_ok=True)
    basename = basename or Path(d.parquet_url).stem
    kml_name_field = getattr(d, 'kml_name_field', '')

    outputs: dict[str, Path] = {}

    # Each output is rebuilt only when missing or older than what it is made
    # from, and written under a temporary name, so a re-run does no work and a
    # killed run leaves nothing half-written to skip.
    geojson_path = bake_dir / f'{basename}.geojson'
    if not is_fresh(geojson_path, src_parquet):
        try:
            with atomic_output(geojson_path) as part:
                make_con().execute(
                    f"COPY (SELECT * FROM read_parquet('{src_parquet}')) "
                    f"TO '{part}' WITH (FORMAT GDAL, DRIVER 'GeoJSON')"
                )
        except Exception as e:  # noqa: BLE001  (logged; the parquet still ships)
            log(f'  geojson bake failed: {e}')
            return {}  # without geojson we can't bake kml or shapefile downstream
    outputs['geojson'] = geojson_path

    kml_path = bake_dir / f'{basename}.kml'
    try:
        if not is_fresh(kml_path, geojson_path):
            with atomic_output(kml_path) as part:
                subprocess.run(
                    ['ogr2ogr', '-f', 'KML',
                     *(['-dsco', f'NameField={kml_name_field}'] if kml_name_field else []),
                     str(part), str(geojson_path)],
                    check=True, capture_output=True, timeout=600, env=OGR_ENV,
                )
        outputs['kml'] = kml_path
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        log(f'  kml bake skipped: {e}')

    shp_dir = bake_dir / f'{basename}_shp'
    shp_zip = bake_dir / f'{basename}.shp.zip'
    if is_fresh(shp_zip, geojson_path):
        outputs['shapefile'] = shp_zip
        return outputs
    try:
        shp_dir.mkdir(exist_ok=True)
        # Clear any prior shapefile pieces (idempotent re-run)
        for f in shp_dir.iterdir():
            f.unlink()
        if d.shp_split_by:
            write_split_shapefiles(src_parquet, shp_dir, basename, d.shp_split_by)
        else:
            subprocess.run(
                ['ogr2ogr', '-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', '-lco', 'RESIZE=YES',
                 str(shp_dir / f'{basename}.shp'), str(geojson_path)],
                check=True, capture_output=True, timeout=600, env=OGR_ENV,
            )
        too_big = [f.name for f in shp_dir.glob('*.dbf') if f.stat().st_size >= DBF_MAX_BYTES]
        if too_big:
            # Most GIS tools refuse a .dbf of 2 GB or more: ship no shapefile rather than a broken one.
            log(f'  shapefile skipped: .dbf over {DBF_MAX_BYTES:,} bytes ({", ".join(too_big)}); set shp_split_by')
        else:
            write_stable_zip(sorted(shp_dir.iterdir()), shp_zip)
            outputs['shapefile'] = shp_zip
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, duckdb.Error) as e:
        log(f'  shapefile bake skipped: {e}')

    return outputs
