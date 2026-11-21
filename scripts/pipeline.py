"""Shared helpers for the data pipeline: logging, retries, atomic files,
DuckDB connections, R2 uploads, durable cache backups (R2 cache/<prefix>/),
the parquet bbox/Hilbert rebake and the whole-layer download bakes.

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
import sys
import threading
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
    '.csv':     'text/csv; charset=utf-8',
    '.md':      'text/markdown; charset=utf-8',
    '.tif':     'image/tiff',  # Cloud-Optimized GeoTIFF (SoilGrids)
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
    """Unbuffered, one write per line (lines from worker threads never interleave)."""
    sys.stdout.write(' '.join(map(str, msg)) + '\n')
    sys.stdout.flush()


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


def is_client_error(e: Exception) -> bool:
    import urllib.error
    return isinstance(e, urllib.error.HTTPError) and 400 <= e.code < 500 and e.code not in (408, 429)


CHUNK = 1 << 20
PROGRESS_EVERY = 200 * CHUNK
_MD5 = re.compile(r'^[0-9a-f]{32}$')


def part_path(dest: Path) -> Path:
    """Where a download or build of `dest` is written until it is complete
    (the real extension stays last, as in atomic_output)."""
    return dest.with_name(f'{dest.stem}.part{dest.suffix}')


def _total_size(resp, start: int) -> int | None:
    cr = resp.headers.get('Content-Range')
    if cr and '/' in cr and not cr.endswith('/*'):
        return int(cr.rsplit('/', 1)[1])
    cl = resp.headers.get('Content-Length')
    return start + int(cl) if cl is not None else None


# Hosts whose single-part ETag is the body's MD5 (S3 semantics). Elsewhere an
# ETag is opaque, even when it happens to look like 32 hex digits.
MD5_ETAG_HOSTS = ('.r2.dev', '.r2.cloudflarestorage.com', '.amazonaws.com')


def _served_md5(resp, url: str) -> str | None:
    """The body's MD5 when the server states it: our uploads' md5 metadata, or
    an S3/R2 single-part ETag (a multipart one has a "-N" suffix and is no MD5)."""
    from urllib.parse import urlsplit
    meta = resp.headers.get('x-amz-meta-md5')
    if meta and _MD5.match(meta):
        return meta
    etag = (resp.headers.get('ETag') or '').strip('"')
    host = urlsplit(url).hostname or ''
    if _MD5.match(etag) and any(host.endswith(h) or host == h.lstrip('.') for h in MD5_ETAG_HOSTS):
        return etag
    return None


def download(url: str, dest: Path, *, tries: int = 6, timeout: float = 300,
             wait: Callable[[int], None] | None = None, md5: str | None = None) -> int:
    """Stream `url` to `dest` unless it is already there; returns its size.

    The body goes to part_path(dest), renamed into place only when it is
    complete: as many bytes as the server said (Content-Length/Content-Range)
    and, when the caller gives `md5` or the server states one (our md5
    metadata, or an S3/R2 single-part ETag), the right checksum. A cut-off answer
    raises, also when the connection just ended early without an error (an R2
    download once stopped at 232 of 455 MB), and the next try resumes from the
    bytes already on disk (HTTP Range), as does a later run after a kill.
    Retries network errors and 5xx/429 with backoff; a 4xx fails at once.
    Progress lines go to the log every 200 MB."""
    import urllib.error
    import urllib.request
    if dest.exists():
        return dest.stat().st_size
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = part_path(dest)

    def finish(expected_md5: str | None) -> None:
        if expected_md5 and file_md5(part) != expected_md5:
            part.unlink()
            raise OSError(f'{dest.name}: md5 does not match {expected_md5}; deleted, the next try starts over')
        os.replace(part, dest)

    def once() -> None:
        start = part.stat().st_size if part.exists() else 0
        headers = {'User-Agent': USER_AGENT, **({'Range': f'bytes={start}-'} if start else {})}
        log(f'  fetching {dest.name}' + (f' (resuming at {start:,} bytes)' if start else ''))
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as r:
                if start and r.status != 206:
                    start = 0  # the server ignored the Range: start over
                total, served = _total_size(r, start), _served_md5(r, url)
                with part.open('ab' if start else 'wb') as f:
                    n, mark = start, start
                    while chunk := r.read(CHUNK):
                        f.write(chunk)
                        n += len(chunk)
                        if n - mark >= PROGRESS_EVERY:
                            log(f'    {dest.name}: {n / 1e6:,.0f} / {(total or 0) / 1e6:,.0f} MB')
                            mark = n
        except urllib.error.HTTPError as e:
            if e.code == 416 and part.exists():  # the part already holds every byte
                return finish(md5)
            raise
        size = part.stat().st_size
        if total is not None and size != total:
            raise OSError(f'{dest.name}: short read, {size:,} of {total:,} bytes; the next try resumes')
        finish(md5 or served)

    with_retries(once, tries, wait, give_up=is_client_error)
    return dest.stat().st_size


# ── external tools ───────────────────────────────────────────────────────────

TOOL_TIMEOUT_S = 6 * 3600  # tippecanoe / ogr2ogr on the biggest layers; a hang still ends


class ToolFailed(subprocess.CalledProcessError):
    """CalledProcessError whose message carries the end of the tool's stderr
    (a bare "returned non-zero exit status 1" says nothing)."""

    def __str__(self) -> str:
        err = self.stderr.decode(errors='replace') if isinstance(self.stderr, bytes) else (self.stderr or '')
        return f'{super().__str__()}\n{err.strip()[-2000:]}'


def run(cmd: list[str], *, timeout: float, check: bool = True, capture_output: bool = True,
        **kw) -> subprocess.CompletedProcess:
    """subprocess.run with a required timeout; a failure raises ToolFailed
    (still a CalledProcessError) with the tool's stderr in its message."""
    proc = subprocess.run(cmd, timeout=timeout, capture_output=capture_output, **kw)
    if check and proc.returncode != 0:
        raise ToolFailed(proc.returncode, cmd, proc.stdout, proc.stderr)
    return proc


