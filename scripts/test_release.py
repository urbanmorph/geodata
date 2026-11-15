"""Tests for scripts/release.py (no network).

A release is a dataset's files under a code that never changes or gets reused: bharatlas-<dataset>-<year>.<month>.
The manifest, CHANGES.md and SHA256SUMS are committed under web/public/releases/<code>/; the data files are staged
in data/baked/releases/<code>/ for R2 and served at /releases/<code>/<file>.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_release.py -q
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release as rel  # noqa: E402


def staging(tmp_path: Path, name='cw', files=None, rows=2) -> Path:
    d = tmp_path / 'staging' / name
    d.mkdir(parents=True, exist_ok=True)
    files = files or {'cw_states.csv': 'lgd_code,census2011_code\n1,01\n2,02\n'}
    for f, text in files.items():
        (d / f).write_text(text)
    meta = {'dataset': name, 'title': 'Census 2011 <-> LGD crosswalk', 'description': 'd',
            'licence': 'each file keeps its source layer\'s licence',
            'sources': [{'name': 'Local Government Directory (LGD)', 'url': 'https://lgdirectory.gov.in/',
                         'version': 'admin/states', 'fetched': '2026-05-19'}],
            'files': {f: {'licence': 'CC0-1.0', 'rows': rows, 'source_layer': 'lgd_states'} for f in files}}
    (d / 'release-meta.json').write_text(json.dumps(meta))
    return d


def roots(tmp_path):
    return {'meta_root': tmp_path / 'web' / 'public' / 'releases', 'files_root': tmp_path / 'baked' / 'releases'}


def test_the_code_is_app_dataset_year_and_two_digit_month():
    assert rel.release_code('cw', '2026-11-15') == 'bharatlas-cw-2026.11'
    assert rel.release_code('catalog', '2027-01-02') == 'bharatlas-catalog-2027.01'
    with pytest.raises(ValueError):
        rel.release_code('bad name', '2026-11-15')


def test_cutting_a_release_writes_manifest_sums_changes_and_stages_the_files(tmp_path):
    code, made = rel.make_release(staging(tmp_path), '2026-11-15', **roots(tmp_path))
    assert (code, made) == ('bharatlas-cw-2026.11', True)
    meta_dir = tmp_path / 'web' / 'public' / 'releases' / code
    m = json.loads((meta_dir / 'manifest.json').read_text())
    data = (tmp_path / 'baked' / 'releases' / code / 'cw_states.csv').read_bytes()
    file_sha = hashlib.sha256(data).hexdigest()
    sums = (meta_dir / 'SHA256SUMS').read_text()
    assert sums == f'{file_sha}  cw_states.csv\n'
    assert m['sha256'] == hashlib.sha256(sums.encode()).hexdigest()   # the release digest is the digest of SHA256SUMS
    assert m['pin'] == f'{code}+sha256:{m["sha256"]}'
    assert m['files'] == [{'name': 'cw_states.csv', 'sha256': file_sha, 'bytes': len(data), 'rows': 2,
                           'licence': 'CC0-1.0', 'source_layer': 'lgd_states',
                           'url': f'https://bharatlas.com/releases/{code}/cw_states.csv'}]
    assert m['attribution']['sources'][0]['name'].startswith('Local Government Directory')   # the source first
    assert m['attribution']['compiled_by'].startswith('bharatlas')
    assert m['url'] == f'https://bharatlas.com/releases/{code}/'
    assert m['w3id_proposed'] == 'https://w3id.org/bharatlas/cw/2026.11'
    assert m['previous'] is None and m['released'] == '2026-11-15'
    assert m['citation'].index('Local Government Directory') < m['citation'].index('bharatlas')
    changes = (meta_dir / 'CHANGES.md').read_text()
    assert changes.startswith(f'# {code}\n') and 'first release' in changes and m['sha256'] in changes
    assert '- cw_states.csv: 2 rows' in changes
    assert not (meta_dir / 'cw_states.csv').exists()                    # data files are not committed


def test_a_second_run_with_the_same_files_changes_nothing(tmp_path):
    src = staging(tmp_path)
    rel.make_release(src, '2026-11-15', **roots(tmp_path))
    meta = tmp_path / 'web' / 'public' / 'releases' / 'bharatlas-cw-2026.11'
    before = {p.name: p.read_bytes() for p in meta.iterdir()}
    stamp = {p.name: p.stat().st_mtime_ns for p in meta.iterdir()}
    assert rel.make_release(src, '2026-11-28', **roots(tmp_path)) == ('bharatlas-cw-2026.11', False)
    assert {p.name: p.read_bytes() for p in meta.iterdir()} == before
    assert {p.name: p.stat().st_mtime_ns for p in meta.iterdir()} == stamp


def test_a_lost_staged_file_is_restored_from_the_same_bytes(tmp_path):
    src = staging(tmp_path)
    code, _ = rel.make_release(src, '2026-11-15', **roots(tmp_path))
    staged = tmp_path / 'baked' / 'releases' / code / 'cw_states.csv'
    staged.unlink()
    assert rel.make_release(src, '2026-11-15', **roots(tmp_path)) == (code, False)
    assert staged.exists()


def test_different_files_under_an_existing_code_are_refused(tmp_path):
    rel.make_release(staging(tmp_path), '2026-11-15', **roots(tmp_path))
    changed = staging(tmp_path, files={'cw_states.csv': 'lgd_code,census2011_code\n1,01\n'})
    with pytest.raises(rel.ReleaseChanged, match='bharatlas-cw-2026.11'):
        rel.make_release(changed, '2026-11-20', **roots(tmp_path))


def test_the_next_release_names_the_previous_one_and_says_what_changed(tmp_path):
    rel.make_release(staging(tmp_path), '2026-11-15', **roots(tmp_path))
    newer = staging(tmp_path, files={'cw_states.csv': 'a\n1\n2\n3\n'}, rows=3)
    code, _ = rel.make_release(newer, '2026-12-01', **roots(tmp_path))
    m = json.loads((tmp_path / 'web' / 'public' / 'releases' / code / 'manifest.json').read_text())
    assert m['previous'] == 'bharatlas-cw-2026.11'
    changes = (tmp_path / 'web' / 'public' / 'releases' / code / 'CHANGES.md').read_text()
    assert 'cw_states.csv: 2 rows to 3' in changes


def test_the_index_lists_every_release_newest_first_with_the_latest_per_dataset(tmp_path):
    r = roots(tmp_path)
    rel.make_release(staging(tmp_path), '2026-11-15', **r)
    rel.make_release(staging(tmp_path, 'catalog', files={'catalog-record.json': '{}'}), '2026-11-15', **r)
    rel.make_release(staging(tmp_path, files={'cw_states.csv': 'x\n'}), '2026-12-01', **r)
    assert rel.write_index(r['meta_root']) is True
    idx = json.loads((r['meta_root'] / 'index.json').read_text())
    assert [x['code'] for x in idx['releases']] == [
        'bharatlas-cw-2026.12', 'bharatlas-cw-2026.11', 'bharatlas-catalog-2026.11']
    assert idx['latest'] == {'catalog': 'bharatlas-catalog-2026.11', 'cw': 'bharatlas-cw-2026.12'}
    first = idx['releases'][0]
    assert first['manifest'] == 'https://bharatlas.com/releases/bharatlas-cw-2026.12/manifest.json'
    assert first['pin'].startswith('bharatlas-cw-2026.12+sha256:')
    assert first['files'][0]['url'].endswith('/bharatlas-cw-2026.12/cw_states.csv')
    assert rel.write_index(r['meta_root']) is False                     # unchanged: not rewritten


def test_upload_commands_name_each_staged_file_once(tmp_path):
    r = roots(tmp_path)
    code, _ = rel.make_release(staging(tmp_path), '2026-11-15', **r)
    cmds = rel.upload_commands(code, r['files_root'])
    assert cmds == [(f'npx wrangler r2 object put geodata-data/releases/{code}/cw_states.csv '
                     f'--file data/baked/releases/{code}/cw_states.csv --content-type "text/csv; charset=utf-8" '
                     f'--remote')]
