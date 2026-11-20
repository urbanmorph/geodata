"""Tests for scripts/check_updates.py (no network: every request goes to a fake client).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_check_updates.py -q
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_updates as cu  # noqa: E402

YASH = 'https://github.com/yashveeeeeeer/india-geodata/releases/download'
NOW = '2026-11-18T10:00:00Z'


def sc(method, url, fingerprint=None, **kw):
    return {'method': method, 'url': url, 'fingerprint': fingerprint, 'checked_at': None, 'changed_at': None, **kw}


def layer(lid, check, fetched_at='2026-05-19T07:56:49+00:00'):
    return {'id': lid, 'fetched_at': fetched_at, 'source_check': check}


RELEASE = {'tag_name': 'admin/districts', 'published_at': '2026-03-08T04:56:31Z',
           'assets': [{'name': 'LGD_Districts.parquet', 'size': 22, 'updated_at': '2026-03-08T04:56:26Z'},
                      {'name': 'SOI_Districts.parquet', 'size': 33, 'updated_at': '2026-03-09T00:00:00Z'}]}


class FakeClient:
    """Answers by URL; records every request so tests can count them."""

    def __init__(self, heads=None, json_by_url=None):
        self.heads = heads or {}
        self.json_by_url = json_by_url or {}
        self.calls: list[str] = []

    def head_meta(self, url):
        self.calls.append(url)
        r = self.heads[url]
        if isinstance(r, Exception):
            raise r
        return r

    def get_json(self, url):
        self.calls.append(url)
        r = self.json_by_url[url]
        if isinstance(r, Exception):
            raise r
        return r


# ── fingerprints ────────────────────────────────────────────────────────────

def test_an_http_fingerprint_joins_etag_last_modified_and_length_and_dates_by_last_modified():
    fp, date = cu.fingerprint(sc('http', 'u'), {'etag': '"abc"', 'last-modified': 'Sat, 24 Feb 2024 10:31:09 GMT',
                                                'content-length': '1738'})
    assert fp == 'etag="abc" last-modified=Sat, 24 Feb 2024 10:31:09 GMT length=1738'
    assert date == '2024-02-24T10:31:09Z'


def test_an_http_answer_with_none_of_the_three_headers_is_an_error():
    with pytest.raises(cu.CheckError, match='no ETag'):
        cu.fingerprint(sc('http', 'u'), {})


def test_a_release_asset_fingerprint_is_its_updated_at_and_size():
    check = sc('github_release', f'{YASH}/admin/districts/LGD_Districts.parquet')
    assert cu.request_of(check) == ('json', 'https://api.github.com/repos/yashveeeeeeer/india-geodata/releases/tags/'
                                            'admin%2Fdistricts')
    assert cu.fingerprint(check, RELEASE) == ('updated_at=2026-03-08T04:56:26Z size=22', '2026-03-08T04:56:26Z')


def test_a_release_asset_that_is_gone_is_an_error():
    check = sc('github_release', f'{YASH}/admin/districts/Gone.parquet')
    with pytest.raises(cu.CheckError, match='Gone.parquet'):
        cu.fingerprint(check, RELEASE)


def test_a_repository_url_is_checked_on_its_latest_release_tag():
    check = sc('github_release', 'https://github.com/owner/repo')
    assert cu.request_of(check) == ('json', 'https://api.github.com/repos/owner/repo/releases/latest')
    assert cu.fingerprint(check, {'tag_name': 'v6', 'published_at': '2025-01-01T00:00:00Z'}) == (
        'tag=v6', '2025-01-01T00:00:00Z')


def test_a_github_folder_is_checked_on_the_latest_commit_touching_it():
    check = sc('github_commit', 'https://github.com/datta07/INDIAN-SHAPEFILES/tree/master/METROPOLITAN%20CITIES')
    assert cu.request_of(check) == ('json', 'https://api.github.com/repos/datta07/INDIAN-SHAPEFILES/commits?'
                                            'sha=master&path=METROPOLITAN%20CITIES&per_page=1')
    commits = [{'sha': 'abc123', 'commit': {'committer': {'date': '2020-05-01T00:00:00Z'}}}]
    assert cu.fingerprint(check, commits) == ('commit=abc123', '2020-05-01T00:00:00Z')


def test_ckan_package_show_is_dated_by_metadata_modified():
    check = sc('ckan', 'https://ckan.example/api/3/action/package_show?id=x')
    assert cu.request_of(check) == ('json', check['url'])
    assert cu.fingerprint(check, {'success': True, 'result': {'metadata_modified': '2026-01-02T03:04:05.123'}}) == (
        'metadata_modified=2026-01-02T03:04:05.123', '2026-01-02T03:04:05Z')


def test_the_data_gov_in_listing_is_dated_by_its_latest_changed_resource():
    check = sc('ckan', 'https://www.data.gov.in/backend/dmspublic/v1/resources?format=json&filters%5Buuid%5D=x')
    listing = {'total': 2, 'data': {'rows': [{'changed': [1705656787], 'ogdp_view_count': [5]},
                                             {'changed': [1786334103], 'ogdp_view_count': [9]}]}}
    assert cu.fingerprint(check, listing) == ('resources=2 changed=1786334103', '2026-08-10T03:55:03Z')


def test_gtfs_is_routed_but_not_built_yet():
    with pytest.raises(cu.CheckError, match='gtfs'):
        cu.request_of(sc('gtfs', 'https://example.org/feed.zip'))


def test_an_unknown_method_is_an_error():
    with pytest.raises(cu.CheckError, match='unknown'):
        cu.request_of(sc('carrier_pigeon', 'x'))


# ── status ──────────────────────────────────────────────────────────────────

def test_a_recorded_fingerprint_decides_unchanged_or_changed():
    assert cu.classify('a', 'a', None, None) == 'unchanged'
    assert cu.classify('a', 'b', None, None) == 'changed'


def test_without_a_fingerprint_a_source_dated_after_the_fetch_has_changed_since_ingest():
    assert cu.classify(None, 'x', '2026-06-01T00:00:00Z', '2026-05-19T07:56:49+00:00') == 'changed'
    assert cu.classify(None, 'x', '2026-03-08T00:00:00Z', '2026-05-19T07:56:49+00:00') == 'unchanged'
    # a date-only fetched_at covers that whole day
    assert cu.classify(None, 'x', '2026-11-17T22:00:00Z', '2026-11-17') == 'unchanged'
    # no date to go on: there is no baseline yet
    assert cu.classify(None, 'x', None, '2026-05-19') == 'baseline'


# ── run ─────────────────────────────────────────────────────────────────────

def catalog_two_assets_one_release():
    return {'layers': [
        layer('lgd_districts', sc('github_release', f'{YASH}/admin/districts/LGD_Districts.parquet',
                                  'updated_at=2026-03-08T04:56:26Z size=22')),
        layer('soi_districts', sc('github_release', f'{YASH}/admin/districts/SOI_Districts.parquet',
                                  'updated_at=2026-01-01T00:00:00Z size=1')),
        layer('wards_pune', sc('manual', 'https://data.opencity.in/x', reason='Cloudflare')),
        layer('gb_adm1', sc('http', 'https://gb.example/api/ADM1/')),
    ]}


def client_for_catalog():
    return FakeClient(
        heads={'https://gb.example/api/ADM1/': {'etag': '"1"', 'last-modified': 'Sat, 24 Feb 2024 10:31:09 GMT'}},
        json_by_url={'https://api.github.com/repos/yashveeeeeeer/india-geodata/releases/tags/admin%2Fdistricts':
                     RELEASE})


def test_a_run_asks_each_release_once_skips_manual_layers_and_records_every_status(tmp_path):
    out = tmp_path / 'update-status.json'
    client = client_for_catalog()
    status = cu.run(catalog_two_assets_one_release(), out, client, now=lambda: NOW)
    assert sorted(client.calls) == ['https://api.github.com/repos/yashveeeeeeer/india-geodata/releases/tags/'
                                    'admin%2Fdistricts', 'https://gb.example/api/ADM1/']
    assert {k: v['status'] for k, v in status.items()} == {
        'lgd_districts': 'unchanged', 'soi_districts': 'changed', 'wards_pune': 'manual', 'gb_adm1': 'unchanged'}
    assert status['soi_districts']['old'] == 'updated_at=2026-01-01T00:00:00Z size=1'
    assert status['soi_districts']['new'] == 'updated_at=2026-03-09T00:00:00Z size=33'
    assert status['soi_districts']['checked_at'] == NOW
    assert json.loads(out.read_text()) == status


def test_a_second_run_within_the_window_asks_nothing_and_changes_nothing(tmp_path):
    out = tmp_path / 'update-status.json'
    cu.run(catalog_two_assets_one_release(), out, client_for_catalog(), now=lambda: NOW)
    before = out.read_text()
    again = FakeClient()
    cu.run(catalog_two_assets_one_release(), out, again, now=lambda: '2026-11-18T12:00:00Z')
    assert again.calls == []
    assert out.read_text() == before


def test_a_run_rechecks_entries_older_than_the_window_or_whose_check_changed(tmp_path):
    out = tmp_path / 'update-status.json'
    cu.run(catalog_two_assets_one_release(), out, client_for_catalog(), now=lambda: NOW)
    client = client_for_catalog()
    cu.run(catalog_two_assets_one_release(), out, client, now=lambda: '2026-11-25T10:00:00Z')
    assert len(client.calls) == 2
    cat = catalog_two_assets_one_release()
    cat['layers'][3]['source_check']['url'] = 'https://gb.example/api/ADM2/'
    client = FakeClient(heads={'https://gb.example/api/ADM2/': {'etag': '"2"'}})
    cu.run(cat, out, client, now=lambda: '2026-11-25T11:00:00Z')
    assert client.calls == ['https://gb.example/api/ADM2/']


def test_a_failed_request_is_an_error_entry_and_the_rest_still_finish(tmp_path):
    out = tmp_path / 'update-status.json'
    client = client_for_catalog()
    client.heads['https://gb.example/api/ADM1/'] = urllib.error.HTTPError('u', 503, 'Service Unavailable', {}, None)
    status = cu.run(catalog_two_assets_one_release(), out, client, now=lambda: NOW)
    assert status['gb_adm1']['status'] == 'error'
    assert '503' in status['gb_adm1']['error']
    assert status['lgd_districts']['status'] == 'unchanged'


def test_a_run_past_its_time_limit_starts_no_more_requests_and_keeps_what_it_has(tmp_path):
    out = tmp_path / 'update-status.json'
    client = client_for_catalog()
    status = cu.run(catalog_two_assets_one_release(), out, client, now=lambda: NOW, max_minutes=0)
    assert client.calls == []
    assert set(status) == {'wards_pune'}          # manual needs no request
    assert json.loads(out.read_text()) == status


def test_layers_gone_from_the_catalog_are_dropped_from_the_status(tmp_path):
    out = tmp_path / 'update-status.json'
    out.write_text(json.dumps({'old_layer': {'status': 'unchanged'}}))
    status = cu.run({'layers': [layer('m', sc('manual', None, reason='r'))]}, out, FakeClient(), now=lambda: NOW)
    assert set(status) == {'m'}


# ── accept ──────────────────────────────────────────────────────────────────

def test_accept_records_the_new_fingerprint_and_dates_in_the_catalog():
    cat = catalog_two_assets_one_release()
    status = {'soi_districts': {'status': 'changed', 'old': 'o', 'new': 'n', 'new_date': '2026-03-09T00:00:00Z',
                                'checked_at': NOW}}
    assert cu.accept(cat, status, ['soi_districts']) == ['soi_districts']
    got = cat['layers'][1]['source_check']
    assert (got['fingerprint'], got['checked_at'], got['changed_at']) == ('n', NOW, '2026-03-09T00:00:00Z')
    assert status['soi_districts']['status'] == 'unchanged' and status['soi_districts']['old'] == 'n'


def test_accept_refuses_a_layer_without_a_checked_fingerprint():
    with pytest.raises(SystemExit, match='gb_adm1'):
        cu.accept(catalog_two_assets_one_release(), {'gb_adm1': {'status': 'error'}}, ['gb_adm1'])


def test_accept_all_unchanged_fills_only_missing_fingerprints_and_never_a_changed_one():
    cat = {'layers': [layer('a', sc('http', 'u')), layer('b', sc('http', 'u')), layer('c', sc('http', 'u', 'old')),
                      layer('d', sc('http', 'u'))]}
    status = {'a': {'status': 'baseline', 'new': 'fa', 'new_date': None, 'checked_at': NOW},
              'b': {'status': 'changed', 'new': 'fb', 'new_date': '2026-10-01T00:00:00Z', 'checked_at': NOW},
              'c': {'status': 'unchanged', 'old': 'old', 'new': 'old', 'checked_at': NOW},
              'd': {'status': 'unchanged', 'new': 'fd', 'new_date': '2026-01-01T00:00:00Z', 'checked_at': NOW}}
    assert cu.accept_all_unchanged(cat, status) == ['a', 'd']
    assert [lyr['source_check']['fingerprint'] for lyr in cat['layers']] == ['fa', None, 'old', 'fd']
    assert cu.accept_all_unchanged(cat, status) == []           # idempotent


# ── report ──────────────────────────────────────────────────────────────────

def test_the_issue_lists_changed_and_erroring_layers_with_a_machine_readable_summary(tmp_path):
    cat = catalog_two_assets_one_release()
    status = {'soi_districts': {'status': 'changed', 'method': 'github_release', 'url': f'{YASH}/a/b.parquet',
                                'old': 'o1', 'new': 'n1', 'checked_at': NOW},
              'gb_adm1': {'status': 'error', 'method': 'http', 'url': 'https://gb.example/api/ADM1/',
                          'error': 'HTTP 503', 'checked_at': NOW},
              'lgd_districts': {'status': 'unchanged', 'method': 'github_release', 'checked_at': NOW},
              'wards_pune': {'status': 'manual', 'method': 'manual'}}
    body = cu.issue_body(status, cat)
    assert '| soi_districts | github_release | o1 to n1 |' in body
    assert 'https://github.com/yashveeeeeeer/india-geodata/releases/tag/a' in body     # a page, not the file
    assert '| gb_adm1 | http | HTTP 503 |' in body
    assert '—' not in body
    summary = json.loads(re.search(r'<!-- update-summary (.*) -->', body).group(1))
    assert summary['counts'] == {'changed': 1, 'error': 1, 'unchanged': 1, 'manual': 1}
    assert summary['changed'] == ['soi_districts'] and summary['error'] == ['gb_adm1']
    assert summary['checked_at'] == NOW


def test_with_nothing_changed_the_issue_says_so():
    body = cu.issue_body({'a': {'status': 'unchanged', 'checked_at': NOW}}, {'layers': []})
    assert 'No source has changed' in body


# ── due or overdue rebuilds ─────────────────────────────────────────────────

def refreshed(lid, klass, rebuild, fetched_at):
    return {'id': lid, 'fetched_at': fetched_at, 'refresh': {'class': klass, 'rebuild': rebuild}}


def due_catalog():
    return {'layers': [
        refreshed('ir_stations', 'fast', 'monthly', '2026-10-01T00:00:00+00:00'),         # due 2026-11-01
        refreshed('udise_schools', 'fast', 'monthly', '2026-11-15T00:00:00+00:00'),       # due 2026-12-15
        refreshed('wards_pune', 'regular', 'monthly_if_changed', '2026-05-26T00:00:00+00:00'),
        refreshed('wards_delhi', 'regular', 'monthly_if_changed', '2026-05-26T00:00:00+00:00'),
        refreshed('lgd_states', 'slow', 'on_change', '2026-05-19T00:00:00+00:00'),
        refreshed('state_finance', 'frozen', 'never', '2020-01-01T00:00:00+00:00'),
        {'id': 'no_block', 'fetched_at': '2020-01-01T00:00:00+00:00'},
    ]}


def test_a_fast_layer_without_a_strong_check_is_due_a_month_after_its_last_build():
    due = cu.due_layers(due_catalog(), {}, None, '2026-11-18')
    assert [d['id'] for d in due] == ['ir_stations']
    assert due[0] == {'id': 'ir_stations', 'class': 'fast', 'rebuild': 'monthly', 'last_build': '2026-10-01',
                      'last_identical': None, 'next_due': '2026-11-01', 'days_over': 17,
                      'why': 'weak check: no machine check, checked by hand'}


def test_a_regular_layer_is_due_only_when_its_source_changed_and_its_month_is_up():
    status = {'wards_pune': {'status': 'changed'}, 'wards_delhi': {'status': 'unchanged'},
              'lgd_states': {'status': 'changed'}}
    ids = [d['id'] for d in cu.due_layers(due_catalog(), status, None, '2026-11-18')]
    assert ids == ['wards_pune', 'ir_stations']        # most overdue first; slow layers go by the changed table


def test_frozen_layers_are_never_due():
    ids = [d['id'] for d in cu.due_layers(due_catalog(), {'state_finance': {'status': 'changed'}}, None, '2030-01-01')]
    assert 'state_finance' not in ids and 'no_block' not in ids


def test_a_release_after_fetched_at_counts_as_the_last_build():
    releases = {'releases': [{'dataset': 'ir_stations', 'released': '2026-11-10'}]}
    assert cu.due_layers(due_catalog(), {}, releases, '2026-11-18') == []
    assert cu.due_layers(due_catalog(), {}, releases, '2026-12-10')[0]['last_build'] == '2026-11-10'


VEDAS = 'https://github.com/ramSeraph/indian_power_infra/releases/download/power-sources/Vedas_Wind_Farms.parquet'
PBF = 'https://download.geofabrik.de/asia/india-latest.osm.pbf'


def identical_catalog():
    """Two fast layers built in May, one checked on a release asset (strong), one on an OSM extract (weak)."""
    strong = refreshed('vedas_wind_farms', 'fast', 'monthly', '2026-05-28T14:34:08+00:00')
    strong['source_check'] = sc('github_release', VEDAS, 'updated_at=2026-03-10T02:47:54Z size=6608')
    weak = refreshed('urban_rail_stations', 'fast', 'monthly', '2026-05-17T00:00:00+00:00')
    weak['source_check'] = sc('http', PBF, 'etag="a"')
    return {'layers': [strong, weak]}


def unchanged(check, at='2026-11-16T03:41:00Z', **kw):
    return cu._entry(check, at, status='unchanged', new=check['fingerprint'], **kw)


def test_a_strong_check_confirming_the_source_identical_counts_as_the_refresh_and_a_weak_one_does_not():
    cat = identical_catalog()
    status = {lyr['id']: unchanged(lyr['source_check']) for lyr in cat['layers']}
    due = cu.due_layers(cat, status, None, '2026-11-19')
    assert [d['id'] for d in due] == ['urban_rail_stations']
    assert due[0]['last_identical'] is None and due[0]['why'].startswith('weak check: ')
    # the strong layer is next due a month after the check that confirmed it identical
    later = cu.due_layers(cat, status, None, '2026-12-16')
    assert [(d['id'], d['next_due'], d['last_identical']) for d in later][-1] == \
        ('vedas_wind_farms', '2026-12-16', '2026-11-16')


def test_an_identical_check_counts_only_if_it_checked_the_current_source_and_fingerprint():
    cat = identical_catalog()
    check = cat['layers'][0]['source_check']
    for stale in (unchanged(check) | {'url': 'https://elsewhere/x.parquet'}, unchanged(check) | {'old': 'older'}):
        due = cu.due_layers(cat, {'vedas_wind_farms': stale}, None, '2026-11-19')
        assert 'vedas_wind_farms' in [d['id'] for d in due]


def test_a_strong_layer_whose_check_failed_or_changed_stays_due_and_says_why():
    cat = identical_catalog()
    check = cat['layers'][0]['source_check']
    for entry, why in ((cu._entry(check, NOW, error='timeout'), 'source not confirmed identical (error)'),
                       (cu._entry(check, NOW, status='changed', new='x'), 'source changed'),
                       (None, 'source not confirmed identical (not checked yet)')):
        due = cu.due_layers(cat, {'vedas_wind_farms': entry} if entry else {}, None, '2026-11-19')
        assert next(d for d in due if d['id'] == 'vedas_wind_farms')['why'] == why


def test_the_issue_has_a_due_or_overdue_table_and_the_summary_counts_it():
    due = cu.due_layers(due_catalog(), {}, None, '2026-11-18')
    body = cu.issue_body({'a': {'status': 'unchanged', 'checked_at': NOW}}, due_catalog(), due)
    assert '### Due or overdue (1)' in body
    assert 'confirmed its source identical' in body          # the rule, in one line under the heading
    assert '| Layer | Class | Rebuild | Last build | Confirmed identical | Due | Days over | Why |' in body
    assert '| ir_stations | fast | monthly | 2026-10-01 |  | 2026-11-01 | 17 | weak check: no machine check, ' \
           'checked by hand |' in body
    summary = json.loads(re.search(r'<!-- update-summary (.*) -->', body).group(1))
    assert summary['due'] == ['ir_stations'] and summary['due_count'] == 1
    assert summary['counts'] == {'unchanged': 1}


def test_with_nothing_due_the_issue_says_so_and_the_summary_has_an_empty_due_list():
    body = cu.issue_body({'a': {'status': 'unchanged', 'checked_at': NOW}}, {'layers': []}, [])
    assert 'No layer is due for a rebuild.' in body
    summary = json.loads(re.search(r'<!-- update-summary (.*) -->', body).group(1))
    assert summary['due'] == [] and summary['due_count'] == 0


def test_main_writes_the_due_table_into_the_issue_and_summary(tmp_path, monkeypatch):
    cat = tmp_path / 'catalog.json'
    cat.write_text(json.dumps(due_catalog()))
    monkeypatch.setattr(cu, 'today', lambda: '2026-11-18')
    out, summ = tmp_path / 'issue.md', tmp_path / 'summary.json'
    assert cu.main(['--catalog', str(cat), '--status', str(tmp_path / 's.json'), '--releases',
                    str(tmp_path / 'none.json'), '--issue-body', str(out), '--summary', str(summ)]) == 0
    assert '| ir_stations | fast |' in out.read_text()
    assert json.loads(summ.read_text())['due'] == ['ir_stations']


@pytest.fixture(autouse=True)
def _no_licence_pages(monkeypatch):
    monkeypatch.setattr(cu, 'licence_results', lambda: [])


LICENCE_CHANGED = [{'id': 'nrsc', 'layers': ['bhuvan_x'], 'url': 'https://nrsc.example/terms', 'status': 'changed'}]


def test_the_issue_lists_changed_licence_terms_and_the_summary_counts_them():
    body = cu.issue_body({'a': {'status': 'unchanged', 'checked_at': NOW}}, {'layers': []}, [], LICENCE_CHANGED)
    assert '### Licence terms changed (1)' in body and '--accept nrsc' in body
    summary = json.loads(re.search(r'<!-- update-summary (.*) -->', body).group(1))
    assert summary['licence_changed'] == ['nrsc'] and summary['licence_error'] == []


def test_main_checks_the_licence_terms_every_week(tmp_path, monkeypatch):
    cat = tmp_path / 'catalog.json'
    cat.write_text(json.dumps({'layers': []}))
    monkeypatch.setattr(cu, 'licence_results', lambda: LICENCE_CHANGED)
    out, summ = tmp_path / 'issue.md', tmp_path / 'summary.json'
    assert cu.main(['--catalog', str(cat), '--status', str(tmp_path / 's.json'), '--releases',
                    str(tmp_path / 'none.json'), '--issue-body', str(out), '--summary', str(summ)]) == 0
    assert 'Licence terms changed' in out.read_text()
    assert json.loads(summ.read_text())['licence_changed'] == ['nrsc']


# ── weak checks never report "changed" ──────────────────────────────────────

DGI = 'https://www.data.gov.in/backend/dmspublic/v1/resources?format=json&filters%5Buuid%5D=x'


def dgi_listing(frequency, changed=1795021225):
    return {'total': 1, 'data': {'rows': [{'changed': [changed], 'frequency': [frequency]}]}}


def test_a_weak_check_records_its_fingerprint_but_is_weak_not_changed(tmp_path):
    cat = {'layers': [layer('urban_rail_stations', sc('http', PBF, 'etag="a"'))]}
    client = FakeClient(heads={PBF: {'etag': '"b"'}})
    e = cu.run(cat, tmp_path / 's.json', client, now=lambda: NOW)['urban_rail_stations']
    assert e['status'] == 'weak' and e['new'] == 'etag="b"'
    assert e['weak'].startswith('an OpenStreetMap extract')


def test_an_entry_saved_before_weak_checks_existed_is_asked_again(tmp_path):
    # a status file from before #338 has no `weak` field: its 'changed' for an OpenStreetMap layer is stale
    out = tmp_path / 's.json'
    cat = {'layers': [layer('urban_rail_stations', sc('http', PBF, 'etag="a"'))]}
    out.write_text(json.dumps({'urban_rail_stations': {
        'status': 'changed', 'method': 'http', 'url': PBF, 'old': 'etag="a"', 'new': 'etag="b"',
        'new_date': None, 'checked_at': NOW, 'error': None}}))
    client = FakeClient(heads={PBF: {'etag': '"b"'}})
    e = cu.run(cat, out, client, now=lambda: NOW)['urban_rail_stations']
    assert client.calls == [PBF]
    assert e['status'] == 'weak'


def test_a_data_gov_in_resource_marked_daily_is_a_weak_check_and_one_marked_five_yearly_is_not(tmp_path):
    cat = {'layers': [layer('mgnrega_districts', sc('ckan', DGI, 'resources=1 changed=1'))]}
    daily = cu.run(cat, tmp_path / 'a.json', FakeClient(json_by_url={DGI: dgi_listing('Daily')}), now=lambda: NOW)
    assert daily['mgnrega_districts']['status'] == 'weak'
    assert 'Daily' in daily['mgnrega_districts']['weak']
    five = cu.run(cat, tmp_path / 'b.json', FakeClient(json_by_url={DGI: dgi_listing('Five Yearly')}),
                  now=lambda: NOW)
    assert five['mgnrega_districts']['status'] == 'changed' and five['mgnrega_districts']['weak'] is None


def test_weak_layers_are_not_listed_or_counted_as_changed():
    status = {'urban_rail_stations': cu._entry(sc('http', PBF, 'etag="a"'), NOW, status='weak', new='etag="b"',
                                               weak='an OpenStreetMap extract changes daily')}
    body = cu.issue_body(status, {'layers': []}, [])
    assert 'Changed since ingest' not in body and 'No source has changed' in body
    assert '1 on a weak check' in body
    summary = json.loads(re.search(r'<!-- update-summary (.*) -->', body).group(1))
    assert summary['changed'] == [] and summary['counts'] == {'weak': 1}


def test_a_regular_layer_on_a_weak_check_is_due_by_its_schedule_and_says_why():
    cat = {'layers': [refreshed('mgnrega_districts', 'regular', 'monthly_if_changed', '2026-10-01T00:00:00+00:00')]}
    cat['layers'][0]['source_check'] = sc('ckan', DGI, 'f')
    entry = cu._entry(cat['layers'][0]['source_check'], NOW, status='weak', new='g', weak='marked Daily')
    due = cu.due_layers(cat, {'mgnrega_districts': entry}, None, '2026-11-18')
    assert [(d['id'], d['why']) for d in due] == [('mgnrega_districts', 'weak check: marked Daily')]
    assert cu.due_layers(cat, {'mgnrega_districts': entry}, None, '2026-10-20') == []


# ── data.gov.in refuses GitHub's servers: checked from India instead ────────

def dgi_catalog():
    return {'layers': [layer('wbc1_water_bodies', sc('ckan', DGI, 'resources=1 changed=1')),
                       layer('gb_adm1', sc('http', 'https://gb.example/api/ADM1/'))]}


def test_in_ci_data_gov_in_is_not_asked_and_is_listed_as_local_only(tmp_path):
    client = FakeClient(heads={'https://gb.example/api/ADM1/': {'etag': '"1"'}})
    status = cu.run(dgi_catalog(), tmp_path / 's.json', client, now=lambda: NOW, in_ci=True)
    assert client.calls == ['https://gb.example/api/ADM1/']
    assert status['wbc1_water_bodies']['status'] == 'local_only'
    assert status['wbc1_water_bodies']['checked_at'] is None       # a later local run asks it at once


def test_locally_data_gov_in_is_asked_and_a_failure_is_a_real_error(tmp_path):
    client = FakeClient(heads={'https://gb.example/api/ADM1/': {'etag': '"1"'}},
                        json_by_url={DGI: urllib.error.HTTPError(DGI, 503, 'Service Unavailable', {}, None)})
    status = cu.run(dgi_catalog(), tmp_path / 's.json', client, now=lambda: NOW)
    assert DGI in client.calls and status['wbc1_water_bodies']['status'] == 'error'


def test_local_only_layers_have_their_own_section_and_are_not_errors():
    status = {'wbc1_water_bodies': {'status': 'local_only', 'method': 'ckan', 'url': DGI, 'checked_at': None},
              'a': {'status': 'unchanged', 'checked_at': NOW}}
    body = cu.issue_body(status, {'layers': []}, [])
    assert '### Checked from India each month (1)' in body
    assert '`python3 scripts/check_updates.py --max-age-hours 0`' in body
    assert '| wbc1_water_bodies |' in body and 'Errors' not in body
    summary = json.loads(re.search(r'<!-- update-summary (.*) -->', body).group(1))
    assert summary['error'] == [] and summary['local_only'] == ['wbc1_water_bodies']
    assert summary['counts'] == {'local_only': 1, 'unchanged': 1}


def test_main_skips_data_gov_in_on_github_actions(tmp_path, monkeypatch):
    cat = tmp_path / 'catalog.json'
    cat.write_text(json.dumps({'layers': [layer('wbc1_water_bodies', sc('ckan', DGI))]}))
    monkeypatch.setenv('GITHUB_ACTIONS', 'true')
    monkeypatch.setattr(cu.Client, 'get_json', lambda self, url: pytest.fail(f'asked {url}'))
    summ = tmp_path / 'summary.json'
    assert cu.main(['--catalog', str(cat), '--status', str(tmp_path / 's.json'), '--releases',
                    str(tmp_path / 'none.json'), '--summary', str(summ)]) == 0
    assert json.loads(summ.read_text())['local_only'] == ['wbc1_water_bodies']


# ── politeness ──────────────────────────────────────────────────────────────

def test_requests_to_one_host_are_spaced_by_the_delay():
    clock = {'t': 100.0}
    slept = []

    def sleep(s):
        slept.append(round(s, 3))
        clock['t'] += s
    gate = cu.HostGate(delay=1.5, clock=lambda: clock['t'], sleep=sleep)
    gate.wait('a.example')
    gate.wait('b.example')
    gate.wait('a.example')
    assert slept == [1.5]


def test_the_client_sends_the_generic_user_agent_and_no_personal_data():
    assert cu.USER_AGENT == 'bharatlas-update-check/1.0'


class FakeResponse:
    def __init__(self, status, headers):
        self.status, self.headers = status, headers

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_a_refused_head_falls_back_to_one_ranged_get_and_reads_the_total_size():
    sent = []

    def fake_open(url, method='GET', headers=None):
        sent.append((method, (headers or {}).get('Range')))
        if method == 'HEAD':
            raise urllib.error.HTTPError(url, 405, 'Method Not Allowed', {}, None)
        return FakeResponse(206, {'ETag': '"e"', 'Content-Range': 'bytes 0-0/12345', 'Content-Length': '1'})
    client = cu.Client(gate=cu.HostGate(delay=0))
    client._open = fake_open
    assert client.head_meta('https://a.example/f.zip') == {'etag': '"e"', 'content-range': 'bytes 0-0/12345',
                                                           'content-length': '12345'}
    assert sent == [('HEAD', None), ('GET', 'bytes=0-0')]


def test_a_redirected_head_stays_a_head_so_no_data_file_is_downloaded():
    import urllib.request
    req = urllib.request.Request('https://a.example/f.parquet', method='HEAD', headers={'Range': 'bytes=0-0'})
    new = cu.KeepMethodRedirect().redirect_request(req, None, 302, 'Found', {}, 'https://b.example/f.parquet')
    assert new.get_method() == 'HEAD' and new.full_url == 'https://b.example/f.parquet'
    assert new.get_header('Range') == 'bytes=0-0'


def test_the_github_token_is_not_carried_to_another_host_by_a_redirect():
    import urllib.request
    req = urllib.request.Request('https://api.github.com/repos/a/b', headers={'Authorization': 'Bearer t'})
    same = cu.KeepMethodRedirect().redirect_request(req, None, 301, 'Moved', {}, 'https://api.github.com/repos/a/c')
    other = cu.KeepMethodRedirect().redirect_request(req, None, 302, 'Found', {}, 'https://elsewhere.example/x')
    assert same.get_header('Authorization') == 'Bearer t'
    assert other.get_header('Authorization') is None