# ── data.gov.in (OGD) API ────────────────────────────────────────────────────

DATAGOV_API = 'https://api.data.gov.in/resource'
DATAGOV_ENV_FILE = Path.home() / 'Projects/rural/shc/.env'


def datagov_api_key() -> str:
    """OGD_API_KEY from the environment, else from DATAGOV_ENV_FILE."""
    if os.environ.get('OGD_API_KEY'):
        return os.environ['OGD_API_KEY']
    if DATAGOV_ENV_FILE.exists():
        for line in DATAGOV_ENV_FILE.read_text().splitlines():
            if line.startswith('OGD_API_KEY='):
                return line.split('=', 1)[1].strip().strip('"\'')
    raise SystemExit(f'no OGD_API_KEY in the environment or {DATAGOV_ENV_FILE}')


def datagov_get(resource: str, key: str, *, tries: int = 6, timeout: float = 180,
                wait: Callable[[int], None] | None = None, **params) -> dict:
    """One JSON answer of a data.gov.in resource (`params`: offset, limit,
    fields, filters[...]). Retries network errors and cut-off answers (big
    pages often are), gives up at once on a 4xx; the URL (with the key) is
    never logged."""
    import urllib.parse
    import urllib.request
    url = f'{DATAGOV_API}/{resource}?' + urllib.parse.urlencode({'api-key': key, 'format': 'json', **params})
    req = urllib.request.Request(url, headers={'User-Agent': 'curl/8'})

    def once() -> dict:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    return with_retries(once, tries, wait, give_up=is_client_error)


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


def read_head(path: Path, n: int) -> bytes:
    """The first `n` bytes of a file (a header or magic number), without loading the rest."""
    with path.open('rb') as f:
        return f.read(n)


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

def make_con(temp_dir: Path | None = None, memory_limit: str | None = None, threads: int | None = None,
             ordered: bool = True):
    """A DuckDB connection with spatial loaded and GDAL kept in lon,lat order;
    for big layers, a spill folder, a memory limit, a thread count and
    `ordered=False` (lets order-free COPYs stream), and no progress bar
    (it floods a redirected log)."""
    import duckdb
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial')
    # GDAL writes EPSG:4326-tagged geometry as lat,lon unless told otherwise,
    # which put every city ward layer's downloads in the wrong place.
    con.execute('SET geometry_always_xy = true')
    con.execute('SET enable_progress_bar = false')
    if temp_dir is not None:
        con.execute(f"SET temp_directory = '{temp_dir}'")
    if memory_limit:
        con.execute(f"SET memory_limit = '{memory_limit}'")
    if threads:
        con.execute(f'SET threads = {int(threads)}')
    if not ordered:
        con.execute('SET preserve_insertion_order = false')
    return con


