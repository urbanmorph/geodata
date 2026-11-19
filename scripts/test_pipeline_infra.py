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


def test_download_checks_the_md5_etag_r2_sends(tmp_path, server):
    _RangeHandler.etag = hashlib.md5(_RangeHandler.body).hexdigest()
    dest = tmp_path / 'f.parquet'
    pipeline.download(server, dest, tries=1)
    assert dest.read_bytes() == _RangeHandler.body


def test_a_checksum_mismatch_fails_and_leaves_nothing(tmp_path, server):
    _RangeHandler.etag = '0' * 32
    dest = tmp_path / 'f.parquet'
    with pytest.raises(OSError, match='md5'):
        pipeline.download(server, dest, tries=1)
    assert list(tmp_path.iterdir()) == []


def test_a_multipart_etag_is_not_an_md5_and_is_not_checked(tmp_path, server):
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
