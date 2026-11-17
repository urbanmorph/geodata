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
from pathlib import Path
from typing import Any, Callable, Iterator

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


def with_retries(fn: Callable[[], Any], tries: int = 6, wait: Callable[[int], None] | None = None) -> Any:
    """Retry network errors, including a response cut off mid-transfer
    (http.client.IncompleteRead is not an OSError). Messages never hold the
    URL, so an API key in a query string stays out of the log."""
    wait = wait or (lambda n: time.sleep(5 * n))
    for attempt in range(1, tries + 1):
        try:
            return fn()
        except (OSError, http.client.HTTPException, json.JSONDecodeError) as e:
            if attempt == tries:
                raise
            log(f'  retry {attempt}: {type(e).__name__}')
            wait(attempt)
    raise AssertionError('unreachable')


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
        if head.get('Metadata', {}).get('md5') == md5:
            log(f'  R2 skip (md5 match): s3://{BUCKET}/{key}')
            return
    except s3.exceptions.ClientError:
        pass

    transfer = TransferConfig(multipart_threshold=64 * 1024 * 1024, multipart_chunksize=64 * 1024 * 1024)
    extra = {
        'ContentType': ct,
        # Parquet downloads should trigger save; pmtiles should be inline so the viewer can fetch.
        'ContentDisposition': f'attachment; filename="{local.name}"' if ext == '.parquet' else 'inline',
        'CacheControl': 'public, max-age=604800, immutable',
        'Metadata': {'md5': md5},
    }
    log(f'  uploading → s3://{BUCKET}/{key}  ({local.stat().st_size:,} bytes)')
    s3.upload_file(str(local), BUCKET, key, ExtraArgs=extra, Config=transfer)


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

    geojson_path = bake_dir / f'{basename}.geojson'
    try:
        con = make_con()
        con.execute(
            f"COPY (SELECT * FROM read_parquet('{src_parquet}')) "
            f"TO '{geojson_path}' WITH (FORMAT GDAL, DRIVER 'GeoJSON')"
        )
        outputs['geojson'] = geojson_path
    except Exception as e:
        log(f'  geojson bake failed: {e}')
        return {}  # without geojson we can't bake kml or shapefile downstream

    kml_path = bake_dir / f'{basename}.kml'
    try:
        subprocess.run(
            ['ogr2ogr', '-f', 'KML',
             *(['-dsco', f'NameField={kml_name_field}'] if kml_name_field else []),
             str(kml_path), str(geojson_path)],
            check=True, capture_output=True, timeout=600, env=OGR_ENV,
        )
        outputs['kml'] = kml_path
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        log(f'  kml bake skipped: {e}')

    shp_dir = bake_dir / f'{basename}_shp'
    shp_zip = bake_dir / f'{basename}.shp.zip'
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
            import zipfile
            with zipfile.ZipFile(shp_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
                for f in sorted(shp_dir.iterdir()):
                    # Fixed timestamp: same input, same bytes, same md5 (no re-upload).
                    info = zipfile.ZipInfo(f.name, date_time=(1980, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    zf.writestr(info, f.read_bytes())
            outputs['shapefile'] = shp_zip
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, duckdb.Error) as e:
        log(f'  shapefile bake skipped: {e}')

    return outputs