# ── R2 ───────────────────────────────────────────────────────────────────────

def r2_client(**config):
    """`config` adds botocore Config options (timeouts, retries) for big uploads."""
    import boto3
    from botocore.config import Config
    return boto3.client(
        's3',
        endpoint_url=f'https://{os.environ["CLOUDFLARE_ACCOUNT_ID"]}.r2.cloudflarestorage.com',
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        config=Config(signature_version='s3v4', **config),
    )


class KeyTaken(RuntimeError):
    """A new_only upload found other bytes already under its key."""


def _remote_md5(s3, key: str) -> str | None:
    """The remote object's md5 (None when there is no object). Sizes can't
    tell (a lat,lon swap keeps the byte count) and a multipart ETag isn't an
    MD5, so each upload stores its MD5 in metadata. Objects put by older
    uploaders carry none; a single-part ETag is the body's MD5 (a multipart
    one has a "-N" suffix, never matches, and so never counts as the same)."""
    try:
        head = s3.head_object(Bucket=BUCKET, Key=key)
    except s3.exceptions.ClientError:
        return None
    return _head_md5(head)


def _head_md5(head: dict) -> str | None:
    return head.get('Metadata', {}).get('md5') or head.get('ETag', '').strip('"') or None


def _remote_has(s3, key: str, md5: str, new_only: bool = False) -> bool:
    """True (skip the upload) when the remote holds the same bytes. With
    `new_only`, raise KeyTaken when it holds other bytes: the key is published
    and served immutable, so it must never be overwritten."""
    remote = _remote_md5(s3, key)
    if remote == md5:
        log(f'  R2 skip (md5 match): s3://{BUCKET}/{key}')
        return True
    if new_only and remote is not None:
        raise KeyTaken(f's3://{BUCKET}/{key} already holds other bytes (remote {remote}, local {md5}); '
                       'refusing to overwrite a published key: publish under a new key')
    return False


def _put_args(local: Path, md5: str) -> dict:
    ext = ''.join(local.suffixes[-1:])
    return {
        'ContentType': CONTENT_TYPES.get(ext, 'application/octet-stream'),
        # Downloads save as files (cross-origin links to r2.dev ignore the
        # HTML download attribute); pmtiles stays inline for MapLibre's range reads.
        'ContentDisposition': 'inline' if ext == '.pmtiles' else f'attachment; filename="{local.name}"',
        'CacheControl': 'public, max-age=604800, immutable',
        'Metadata': {'md5': md5},
    }


def r2_verify(s3, local: Path, key: str) -> None:
    """Raise RuntimeError unless R2 holds `local`'s bytes at `key`: same size and md5."""
    try:
        head = s3.head_object(Bucket=BUCKET, Key=key)
    except s3.exceptions.ClientError:
        head = {}
    size, remote, md5 = head.get('ContentLength'), _head_md5(head), file_md5(local)
    if size != local.stat().st_size or remote != md5:
        raise RuntimeError(f's3://{BUCKET}/{key} does not hold {local.name}: size {size} vs {local.stat().st_size}, '
                           f'md5 {remote} vs {md5}')


def r2_upload(s3, local: Path, key: str, new_only: bool = False) -> None:
    """Upload `local` to `key` unless R2 holds the same bytes (md5), under the
    host-wide upload lock. `new_only`: raise KeyTaken rather than overwrite
    other bytes (for keys that are not content-versioned)."""
    from boto3.s3.transfer import TransferConfig
    md5 = file_md5(local)
    if _remote_has(s3, key, md5, new_only):
        return
    transfer = TransferConfig(multipart_threshold=64 * 1024 * 1024, multipart_chunksize=64 * 1024 * 1024)
    with upload_lock(owner=key):
        log(f'  uploading → s3://{BUCKET}/{key}  ({local.stat().st_size:,} bytes)')
        s3.upload_file(str(local), BUCKET, key, ExtraArgs=_put_args(local, md5), Config=transfer)


