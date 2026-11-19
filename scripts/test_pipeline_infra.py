"""Shared run machinery in pipeline.py: verified resumable downloads, cached
steps, time limits, retried uploads and the host-wide upload lock.

These lived in bake_land_water.py and rebake_tiles.py (two upload locks on one
path); every bake now takes them from pipeline.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_pipeline_infra.py -q
"""
from __future__ import annotations

import hashlib
import http.server
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pipeline  # noqa: E402


# ── download: resumable, verified, atomic ────────────────────────────────────

class _RangeHandler(http.server.BaseHTTPRequestHandler):
    body = b''
    requests: list = []
    fail_after: int | None = None  # bytes sent before dropping the connection (once)
    etag: str | None = None
    head_only = False

    def do_GET(self):  # noqa: N802
        rng = self.headers.get('Range')
        type(self).requests.append(rng)
        start = int(rng.split('=')[1].split('-')[0]) if rng else 0
        if start >= len(self.body):
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{len(self.body)}')
            self.end_headers()
            return
        chunk = self.body[start:]
        self.send_response(206 if rng else 200)
        if rng:
            self.send_header('Content-Range', f'bytes {start}-{len(self.body) - 1}/{len(self.body)}')
        if self.etag:
            self.send_header('ETag', f'"{self.etag}"')
        self.send_header('Content-Length', str(len(chunk)))
        self.end_headers()
        if self.fail_after is not None:
            self.wfile.write(chunk[:self.fail_after])
            type(self).fail_after = None
            self.wfile.flush()
            self.connection.close()
            return
        self.wfile.write(chunk)

    def log_message(self, *a):
        pass


@pytest.fixture
def server():
    _RangeHandler.body = bytes(range(256)) * 4096  # 1 MiB
    _RangeHandler.requests = []
    _RangeHandler.fail_after = None
    _RangeHandler.etag = None
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), _RangeHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{srv.server_port}/f.parquet'
    srv.shutdown()


def no_wait(n):
    return None


def test_download_writes_the_whole_file_atomically(tmp_path, server):
    dest = tmp_path / 'f.parquet'
    assert pipeline.download(server, dest, tries=1) == len(_RangeHandler.body)
    assert dest.read_bytes() == _RangeHandler.body
    assert list(tmp_path.iterdir()) == [dest]


def test_download_resumes_a_part_left_by_a_killed_run(tmp_path, server):
    dest = tmp_path / 'f.parquet'
    pipeline.part_path(dest).write_bytes(_RangeHandler.body[:300_000])
    pipeline.download(server, dest, tries=1)
    assert _RangeHandler.requests == ['bytes=300000-']
    assert dest.read_bytes() == _RangeHandler.body


def test_a_truncated_response_never_counts_as_done(tmp_path, server):
    """Seen live: an R2 download stopped at 232 of 455 MB without an error.
    The server promised Content-Length bytes and closed early; the download
    resumes from where it stopped instead of keeping the short file."""
    _RangeHandler.fail_after = 100_000
    dest = tmp_path / 'f.parquet'
    pipeline.download(server, dest, tries=3, wait=no_wait)
    assert dest.read_bytes() == _RangeHandler.body
    assert _RangeHandler.requests == [None, 'bytes=100000-']


def test_a_truncated_response_with_no_retries_left_fails_and_keeps_the_part(tmp_path, server):
    _RangeHandler.fail_after = 100_000
    dest = tmp_path / 'f.parquet'
    with pytest.raises(OSError, match='100,000 of 1,048,576'):
        pipeline.download(server, dest, tries=1)
    assert not dest.exists()
    assert pipeline.part_path(dest).stat().st_size == 100_000  # the next run resumes from here


@pytest.fixture
def r2_like(monkeypatch):
    """Treat the local test server like R2: its single-part ETag is an MD5."""
    monkeypatch.setattr(pipeline, 'MD5_ETAG_HOSTS', (*pipeline.MD5_ETAG_HOSTS, '127.0.0.1'))


def test_download_checks_the_md5_etag_r2_sends(tmp_path, server, r2_like):
    _RangeHandler.etag = hashlib.md5(_RangeHandler.body).hexdigest()
    dest = tmp_path / 'f.parquet'
    pipeline.download(server, dest, tries=1)
    assert dest.read_bytes() == _RangeHandler.body


