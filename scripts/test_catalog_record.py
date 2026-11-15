"""Tests for scripts/catalog_record.py (no network).

The dated catalogue record lists, per layer as served today: the source, the source's own version, the fetch
date, the served file's SHA-256, the licence and the source link.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_catalog_record.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog_record as cr  # noqa: E402

R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'


def layer(**kw):
    base = {
        'id': 'lgd_districts', 'source': 'LGD', 'rows': 785, 'licence': 'CC0-1.0 / CC-BY-4.0',
        'fetched_at': '2026-05-19T07:56:49+00:00',
        'attribution': {'primary': {'name': 'Local Government Directory', 'url': 'https://lgdirectory.gov.in/'},
                        'publisher': {'name': 'yashveeeeeeer/india-geodata',
                                      'url': 'https://github.com/yashveeeeeeer/india-geodata'}},
        'parquet': {'url': f'{R2}/admin/districts/LGD_Districts.parquet', 'bytes': 22178335,
                    'upstream_url': 'https://github.com/yashveeeeeeer/india-geodata/releases/download/'
                                    'admin/districts/LGD_Districts.parquet'},
        'geojson': {'url': f'{R2}/admin/districts/LGD_Districts.geojson', 'bytes': 93092856},
    }
    base.update(kw)
    return base


def test_a_github_release_download_splits_into_repo_tag_and_asset_even_when_the_tag_has_a_slash():
    url = 'https://github.com/yashveeeeeeer/india-geodata/releases/download/admin/districts/LGD_Districts.parquet'
    assert cr.github_asset(url) == ('yashveeeeeeer/india-geodata', 'admin/districts', 'LGD_Districts.parquet')


def test_a_commit_pinned_github_raw_link_is_its_own_version_and_other_links_have_none():
    assert cr.github_asset('https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/x.geojson') is None
    assert cr.pinned_commit('https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/x.geojson') == '9469f09'
    assert cr.pinned_commit('https://drive.google.com/file/d/abc/view') is None
    assert cr.github_asset('https://drive.google.com/file/d/abc/view') is None
    assert cr.github_asset(None) is None


def test_the_served_file_is_the_parquet_and_falls_back_to_geojson_when_a_layer_has_none():
    assert cr.served_file(layer()) == ('parquet', f'{R2}/admin/districts/LGD_Districts.parquet')
    assert cr.served_file(layer(parquet=None)) == ('geojson', f'{R2}/admin/districts/LGD_Districts.geojson')
    assert cr.served_file(layer(parquet=None, geojson=None)) == (None, None)


def test_the_source_version_of_a_github_release_asset_is_its_tag_date_and_digest():
    asset = {'name': 'LGD_Districts.parquet', 'size': 22178335, 'updated_at': '2026-03-08T04:56:26Z',
             'digest': 'sha256:c205'}
    release = {'tag_name': 'admin/districts', 'published_at': '2026-03-08T04:56:31Z', 'assets': [asset]}
    v = cr.source_version(layer(), lambda repo, tag: release if (repo, tag) == (
        'yashveeeeeeer/india-geodata', 'admin/districts') else None)
    assert v == {'kind': 'github-release', 'repo': 'yashveeeeeeer/india-geodata', 'tag': 'admin/districts',
                 'asset': 'LGD_Districts.parquet', 'asset_updated_at': '2026-03-08T04:56:26Z',
                 'asset_sha256': 'c205', 'asset_bytes': 22178335}


def test_a_layer_whose_source_publishes_no_version_says_so_and_keeps_the_fetch_date_as_the_marker():
    drive = layer(parquet={'url': f'{R2}/x.parquet', 'upstream_url': 'https://drive.google.com/file/d/abc/view'})
    v = cr.source_version(drive, lambda repo, tag: None)
    assert v == {'kind': 'unversioned', 'note': 'the source publishes no version; fetched_at dates the copy'}
    pinned = layer(parquet=None, geojson={'url': f'{R2}/g.geojson',
                                          'upstream_url': 'https://github.com/o/r/raw/9469f09/a.geojson'})
    assert cr.source_version(pinned, lambda *a: None) == {'kind': 'git-commit', 'commit': '9469f09'}


def test_the_record_row_credits_the_source_first_and_pins_the_served_bytes():
    row = cr.record_row(layer(), {'sha256': 'ab' * 32, 'bytes': 22178335, 'etag': '"e"',
                                  'last_modified': 'Wed, 20 May 2026 07:24:05 GMT'},
                        {'kind': 'github-release', 'asset_sha256': 'ab' * 32})
    tagged = cr.record_row(layer(), {'sha256': 'cd' * 32, 'bytes': 1},
                           {'kind': 'github-release', 'repo': 'o/r', 'tag': 'admin/districts',
                            'asset_updated_at': '2026-03-08T04:56:26Z', 'asset_sha256': 'ab' * 32})
    assert tagged['source_version'] == 'o/r release admin/districts'
    assert tagged['source_version_date'] == '2026-03-08T04:56:26Z'
    assert tagged['served_bytes_match_source_digest'] is False
    assert list(row)[:3] == ['id', 'source', 'source_url']
    assert row['source'] == 'Local Government Directory'
    assert row['publisher'] == 'yashveeeeeeer/india-geodata'
    assert row['source_link'].startswith('https://github.com/yashveeeeeeer/india-geodata/releases/download/')
    assert row['served_format'] == 'parquet'
    assert row['sha256'] == 'ab' * 32
    assert row['source_version'] is None and row['source_sha256'] == 'ab' * 32
    assert row['served_bytes_match_source_digest'] is True
    assert row['licence'] == 'CC0-1.0 / CC-BY-4.0'
    assert row['fetched_at'] == '2026-05-19T07:56:49+00:00'


def test_served_unchanged_is_unknown_when_the_source_gives_no_digest():
    row = cr.record_row(layer(), {'sha256': 'ab' * 32, 'bytes': 1, 'etag': None, 'last_modified': None},
                        {'kind': 'unversioned'})
    assert row['served_bytes_match_source_digest'] is None
    assert row['source_version'] is None
    commit = cr.record_row(layer(), {'sha256': 'ab' * 32, 'bytes': 1}, {'kind': 'git-commit', 'commit': '9469f09'})
    assert commit['source_version'] == 'commit 9469f09'


def test_the_checksum_cache_keeps_each_answer_and_is_only_reused_for_the_same_etag_and_size(tmp_path):
    cache = cr.ChecksumCache(tmp_path / 'sums.jsonl')
    assert cache.get('u', '"e1"', 10) is None
    cache.put('u', {'sha256': 'aa', 'bytes': 10, 'etag': '"e1"', 'last_modified': 'x'})
    again = cr.ChecksumCache(tmp_path / 'sums.jsonl')                 # a new run reads what the last one kept
    assert again.get('u', '"e1"', 10)['sha256'] == 'aa'
    assert again.get('u', '"e2"', 10) is None                         # the file changed on R2
    assert again.get('u', '"e1"', 11) is None
    lines = (tmp_path / 'sums.jsonl').read_text().splitlines()
    assert json.loads(lines[0])['url'] == 'u'


def test_write_record_is_idempotent_and_sorted_by_layer(tmp_path):
    rows = [{'id': 'b', 'sha256': '1'}, {'id': 'a', 'sha256': '2'}]
    assert cr.write_record(tmp_path, rows, '2026-11-15') is True
    first = (tmp_path / 'catalog-record.json').read_bytes()
    assert json.loads(first)['layers'][0]['id'] == 'a'
    assert cr.write_record(tmp_path, list(reversed(rows)), '2026-11-15') is False
    assert (tmp_path / 'catalog-record.json').read_bytes() == first
    assert (tmp_path / 'catalog-record.csv').read_text().splitlines()[0].startswith('id,')


def test_the_record_itself_is_cc_by_so_bharatlas_is_credited_and_each_layer_keeps_its_own_licence():
    meta = cr.release_meta('2026-11-15', '2026-11-15T00:00:00Z', 148)
    assert meta['licence'].startswith('CC-BY-4.0 ')
    assert 'each layer it describes keeps its source' in meta['licence']
    assert {f['licence'] for f in meta['files'].values()} == {'CC-BY-4.0'}