def r2_upload_resumable(s3, local: Path, key: str, state_dir: Path, part_size: int = 64 * 1024 * 1024,
                        tries: int = 8, wait: Callable[[int], None] | None = None, new_only: bool = False) -> None:
    """r2_upload for multi-GB files on a flaky link. The multipart upload id is
    saved in state_dir, so a dropped or killed run resumes from the parts R2
    already holds (list_parts) instead of starting over; each part retries with
    backoff. Same md5 skip, `new_only`, lock and object headers as r2_upload."""
    md5 = file_md5(local)
    if _remote_has(s3, key, md5, new_only):
        return
    with upload_lock(owner=key):
        _multipart_upload(s3, local, key, md5, state_dir, part_size, tries,
                          wait or (lambda n: time.sleep(min(10 * n, 120))))


def _multipart_upload(s3, local: Path, key: str, md5: str, state_dir: Path, part_size: int,
                      tries: int, wait: Callable[[int], None]) -> None:
    from botocore.exceptions import BotoCoreError
    size = local.stat().st_size
    n_parts = max(1, -(-size // part_size))
    assert n_parts <= 1000, 'list_parts reads one page of 1,000 parts'
    state_path = state_dir / (key.replace('/', '__') + '.json')
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    done: dict[int, str] = {}
    if state and state['md5'] == md5 and state['part_size'] == part_size:
        try:
            # R2 leaves 'Parts' out until the first part lands.
            parts = s3.list_parts(Bucket=BUCKET, Key=key, UploadId=state['upload_id'], MaxParts=1000).get('Parts', [])
            done = {p['PartNumber']: p['ETag'] for p in parts}
        except s3.exceptions.ClientError:  # expired or aborted upload: start over
            state = None
    else:
        state = None
    if state is None:
        uid = s3.create_multipart_upload(Bucket=BUCKET, Key=key, **_put_args(local, md5))['UploadId']
        state = {'upload_id': uid, 'md5': md5, 'part_size': part_size}
        state_dir.mkdir(parents=True, exist_ok=True)
        tmp = state_path.with_name(state_path.name + '.part')
        tmp.write_text(json.dumps(state))
        os.replace(tmp, state_path)
    log(f'  uploading → s3://{BUCKET}/{key}  ({size:,} bytes, {n_parts} parts, {len(done)} already on R2)')
    with local.open('rb') as f:
        for n in range(1, n_parts + 1):
            if n in done:
                continue
            f.seek((n - 1) * part_size)
            body = f.read(part_size)
            for attempt in range(1, tries + 1):
                try:
                    done[n] = s3.upload_part(Bucket=BUCKET, Key=key, PartNumber=n,
                                             UploadId=state['upload_id'], Body=body)['ETag']
                    break
                except (OSError, BotoCoreError) as e:
                    if attempt == tries:
                        raise
                    log(f'    part {n} retry {attempt}: {type(e).__name__}')
                    wait(attempt)
            log(f'    part {n}/{n_parts} done')
    s3.complete_multipart_upload(Bucket=BUCKET, Key=key, UploadId=state['upload_id'], MultipartUpload={
        'Parts': [{'PartNumber': n, 'ETag': done[n]} for n in sorted(done)]})
    state_path.unlink()


UPLOAD_STATE = ROOT / 'data' / 'r2-uploads'  # multipart upload ids, so a killed upload resumes

# Work folders (downloads, bakes, caches) live under data/work/ (gitignored),
# not /tmp: macOS clears /tmp on reboot, and a resumable run lost its cache.
WORK_ROOT = ROOT / 'data' / 'work'


def work_dir(name: str, env: str | None = None, legacy: str | Path | None = None) -> Path:
    """A script's work folder: $`env` when set, else WORK_ROOT/<name>. While
    WORK_ROOT/<name> does not exist yet, an existing `legacy` folder (the old
    /tmp default) is used, so a run cached there resumes. Nothing is created."""
    if env and os.environ.get(env):
        return Path(os.environ[env])
    new = WORK_ROOT / name
    if legacy is not None and not new.exists() and Path(legacy).is_dir():
        return Path(legacy)
    return new


# rebake_tiles, audit_tiles and tile_filter_gaps share one tiles folder.
TILES_WORK = work_dir('tiles', 'TILES_WORK', legacy='/tmp/ramseraph/tiles')


def patient_r2_client():
    """r2_client for long runs on a flaky link: adaptive retries, ten attempts."""
    return r2_client(retries={'max_attempts': 10, 'mode': 'adaptive'})


def r2_upload_retrying(s3, local: Path, key: str, state_dir: Path | None = None,
                       retries: int = 5, backoff: float = 30.0, new_only: bool = False) -> None:
    """r2_upload_resumable (md5-skips unchanged files; its multipart id saved so
    a killed run resumes from the parts R2 holds; logs each part) retried with
    backoff: a dropped TLS connection mid-multipart killed a 316 MB upload once.
    KeyTaken (new_only) is not retried."""
    from botocore.exceptions import BotoCoreError, ClientError
    kw = {'new_only': True} if new_only else {}
    for attempt in range(retries + 1):
        try:
            return r2_upload_resumable(s3, local, key, state_dir or UPLOAD_STATE, **kw)
        except (BotoCoreError, ClientError, OSError) as e:
            if attempt == retries:
                raise
            wait = backoff * 2 ** attempt
            log(f'  upload {key}: {e.__class__.__name__}; retry {attempt + 1}/{retries} in {wait:.0f} s')
            time.sleep(wait)


# One upload at a time across the jobs on this host (bakes, tile rebakes), so
# none starves the link: r2_upload and r2_upload_resumable take it themselves.
# The lock is a directory (mkdir is atomic) holding an owner file "<pid> <who>";
# a lock whose pid is gone (kill -9), or that got no owner file within
# LOCK_NO_OWNER_S, is taken over. Re-entrant within a process (a job holding it
# calls the uploads, which take it again).
UPLOAD_LOCK = Path('/tmp/bharatlas-upload.lock')
LOCK_NO_OWNER_S = 60
_held_locks: dict[Path, int] = {}  # lock -> how many blocks in this process hold it
_held_guard = threading.Lock()


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _lock_owner(lock: Path) -> tuple[int | None, str]:
    try:
        text = (lock / 'owner').read_text().strip()
    except OSError:
        return None, '?'  # just created: its owner is still writing the file
    pid = text.split(' ', 1)[0]
    return (int(pid) if pid.isdigit() else None), text


@contextlib.contextmanager
def upload_lock(lock: Path | None = None, owner: str = '', wait_s: float = 30,
                on_wait: Callable[[str], None] | None = None) -> Iterator[Path]:
    """Hold the host-wide upload lock (UPLOAD_LOCK); wait `wait_s` between tries
    while a live job holds it. Released on exit, an exception, or SIGTERM/SIGHUP
    (turned into SystemExit so the `finally` runs). Re-entrant: a block inside
    another one in this process (any thread) joins it."""
    import shutil
    import signal
    lock = lock or UPLOAD_LOCK
    while True:
        with _held_guard:
            if _held_locks.get(lock):
                _held_locks[lock] += 1
                outer = False
                break
            try:
                lock.mkdir()
                (lock / 'owner').write_text(f'{os.getpid()} {owner}\n')
                _held_locks[lock] = 1
                outer = True
                break
            except FileExistsError:
                pass
        pid, who = _lock_owner(lock)
        with _held_guard:  # no thread of this process takes the lock between the check and the removal
            if _lock_is_stale(lock, pid):
                log(f'  upload lock {lock}: its owner ({who}) is gone; taking it over')
                shutil.rmtree(lock, ignore_errors=True)
                continue
        (on_wait or (lambda w: log(f'  upload lock held by {w}; retry in {wait_s:.0f} s')))(who)
        time.sleep(wait_s)
    main = outer and threading.current_thread() is threading.main_thread()
    old = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGHUP)} if main else {}
    for sig in old:
        signal.signal(sig, lambda n, _f: sys.exit(128 + n))
    try:
        yield lock
    finally:
        with _held_guard:
            _held_locks[lock] -= 1
            if not _held_locks[lock]:
                del _held_locks[lock]
                shutil.rmtree(lock, ignore_errors=True)
        for sig, handler in old.items():
            signal.signal(sig, handler)