def test_a_checksum_mismatch_fails_and_leaves_nothing(tmp_path, server, r2_like):
    _RangeHandler.etag = '0' * 32
    dest = tmp_path / 'f.parquet'
    with pytest.raises(OSError, match='md5'):
        pipeline.download(server, dest, tries=1)
    assert list(tmp_path.iterdir()) == []


def test_a_multipart_etag_is_not_an_md5_and_is_not_checked(tmp_path, server, r2_like):
    _RangeHandler.etag = '0' * 32 + '-3'
    dest = tmp_path / 'f.parquet'
    pipeline.download(server, dest, tries=1)
    assert dest.read_bytes() == _RangeHandler.body


def test_an_expected_md5_from_the_caller_is_checked(tmp_path, server):
    dest = tmp_path / 'f.parquet'
    with pytest.raises(OSError, match='md5'):
        pipeline.download(server, dest, tries=1, md5='f' * 32)
    pipeline.download(server, dest, tries=1, md5=hashlib.md5(_RangeHandler.body).hexdigest())
    assert dest.exists()


def test_an_etag_from_another_host_is_opaque(tmp_path, server):
    _RangeHandler.etag = '0' * 32  # looks like an MD5, but this host is not S3/R2
    dest = tmp_path / 'f.parquet'
    pipeline.download(server, dest, tries=1)
    assert dest.read_bytes() == _RangeHandler.body


def test_download_skips_a_finished_file(tmp_path, server):
    dest = tmp_path / 'f.parquet'
    dest.write_bytes(b'done')
    pipeline.download(server, dest, tries=1)
    assert _RangeHandler.requests == []


def test_download_accepts_a_part_that_already_holds_every_byte(tmp_path, server):
    dest = tmp_path / 'f.parquet'
    pipeline.part_path(dest).write_bytes(_RangeHandler.body)
    pipeline.download(server, dest, tries=1)
    assert dest.read_bytes() == _RangeHandler.body


# ── work folders: durable, not /tmp ──────────────────────────────────────────

def test_work_dirs_live_under_data_work_not_tmp(tmp_path, monkeypatch):
    # macOS clears /tmp on reboot, losing hours of cached downloads and bakes.
    assert pipeline.WORK_ROOT == pipeline.ROOT / 'data' / 'work'  # gitignored (data/)
    monkeypatch.setattr(pipeline, 'WORK_ROOT', tmp_path / 'work')
    monkeypatch.delenv('X_WORK', raising=False)
    assert pipeline.work_dir('x', 'X_WORK') == tmp_path / 'work' / 'x'
    assert not (tmp_path / 'work').exists()  # nothing made until a run writes there


def test_a_work_dir_env_override_wins(tmp_path, monkeypatch):
    monkeypatch.setenv('X_WORK', str(tmp_path / 'disk'))
    assert pipeline.work_dir('x', 'X_WORK') == tmp_path / 'disk'


def test_a_run_cached_in_the_old_tmp_folder_resumes_there(tmp_path, monkeypatch):
    # A run in progress keeps its cache: the old /tmp folder is used until the new one exists.
    monkeypatch.setattr(pipeline, 'WORK_ROOT', tmp_path / 'work')
    old = tmp_path / 'tmp-x'
    assert pipeline.work_dir('x', legacy=old) == tmp_path / 'work' / 'x'
    old.mkdir()
    assert pipeline.work_dir('x', legacy=old) == old
    (tmp_path / 'work' / 'x').mkdir(parents=True)
    assert pipeline.work_dir('x', legacy=old) == tmp_path / 'work' / 'x'


def test_the_tile_scripts_share_one_tiles_work_folder():
    import audit_tiles
    import rebake_tiles
    import tile_filter_gaps
    assert rebake_tiles.WORK == pipeline.TILES_WORK
    assert audit_tiles.CACHE == pipeline.TILES_WORK / 'audit'
    assert tile_filter_gaps.WORK == pipeline.TILES_WORK / 'filter-gaps'


# ── cached steps + time limit ────────────────────────────────────────────────

def test_cached_step_runs_once_and_writes_atomically(tmp_path):
    out = tmp_path / 'x.parquet'
    calls = []

    def build(part: Path):
        calls.append(part)
        assert part != out and part.suffix == '.parquet'  # real extension last
        part.write_text('ok')

    assert pipeline.cached(out, build) == out
    assert pipeline.cached(out, build) == out
    assert len(calls) == 1 and out.read_text() == 'ok'


