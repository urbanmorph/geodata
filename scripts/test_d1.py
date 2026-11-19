"""The one wrangler D1 helper (scripts/d1.py) used by moderate_submission.py,
bake_community.py, build_catalog.py and mint_collect_api_key.py.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_d1.py -q
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import d1  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_probe():
    d1.wrangler_bin.cache_clear()
    yield
    d1.wrangler_bin.cache_clear()


def fake_run(answers, calls):
    def run(cmd, **kw):
        calls.append((cmd, kw))
        if cmd[-1] == '--version':
            raise FileNotFoundError('wrangler')
        out = answers.pop(0)
        if isinstance(out, Exception):
            raise out
        return out
    return run


def test_query_pins_wrangler_4_and_returns_the_rows(monkeypatch):
    calls = []
    ok = subprocess.CompletedProcess([], 0, stdout=json.dumps([{'results': [{'id': 'a'}]}]), stderr='')
    monkeypatch.setattr(d1.subprocess, 'run', fake_run([ok], calls))
    assert d1.query("SELECT 1", 'remote') == [{'id': 'a'}]
    cmd, kw = calls[-1]
    assert cmd[:3] == ['npx', '--yes', 'wrangler@4']
    assert cmd[3:] == ['d1', 'execute', 'geodata-submissions', '--remote', '--json', '--command', 'SELECT 1']
    assert kw['timeout'] > 0


def test_query_retries_once_without_an_r2_scoped_token(monkeypatch):
    monkeypatch.setenv('CLOUDFLARE_API_TOKEN', 'r2-only')
    calls = []
    bad = subprocess.CompletedProcess([], 1, stdout='', stderr='Authentication error [code: 10000]')
    ok = subprocess.CompletedProcess([], 0, stdout='[{"results": []}]', stderr='')
    monkeypatch.setattr(d1.subprocess, 'run', fake_run([bad, ok], calls))
    assert d1.query('SELECT 1', 'remote') == []
    assert 'CLOUDFLARE_API_TOKEN' not in calls[-1][1]['env']


def test_a_failure_raises_with_wranglers_message(monkeypatch):
    monkeypatch.delenv('CLOUDFLARE_API_TOKEN', raising=False)
    bad = subprocess.CompletedProcess([], 1, stdout='', stderr='no such table: submissions')
    monkeypatch.setattr(d1.subprocess, 'run', fake_run([bad], []))
    with pytest.raises(d1.D1Error, match='no such table'):
        d1.query('SELECT 1', 'local')


def test_a_hung_wrangler_times_out(monkeypatch):
    monkeypatch.delenv('CLOUDFLARE_API_TOKEN', raising=False)
    monkeypatch.setattr(d1.subprocess, 'run', fake_run([subprocess.TimeoutExpired('wrangler', 5)], []))
    with pytest.raises(d1.D1Error, match='timed out'):
        d1.query('SELECT 1', 'remote', timeout=5)


def test_esc_doubles_single_quotes():
    assert d1.esc("it's") == "it''s"