def _lock_is_stale(lock: Path, pid: int | None) -> bool:
    """Its owner is dead, is this process (which does not hold it: leaked), or
    never wrote an owner file within LOCK_NO_OWNER_S."""
    if pid is None:
        try:
            return time.time() - lock.stat().st_mtime > LOCK_NO_OWNER_S
        except OSError:
            return False  # released meanwhile: the next mkdir takes it
    return (pid == os.getpid() and not _held_locks.get(lock)) or not _pid_alive(pid)


# ── cached steps + time limit ────────────────────────────────────────────────

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


def take_max_minutes(argv: list[str], default: float) -> tuple[list[str], float]:
    """Split `--max-minutes N` off a plain argv list: (the other args, N or `default`)."""
    if '--max-minutes' not in argv:
        return argv, default
    i = argv.index('--max-minutes')
    return argv[:i] + argv[i + 2:], float(argv[i + 1])


class Deadline:
    """A run's own time limit, inside the host's job limit: stop between steps
    once `minutes` have passed (everything finished so far is cached, so the
    next run continues from there)."""

    def __init__(self, minutes: float, clock: Callable[[], float] = time.monotonic):
        self.clock = clock
        self.end = clock() + minutes * 60

    def left(self) -> float:
        """Seconds left (negative once over)."""
        return self.end - self.clock()

    def check(self, step: str) -> None:
        if self.clock() > self.end:
            raise OutOfTime(f'time limit reached before {step}')


