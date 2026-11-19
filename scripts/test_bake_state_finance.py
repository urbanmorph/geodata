"""State finance layer: cached data.gov.in pulls, source state names -> LGD
states, per-resource value columns, catalog registration.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_state_finance.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_state_finance as m  # noqa: E402

LGD = [
    {'State_LGD': 35, 'STNAME': 'ANDAMAN & NICOBAR'},
    {'State_LGD': 38, 'STNAME': 'DADRA,NAGAR HAVELI,DAMAN & DIU'},
    {'State_LGD': 1, 'STNAME': 'JAMMU & KASHMIR'},
    {'State_LGD': 37, 'STNAME': 'LADAKH'},
    {'State_LGD': 27, 'STNAME': 'MAHARASHTRA'},
    {'State_LGD': 36, 'STNAME': 'TELANGANA'},
    {'State_LGD': 33, 'STNAME': 'TAMIL NADU'},
]
KEYS = m.lgd_keys(LGD)


# ── pull: cached as it arrives, resumable, idempotent ────────────────────────

def test_each_resource_is_cached_and_a_rerun_fetches_nothing(tmp_path):
    calls = []

    def fetch(rid):
        calls.append(rid)
        return {'status': 'ok', 'total': 1, 'records': [{'state_ut': 'Maharashtra', 'x': '1'}]}

    got = m.pull_resources(tmp_path, ['a', 'b'], fetch)
    assert calls == ['a', 'b'] and got['a']['records'][0]['x'] == '1'
    calls.clear()
    assert m.pull_resources(tmp_path, ['a', 'b'], fetch) == got and calls == []


def test_a_failed_pull_keeps_what_arrived_and_resumes(tmp_path):
    def flaky(rid):
        if rid == 'b':
            raise OSError('dropped')
        return {'status': 'ok', 'total': 1, 'records': [{'r': rid}]}

    with pytest.raises(OSError):
        m.pull_resources(tmp_path, ['a', 'b'], flaky)
    calls = []

    def ok(rid):
        calls.append(rid)
        return {'status': 'ok', 'total': 1, 'records': [{'r': rid}]}

    assert set(m.pull_resources(tmp_path, ['a', 'b'], ok)) == {'a', 'b'} and calls == ['b']


def test_an_empty_or_error_response_is_never_cached(tmp_path):
    # data.gov.in answers "Meta not found" with HTTP 200 for resources it does
    # not serve through the API; caching that would freeze a wrong empty table.
    with pytest.raises(ValueError, match='Meta not found'):
        m.pull_resources(tmp_path, ['a'], lambda rid: {'status': 'error', 'message': 'Meta not found', 'records': []})
    assert not list(tmp_path.iterdir())


def test_the_run_stops_cleanly_at_its_time_limit(tmp_path):
    calls = []

    def fetch(rid):
        calls.append(rid)
        return {'status': 'ok', 'total': 1, 'records': [{'r': rid}]}

    clock = iter([0, 100])  # checked before each fetch
    with pytest.raises(m.TimeLimit):
        m.pull_resources(tmp_path, ['a', 'b'], fetch, deadline=50, now=lambda: next(clock))
    assert calls == ['a']  # 'a' is cached; a rerun picks up 'b'


# ── state names -> LGD ───────────────────────────────────────────────────────

def test_state_names_match_after_normalising():
    assert m.match_state('Maharashtra', KEYS) == 27 and m.match_state('Tamil nadu', KEYS) == 33
    assert m.match_state('Andaman and Nicobar Islands', KEYS) == 35
    assert m.match_state('Dadra and Nagar Haveli and Daman and Diu', KEYS) == 38
    assert m.match_state('Jammu and Kashmir UT', KEYS) == 1


def test_ladakh_is_never_folded_into_jammu_and_kashmir():
    assert m.match_state('Ladakh', KEYS) == 37 and m.match_state('Jammu and Kashmir', KEYS) == 1


def test_unknown_names_do_not_match():
    assert m.match_state('Other Territory', KEYS) is None and m.match_state('N/A', KEYS) is None


# ── per-resource values ──────────────────────────────────────────────────────

GST = {'key': 'gst', 'id': 'x', 'additive': True, 'name_field': 'state_ut',
       'columns': {'gst_gross_2023_24_rs_crore': ('_2023_24', float)},
       'totals': {'gst collection domestic', 'imports', 'total gst collection'}}


def test_values_are_cast_and_na_becomes_null():
    recs = [{'state_ut': 'Maharashtra', '_2023_24': '320117'}, {'state_ut': 'Ladakh', '_2023_24': 'NA'}]
    vals, unmatched, totals = m.resource_values(GST, recs, KEYS)
    assert vals == {27: {'gst_gross_2023_24_rs_crore': 320117.0}, 37: {'gst_gross_2023_24_rs_crore': None}}
    assert unmatched == [] and totals == {}


def test_additive_figures_for_the_merged_ut_are_summed():
    # GST still reports Dadra and Nagar Haveli and Daman and Diu separately;
    # LGD has the merged UT. Collections add, so the UT gets their sum.
    recs = [{'state_ut': 'Daman and Diu', '_2023_24': 3}, {'state_ut': 'Dadra and Nagar Haveli', '_2023_24': 4333}]
    vals, _, _ = m.resource_values(GST, recs, KEYS)
    assert vals[38]['gst_gross_2023_24_rs_crore'] == 4336.0


def test_two_rows_on_one_state_fail_loudly_when_not_additive():
    spec = {**GST, 'additive': False}
    recs = [{'state_ut': 'Daman and Diu', '_2023_24': 3}, {'state_ut': 'Dadra and Nagar Haveli', '_2023_24': 4}]
    with pytest.raises(ValueError, match='38'):
        m.resource_values(spec, recs, KEYS)


def test_total_rows_are_kept_for_checking_and_others_reported_unmatched():
    recs = [{'state_ut': 'Maharashtra', '_2023_24': 5}, {'state_ut': 'Centre Jurisdiction', '_2023_24': 2},
            {'state_ut': 'GST Collection (Domestic)', '_2023_24': 7}]
    vals, unmatched, totals = m.resource_values(GST, recs, KEYS)
    assert unmatched == ['Centre Jurisdiction']
    assert totals == {'GST Collection (Domestic)': {'gst_gross_2023_24_rs_crore': 7.0}}


def test_rows_skipped_on_purpose_are_neither_used_nor_unmatched():
    # GSDP lists the erstwhile state of Jammu and Kashmir (incl. Ladakh, to
    # 2018-19) beside the UT; only the UT row describes today's polygon.
    spec = {'key': 'gsdp', 'id': 'y', 'name_field': 'state_ut',
            'columns': {'gsdp_current_2021_22_rs_crore': ('c2122', float)},
            'skip': {'jammu and kashmir': 'erstwhile state'}}
    recs = [{'state_ut': 'Jammu and Kashmir', 'c2122': 'NA'}, {'state_ut': 'Jammu and Kashmir UT', 'c2122': 195458}]
    vals, unmatched, _ = m.resource_values(spec, recs, KEYS)
    assert vals == {1: {'gsdp_current_2021_22_rs_crore': 195458.0}} and unmatched == []


def test_counts_are_integers():
    spec = {'key': 'kcc', 'id': 'z', 'name_field': 'state_ut',
            'columns': {'kcc_operative_accounts_sep_2024': ('n', int)}}
    vals, _, _ = m.resource_values(spec, [{'state_ut': 'Telangana', 'n': '4375011'}], KEYS)
    assert vals[36]['kcc_operative_accounts_sep_2024'] == 4375011
    assert isinstance(vals[36]['kcc_operative_accounts_sep_2024'], int)


def test_state_rows_merge_resources_and_list_unmatched_by_resource():
    other = {'key': 'dt', 'id': 'w', 'name_field': 'state_ut',
             'columns': {'direct_tax_gross_2022_23_rs_crore': ('g', float)}}
    raw = {'x': [{'state_ut': 'Maharashtra', '_2023_24': 1}],
           'w': [{'state_ut': 'Maharashtra', 'g': 2}, {'state_ut': 'N/A', 'g': 3}, {'state_ut': 'Total', 'g': 6}]}
    rows, unmatched, totals = m.state_rows([GST, other], raw, LGD)
    assert rows[27] == {'gst_gross_2023_24_rs_crore': 1.0, 'direct_tax_gross_2022_23_rs_crore': 2.0}
    assert unmatched == ['dt: N/A'] and totals['dt'] == {'Total': {'direct_tax_gross_2022_23_rs_crore': 6.0}}


def test_every_output_column_names_its_year_or_date():
    import re
    for col in m.COLUMNS:
        assert re.search(r'20\d\d', col), col


# ── catalog registration ─────────────────────────────────────────────────────

SIZES = {'parquet': 1, 'pmtiles': 2, 'geojson': 3, 'kml': 4, 'shapefile': 5}
NAMES = {f: f'X.{f}' for f in SIZES}


def test_catalog_entry_is_complete_and_honest():
    e = m.catalog_entry(36, SIZES, '2026-11-15T00:00:00+00:00', 'https://r2.example', ['gst: Other Territory'])
    assert e['id'] == 'state_finance' and e['category'] == 'economy' and e['licence'] == 'GODL-India'
    assert all(e[f]['url'].startswith('https://r2.example/economy/state-finance/') for f in SIZES)
    assert 'Rs crore' in e['notes'] and 'Other Territory' in e['notes'] and 'Rajya Sabha' in e['notes']
    assert e['fetched_at'] and e['attribution']['primary']['name']
    assert '—' not in e['notes'] and '—' not in m.description()  # no em-dashes in user copy


def test_register_is_idempotent_and_patches_in_place(tmp_path):
    cat, man, summ = tmp_path / 'catalog.json', tmp_path / 'manifest.json', tmp_path / 'summary.json'
    cat.write_text(json.dumps({'layers': [{'id': 'lgd_states'}], 'level_meta': {}, 'level_order': ['state'],
                               'attribution': {}, 'categories': {'economy': 'Economy & finance', 'other': 'Other'}}))
    man.write_text('[]')
    summ.write_text(json.dumps({'rows': 36, 'sizes': SIZES, 'names': NAMES, 'unmatched': []}))
    m.register(cat, man, summ, 'https://r2.example')
    first = cat.read_text()
    m.register(cat, man, summ, 'https://r2.example')
    assert cat.read_text() == first
    c = json.loads(first)
    assert [l['id'] for l in c['layers']] == ['lgd_states', 'state_finance']
    assert c['level_order'] == ['state', 'state_finance'] and list(c['categories']) == ['economy', 'other']
    assert len(json.loads(man.read_text())) == 1