def test_cached_step_leaves_nothing_behind_on_failure(tmp_path):
    out = tmp_path / 'x.geojson'

    def boom(part: Path):
        part.write_text('half')
        raise RuntimeError('killed')

    with pytest.raises(RuntimeError):
        pipeline.cached(out, boom)
    assert not out.exists() and not list(tmp_path.iterdir())


def test_deadline_stops_cleanly_between_steps():
    clock = iter([0.0, 10.0, 100.0])
    d = pipeline.Deadline(minutes=1, clock=lambda: next(clock))
    d.check('download')  # 10 s in
    with pytest.raises(pipeline.OutOfTime):
        d.check('bake')  # 100 s in, over the 60 s limit


def test_deadline_left_counts_down():
    clock = iter([0.0, 30.0])
    assert pipeline.Deadline(minutes=1, clock=lambda: next(clock)).left() == 30.0


# ── uploads ──────────────────────────────────────────────────────────────────

def test_upload_retries_a_dropped_connection(tmp_path, monkeypatch):
    from botocore.exceptions import SSLError
    calls = []

    def flaky(s3, local, key, state_dir):
        calls.append((key, state_dir))
        if len(calls) == 1:
            raise SSLError(endpoint_url='https://r2', error='EOF occurred in violation of protocol')
    monkeypatch.setattr(pipeline, 'r2_upload_resumable', flaky)
    pipeline.r2_upload_retrying(None, tmp_path / 'a.parquet', 'k', retries=2, backoff=0)
    assert [k for k, _ in calls] == ['k', 'k']
    assert calls[0][1] == pipeline.UPLOAD_STATE  # a durable folder, not /tmp


def test_upload_lock_waits_for_another_job_and_is_released_on_failure(tmp_path):
    lock = tmp_path / 'upload.lock'
    lock.mkdir()  # another job holds it (no owner file yet: it is still writing it)
    threading.Timer(0.2, lock.rmdir).start()
    with pytest.raises(RuntimeError):
        with pipeline.upload_lock(lock, 'me', wait_s=0.05):
            assert lock.is_dir()
            assert (lock / 'owner').read_text() == f'{os.getpid()} me\n'
            raise RuntimeError('upload failed')
    assert not lock.exists()


def test_a_lock_left_by_a_killed_job_is_taken_over(tmp_path):
    """kill -9 left the lock behind; its owner's pid is gone, so the next job
    takes it instead of waiting forever."""
    dead = subprocess.run([sys.executable, '-c', 'import os; print(os.getpid())'],
                          capture_output=True, text=True, check=True).stdout.strip()
    lock = tmp_path / 'upload.lock'
    lock.mkdir()
    (lock / 'owner').write_text(f'{dead} bake_x\n')
    with pipeline.upload_lock(lock, 'me', wait_s=60):  # would hang if it waited
        assert (lock / 'owner').read_text().startswith(f'{os.getpid()} ')
    assert not lock.exists()


def test_a_lock_held_by_a_live_job_is_respected(tmp_path):
    lock = tmp_path / 'upload.lock'
    lock.mkdir()
    (lock / 'owner').write_text(f'{os.getppid()} other\n')  # alive: our parent
    waited = []
    threading.Timer(0.2, lambda: (lock / 'owner').unlink() or lock.rmdir()).start()
    with pipeline.upload_lock(lock, 'me', wait_s=0.05, on_wait=waited.append):
        pass
    assert waited and 'other' in waited[0]


def test_a_lock_with_no_owner_for_a_minute_is_taken_over(tmp_path):
    # A job killed between mkdir and writing its owner file left an empty lock
    # that every later job waited on forever.
    lock = tmp_path / 'upload.lock'
    lock.mkdir()
    old = lock.stat().st_mtime - 120
    os.utime(lock, (old, old))
    with pipeline.upload_lock(lock, 'me', wait_s=60):  # would hang if it waited
        assert (lock / 'owner').read_text().startswith(f'{os.getpid()} ')
    assert not lock.exists()


def test_the_upload_lock_is_reentrant_within_a_process(tmp_path):
    # Uploads take the lock themselves; a caller already holding it must not deadlock.
    lock = tmp_path / 'upload.lock'
    with pipeline.upload_lock(lock, 'outer', wait_s=60):
        with pipeline.upload_lock(lock, 'inner', wait_s=60):
            assert (lock / 'owner').read_text() == f'{os.getpid()} outer\n'
        assert lock.is_dir()  # still held by the outer block
    assert not lock.exists()