# ── durable caches: R2 under cache/<prefix>/ ─────────────────────────────────

CACHE_PREFIX = 'cache'
CHECKPOINT_EVERY_S = 600
R2_ENV = ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')


def _cache_files(local_dir: Path) -> dict[str, Path]:
    """{relative posix path: file}, leaving out writes in progress (*.part*)."""
    if not local_dir.is_dir():
        return {}
    return {p.relative_to(local_dir).as_posix(): p for p in sorted(local_dir.rglob('*'))
            if p.is_file() and '.part' not in p.name}


def _remote_etags(s3, prefix: str) -> dict[str, str]:
    """{relative path: ETag} under cache/<prefix>/, one paged listing. Cache
    objects go up in a single part, so the ETag is the body's MD5."""
    root = f'{CACHE_PREFIX}/{prefix}/'
    out, token = {}, None
    while True:
        page = s3.list_objects_v2(Bucket=BUCKET, Prefix=root, **({'ContinuationToken': token} if token else {}))
        for o in page.get('Contents', []):
            out[o['Key'][len(root):]] = o['ETag'].strip('"')
        if not page.get('IsTruncated'):
            return out
        token = page['NextContinuationToken']


CACHE_WORKERS = 16  # cache files are many and small: send them in parallel


def checkpoint_cache(local_dir: Path, prefix: str, s3) -> int:
    """Upload every cached answer under `local_dir` to R2 at cache/<prefix>/<path>
    whose bytes R2 doesn't already hold (md5); returns how many went up."""
    from boto3.s3.transfer import TransferConfig
    from concurrent.futures import ThreadPoolExecutor
    single_part = TransferConfig(multipart_threshold=4 * 1024**3)  # keeps the ETag an MD5
    remote = _remote_etags(s3, prefix)
    todo = [(rel, path, md5) for rel, path in _cache_files(local_dir).items()
            if remote.get(rel) != (md5 := file_md5(path))]

    def put(job: tuple[str, Path, str]) -> None:
        rel, path, md5 = job
        extra = {'ContentType': 'application/octet-stream', 'CacheControl': 'no-cache', 'Metadata': {'md5': md5}}
        s3.upload_file(str(path), BUCKET, f'{CACHE_PREFIX}/{prefix}/{rel}', ExtraArgs=extra, Config=single_part)

    with ThreadPoolExecutor(CACHE_WORKERS) as pool:
        list(pool.map(put, todo))
    log(f'  cache checkpoint {prefix}: {len(todo)} file(s) sent to R2')
    return len(todo)


def restore_cache(local_dir: Path, prefix: str, s3) -> int:
    """Download what R2 holds under cache/<prefix>/ that `local_dir` lacks (a
    local file is never overwritten); returns how many came down."""
    from concurrent.futures import ThreadPoolExecutor
    todo = [rel for rel in _remote_etags(s3, prefix) if not (local_dir / rel).exists()]

    def get(rel: str) -> None:
        dest = local_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        with atomic_output(dest) as part:
            s3.download_file(BUCKET, f'{CACHE_PREFIX}/{prefix}/{rel}', str(part))

    with ThreadPoolExecutor(CACHE_WORKERS) as pool:
        list(pool.map(get, todo))
    if todo:
        log(f'  cache restore {prefix}: {len(todo)} file(s) from R2')
    return len(todo)


