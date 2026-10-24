"""Tests for scripts/moderate_submission.py.

A submission is accepted only when it is complete: its file is in R2 at the
recorded size and its admin token exists. The June 2026 orphan (no admin
token) was accepted because `accept` only flipped the status; the Oct 2026
orphan had no file at all.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_moderate_submission.py -q
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import moderate_submission as m  # noqa: E402

@pytest.fixture(autouse=True)
def fresh_wrangler_probe():
    m.wrangler_bin.cache_clear()  # cached per process; tests swap subprocess.run
    yield
    m.wrangler_bin.cache_clear()


ROW = {'id': 'abc', 'name': 'Wards', 'status': 'pending', 'bytes': 1000, 'r2_key': 'community/abc/w.geojson'}


# ── integrity rules ───────────────────────────────────────────────────────

def test_complete_submission_has_no_problems():
    assert m.integrity_problems(ROW, stored_size=1000, admin_tokens=1) == []


def test_missing_file_is_a_problem():
    assert m.integrity_problems(ROW, stored_size=None, admin_tokens=1) == [
        'file missing in R2 (community/abc/w.geojson)']


def test_wrong_size_is_a_problem():
    assert m.integrity_problems(ROW, stored_size=999, admin_tokens=1) == [
        'file in R2 is 999 bytes, expected 1000']


def test_missing_admin_token_is_a_problem():
    assert m.integrity_problems(ROW, stored_size=1000, admin_tokens=0) == [
        'no admin token, so the owner cannot manage it']


# ── accept / reject ───────────────────────────────────────────────────────

@pytest.fixture
def fake_d1(monkeypatch):
    calls: list[str] = []

    def d1(sql: str):
        calls.append(sql)
        if sql.startswith('SELECT') and 'FROM submissions' in sql:
            return [dict(ROW)]
        if 'FROM submission_tokens' in sql:
            return [{'submission_id': 'abc', 'n': fake_d1.tokens}]
        return []
    fake_d1.tokens = 1
    monkeypatch.setattr(m, 'd1', d1)
    return calls


def test_accept_refuses_an_incomplete_submission_and_changes_nothing(fake_d1, monkeypatch):
    monkeypatch.setattr(m, 'r2_size', lambda key: None)
    with pytest.raises(SystemExit, match='file missing in R2'):
        m.set_status('abc', 'accepted')
    assert not any(sql.startswith('UPDATE') for sql in fake_d1)


def test_accept_goes_ahead_when_complete(fake_d1, monkeypatch):
    monkeypatch.setattr(m, 'r2_size', lambda key: 1000)
    m.set_status('abc', 'accepted')
    assert any(sql.startswith("UPDATE submissions SET status='accepted'") for sql in fake_d1)


def test_reject_records_the_reason(fake_d1):
    m.set_status('abc', 'rejected', reason="upload failed; file was not stored (contributor's error)")
    update = next(sql for sql in fake_d1 if sql.startswith('UPDATE'))
    assert "rejection_reason='upload failed; file was not stored (contributor''s error)'" in update


# ── wrangler lookup ───────────────────────────────────────────────────────

def test_wrangler_used_only_when_it_actually_runs(monkeypatch):
    def run(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 0, stdout='4.1.0', stderr='')
    monkeypatch.setattr(m.subprocess, 'run', run)
    assert m.wrangler_bin() == ['wrangler']


def test_broken_wrangler_shim_falls_back_to_npx(monkeypatch):
    def run(cmd, **kw):  # mise: "wrangler is not a valid shim" exits non-zero
        return subprocess.CompletedProcess(cmd, 1, stdout='', stderr='mise ERROR wrangler is not a valid shim')
    monkeypatch.setattr(m.subprocess, 'run', run)
    assert m.wrangler_bin() == ['npx', '--yes', 'wrangler@4']


def test_missing_wrangler_falls_back_to_npx(monkeypatch):
    def run(cmd, **kw):
        raise FileNotFoundError(cmd[0])
    monkeypatch.setattr(m.subprocess, 'run', run)
    assert m.wrangler_bin() == ['npx', '--yes', 'wrangler@4']


# ── no needless work ──────────────────────────────────────────────────────

def test_wrangler_probe_runs_once_per_process(monkeypatch):
    calls = []
    def run(cmd, **kw):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout='4.1.0', stderr='')
    m.wrangler_bin.cache_clear()
    monkeypatch.setattr(m.subprocess, 'run', run)
    m.wrangler_bin(); m.wrangler_bin(); m.wrangler_bin()
    assert len(calls) == 1
    m.wrangler_bin.cache_clear()


def test_check_counts_admin_tokens_in_one_query(monkeypatch, capsys):
    queries = []
    rows = [dict(ROW, id=f's{i}', r2_key=f'community/s{i}/f.geojson') for i in range(5)]
    def d1(sql):
        queries.append(sql)
        if 'FROM submission_tokens' in sql:
            return [{'submission_id': 's0', 'n': 1}, {'submission_id': 's1', 'n': 1}]
        return rows
    monkeypatch.setattr(m, 'd1', d1)
    monkeypatch.setattr(m, 'r2_size', lambda key: 1000)
    m.check_all()
    assert sum('submission_tokens' in q for q in queries) == 1
    assert '5 submissions checked, 3 incomplete.' in capsys.readouterr().out