def test_a_lock_naming_this_process_that_it_does_not_hold_is_taken_over(tmp_path):
    lock = tmp_path / 'upload.lock'
    lock.mkdir()
    (lock / 'owner').write_text(f'{os.getpid()} leaked\n')
    with pipeline.upload_lock(lock, 'me', wait_s=60):
        assert (lock / 'owner').read_text() == f'{os.getpid()} me\n'
    assert not lock.exists()


# ── external tools: always a timeout, stderr in the error ────────────────────

def test_run_returns_the_output():
    assert pipeline.run([sys.executable, '-c', 'print("ok")'], timeout=30, text=True).stdout == 'ok\n'


def test_a_failed_tool_says_why():
    with pytest.raises(subprocess.CalledProcessError) as e:
        pipeline.run([sys.executable, '-c', 'import sys; sys.exit("tippecanoe: bad -y field")'], timeout=30)
    assert 'bad -y field' in str(e.value)


def test_a_hung_tool_is_stopped():
    with pytest.raises(subprocess.TimeoutExpired):
        pipeline.run([sys.executable, '-c', 'import time; time.sleep(30)'], timeout=0.5)


def test_no_script_runs_a_tool_without_a_timeout():
    """Every subprocess.run / check_output / Popen in the pipeline names a
    timeout, or goes through pipeline.run (which requires one)."""
    import ast
    missing = []
    for path in sorted(HERE.glob('*.py')):
        if path.name.startswith('test_'):
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name) and node.func.value.id == 'subprocess'
                    and node.func.attr in ('run', 'check_call', 'check_output', 'call')
                    and not any(k.arg == 'timeout' for k in node.keywords)):
                missing.append(f'{path.name}:{node.lineno}')
    assert missing == []


# ── data.gov.in ──────────────────────────────────────────────────────────────

def test_datagov_get_sends_the_key_and_params_and_gives_up_on_a_4xx(monkeypatch):
    import io
    import json
    import urllib.error
    import urllib.request
    seen = []

    def urlopen(req, timeout):
        seen.append(req.full_url)
        if len(seen) == 1:
            raise urllib.error.URLError('reset')  # retried
        return io.BytesIO(json.dumps({'total': 1, 'records': [{'a': 1}]}).encode())
    monkeypatch.setattr(urllib.request, 'urlopen', urlopen)
    got = pipeline.datagov_get('abc-123', 'KEY', offset=10, limit=5, wait=no_wait)
    assert got['records'] == [{'a': 1}] and len(seen) == 2
    assert seen[0].startswith('https://api.data.gov.in/resource/abc-123?api-key=KEY&format=json&offset=10&limit=5')

    def forbidden(req, timeout):
        seen.append(req.full_url)
        raise urllib.error.HTTPError(req.full_url, 403, 'Forbidden', {}, None)
    monkeypatch.setattr(urllib.request, 'urlopen', forbidden)
    seen.clear()
    with pytest.raises(urllib.error.HTTPError):
        pipeline.datagov_get('abc-123', 'KEY', wait=no_wait)
    assert len(seen) == 1


def test_datagov_api_key_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv('OGD_API_KEY', 'k1')
    assert pipeline.datagov_api_key() == 'k1'


def test_make_con_keeps_lon_lat_and_takes_spill_settings(tmp_path):
    con = pipeline.make_con(temp_dir=tmp_path / 'spill', memory_limit='1GB', ordered=False)
    assert con.execute("SELECT current_setting('geometry_always_xy')").fetchone()[0] is True
    assert con.execute("SELECT current_setting('temp_directory')").fetchone()[0].endswith('spill')
    assert con.execute("SELECT current_setting('preserve_insertion_order')").fetchone()[0] is False


def test_no_script_hand_rolls_a_spatial_connection():
    """pipeline.make_con is the one place that loads spatial and sets lon,lat order."""
    offenders = [p.name for p in HERE.glob('*.py') if not p.name.startswith('test_') and p.name != 'pipeline.py'
                 and "INSTALL spatial; LOAD spatial" in p.read_text() and 'geometry_always_xy' in p.read_text()]
    assert offenders == []