@contextlib.contextmanager
def cache_backup(local_dir: Path, prefix: str, s3=None, every_s: float = CHECKPOINT_EVERY_S) -> Iterator[None]:
    """Keep `local_dir` (a data program's cache of answers) backed up on R2:
    restore what is missing locally on entry, checkpoint every `every_s`
    seconds from a background thread, and once more on exit, failure or
    SIGTERM included. Without R2 credentials in the env it is local only."""
    import signal
    import sys
    import threading
    if s3 is None:
        if not all(k in os.environ for k in R2_ENV):
            log(f'  cache {prefix}: no R2 credentials in env, local cache only')
            yield
            return
        s3 = r2_client()
    restore_cache(local_dir, prefix, s3)
    stop = threading.Event()

    def checkpoint() -> None:
        try:
            checkpoint_cache(local_dir, prefix, s3)
        except Exception as e:  # noqa: BLE001  (a failed checkpoint must not stop or mask the run)
            log(f'  cache checkpoint {prefix} failed: {type(e).__name__}')

    def loop() -> None:
        while not stop.wait(every_s):
            checkpoint()

    thread = threading.Thread(target=loop, name=f'cache-{prefix}', daemon=True)
    thread.start()
    in_main = threading.current_thread() is threading.main_thread()
    previous = signal.signal(signal.SIGTERM, lambda *_: sys.exit(143)) if in_main else None
    try:
        yield
    finally:
        stop.set()
        thread.join()
        if in_main:
            signal.signal(signal.SIGTERM, previous)
        checkpoint()


def find_parquet(layer: dict) -> Path | None:
    """A catalog layer's parquet on disk: sources/india-geodata/<name> (fetch.sh),
    else data/baked/<R2 key> (the bakes), else None. A key rebake_layer.py
    versioned (<stem>.<md5[:8]>.parquet) is also found under its upstream name:
    the local copy holds the same rows, only without the bbox columns."""
    from tile_keys import unversioned_name
    url = (layer.get('parquet') or {}).get('url')
    if not url:
        return None
    names = dict.fromkeys((url.rsplit('/', 1)[-1], unversioned_name(url)))
    baked_dir = None
    if url.startswith(R2_PUBLIC + '/'):
        baked_dir = (ROOT / 'data' / 'baked' / url[len(R2_PUBLIC) + 1:]).parent
    for name in names:
        for d in (ROOT / 'sources' / 'india-geodata', baked_dir):
            if d is not None and (d / name).exists():
                return d / name
    return None


# ── catalog.json + external-ingested.json patching ───────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def upsert_by_id(rows: list[dict], row: dict) -> list[dict]:
    """Replace the row with row['id'] where it stands, or append it. Keeping
    the position means a re-run moves nothing (no diff)."""
    out = [row if r.get('id') == row['id'] else r for r in rows]
    return out if any(r.get('id') == row['id'] for r in rows) else [*out, row]


def _licence_gate(layer_id: str) -> None:
    from licence_watch import gate
    gate(layer_id)


# Runs before a layer is registered: its licence must read as it did when last reviewed (licence_watch.py).
LICENCE_GATE = _licence_gate


def licence_labelled(entry: dict) -> dict:
    """The entry with the licence, non-commercial flag and credit its reviewed terms set (licence-terms.json)."""
    import licence_watch
    return licence_watch.labelled(entry, licence_watch.load_registry())


def upsert_layer(catalog: dict, entry: dict, level_meta: dict, level: str | None = None,
                 attribution: tuple[str, dict] | None = None,
                 category: tuple[str, str] | None = None) -> dict:
    """Patch one layer into a catalog dict in place (never rebuild the catalog).

    Idempotent: the layer keeps its place, its rebaked tiles and parquet
    (tile_keys.keep_all_rebaked) and its first `fetched_at` (the
    card's "Updated" date), so a second run with the same inputs changes
    nothing. Also sets level_meta[level], appends the level to level_order
    (the home page iterates it), and adds the attribution and the category
    (before 'other', which stays last) when given. Stops first if the layer's
    licence terms changed since they were reviewed (LICENCE_GATE)."""
    from tile_keys import keep_all_rebaked
    LICENCE_GATE(entry['id'])
    entry = licence_labelled(entry)
    prev = next((x for x in catalog.setdefault('layers', []) if x.get('id') == entry['id']), {})
    entry = {**entry, 'fetched_at': prev.get('fetched_at') or entry.get('fetched_at') or now_iso()}
    keep_all_rebaked(entry, prev)  # rebaked tiles (filter columns) stay while the data is unchanged
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


def versioned_names(paths: dict[str, Path]) -> dict[str, str]:
    """{format: <stem>.<md5[:8]>.<ext>}: the content-versioned file name each
    local file is published under (tile_keys.versioned_key)."""
    from tile_keys import versioned_key
    return {fmt: versioned_key(p.name, file_md5(p)) for fmt, p in paths.items()}


def plain_names(basename: str, exts: dict[str, str]) -> dict[str, str]:
    """{format: <basename>.<ext>}: the local file names a bake writes."""
    return {fmt: f'{basename}.{ext}' for fmt, ext in exts.items()}


def upload_versioned(s3, paths: dict[str, Path], prefix: str, put: Callable | None = None) -> dict[str, str]:
    """Upload each file to <prefix>/<its content-versioned name> (md5-skipped by
    `put`, r2_upload by default) and return the names: a changed file gets a new
    key, an unchanged one keeps its key, so a re-run uploads nothing."""
    names = versioned_names(paths)
    for fmt, path in paths.items():
        (put or r2_upload)(s3, path, f'{prefix}/{names[fmt]}')
    return names


def summary_names(summary: dict) -> dict[str, str]:
    """The content-versioned names the bake step recorded and the upload step
    used. A summary without them came from an older bake whose files went to
    fixed keys: refuse, so the catalog never names a key that was not uploaded."""
    if not summary.get('names'):
        raise ValueError('the bake summary records no published names: re-run the bake and upload steps')
    return summary['names']


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
    if feature_count < 10_000:
        return None
    return 5_000 if feature_count < 100_000 else 20_000


def rebake_flatten_bbox(src: Path, dst: Path, con=None, keep_struct: bool = False) -> tuple[int, list[str]]:
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
    `keep_struct` keeps a `bbox` STRUCT and adds the flat columns beside it
    (rebake_layer.py: a published layer keeps every column it had).

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
        # Flatten the struct into top-level cols; drop the struct unless kept.
        bbox_clause = (
            f"SELECT *{'' if keep_struct else ' EXCLUDE (bbox)'}, "
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


def _is_row_number(con, relation: str, column: str) -> bool:
    """True when `column` holds 0..n-1 or 1..n, one value per row: a reader's
    feature number, not ids the source carried."""
    n, lo, hi, distinct = con.execute(
        f'SELECT count(*), min("{column}"), max("{column}"), count(DISTINCT "{column}") FROM {relation}').fetchone()
    return n == 0 or (lo in (0, 1) and hi - lo == n - 1 and distinct == n)


def geojson_to_parquet(gj: Path, out: Path, geometry_name: str | None = None, con=None) -> int:
    """GeoJSON -> parquet with flat bbox columns in Hilbert order (what
    /api/v1/nearby needs). ST_Read names the geometry `geom`; pass
    `geometry_name` to rename it. Returns the feature count."""
    if con is None:
        import duckdb
        con = duckdb.connect()
        con.execute('INSTALL spatial; LOAD spatial;')
    read = f"ST_Read('{gj}')"
    cols = {r[0] for r in con.execute(f'DESCRIBE SELECT * FROM {read}').fetchall()}
    drop = [c for c in ('OGC_FID', 'geom' if geometry_name else None) if c in cols]
    rename = ''
    # ST_Read (DuckDB 1.5) adds OGC_FID: the row number, unless the Features
    # carry integer "id"s, which it puts there. Those are source data: keep them
    # (as `id` when no property is called that).
    if 'OGC_FID' in cols and not _is_row_number(con, read, 'OGC_FID'):
        drop.remove('OGC_FID')
        if 'id' not in cols:
            drop.append('OGC_FID')
            rename = ', OGC_FID AS id'
    select = (f'* EXCLUDE ({", ".join(drop)})' if drop else '*') + rename + \
        (f', geom AS "{geometry_name}"' if geometry_name else '')
    raw = out.with_name(f'{out.stem}.raw.parquet')
    try:
        con.execute(f"COPY (SELECT {select} FROM {read}) TO '{raw}' (FORMAT PARQUET, COMPRESSION ZSTD)")
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
