"""MGNREGA district layer: data.gov.in pull (cached, resumable), latest
cumulative snapshot per district and year, NREGA -> LGD district matching.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_mgnrega_districts.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_mgnrega_districts as m  # noqa: E402


# ── pull: cached, resumable, idempotent ──────────────────────────────────────

def test_pull_saves_each_page_and_a_rerun_fetches_nothing(tmp_path):
    calls = []

    def fetch(offset, limit, filters):
        calls.append(offset)
        recs = [{'i': i} for i in range(offset, min(offset + limit, 7))]
        return {'total': 7, 'records': recs}

    rows = m.pull_pages(tmp_path, {'fin_year': '2025-2026'}, fetch, limit=3)
    assert len(rows) == 7 and calls == [0, 0, 3, 6]  # one probe for the total, then 3 pages
    calls.clear()
    assert len(m.pull_pages(tmp_path, {'fin_year': '2025-2026'}, fetch, limit=3)) == 7
    assert calls == [0]  # only the total probe; every page came from the cache


def test_pull_resumes_after_a_failure(tmp_path):
    def flaky(offset, limit, filters):
        if offset == 3:
            raise OSError('dropped')
        return {'total': 7, 'records': [{'i': i} for i in range(offset, min(offset + limit, 7))]}

    try:
        m.pull_pages(tmp_path, {}, flaky, limit=3)
    except OSError:
        pass
    done = []

    def ok(offset, limit, filters):
        done.append(offset)
        return {'total': 7, 'records': [{'i': i} for i in range(offset, min(offset + limit, 7))]}

    assert len(m.pull_pages(tmp_path, {}, ok, limit=3)) == 7
    assert done == [0, 3, 6]  # the total probe, then only the pages not yet cached


def test_pull_stops_at_its_own_time_limit_and_keeps_finished_pages(tmp_path):
    import pipeline
    clock = iter([0.0, 10.0, 100.0, 100.0])
    deadline = pipeline.Deadline(minutes=1, clock=lambda: next(clock))

    def fetch(offset, limit, filters):
        return {'total': 7, 'records': [{'i': i} for i in range(offset, min(offset + limit, 7))]}

    with pytest.raises(pipeline.OutOfTime):
        m.pull_pages(tmp_path, {}, fetch, limit=3, deadline=deadline)
    assert [p.name for p in sorted(tmp_path.glob('offset_*'))] == ['offset_0000000.json.gz']


# ── latest cumulative snapshot per district-year ─────────────────────────────

def test_year_end_is_the_largest_cumulative_snapshot():
    # Rows are cumulative year-to-date, several per month; the year's figure is
    # the latest, which is the one with the largest Total_Exp.
    rows = [
        {'fin_year': '2025-2026', 'district_code': '1810', 'month': 'Dec', 'Total_Exp': '100', 'Wages': '60'},
        {'fin_year': '2025-2026', 'district_code': '1810', 'month': 'March', 'Total_Exp': '250', 'Wages': '150'},
        {'fin_year': '2025-2026', 'district_code': '1810', 'month': 'Jan', 'Total_Exp': '180', 'Wages': '90'},
        {'fin_year': '2025-2026', 'district_code': '1752', 'month': 'March', 'Total_Exp': '9', 'Wages': '5'},
    ]
    out = {r['district_code']: r for r in m.year_end(rows)}
    assert out['1810']['month'] == 'March' and out['1810']['Total_Exp'] == 250.0
    assert out['1810']['Wages'] == 150.0 and len(out) == 2


# ── NREGA -> LGD district matching ───────────────────────────────────────────

LGD = [
    {'dist_lgd': 484, 'dtname': 'Nagpur', 'stname': 'MAHARASHTRA'},
    {'dist_lgd': 470, 'dtname': 'Ahmednagar', 'stname': 'MAHARASHTRA'},
    {'dist_lgd': 188, 'dtname': 'Gaya', 'stname': 'BIHAR'},
    {'dist_lgd': 465, 'dtname': 'Dadra And Nagar Haveli', 'stname': 'THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU'},
]


def test_names_match_within_state_after_normalising():
    hits, unmatched = m.match_districts([('MAHARASHTRA', 'NAGPUR')], LGD)
    assert hits == {('MAHARASHTRA', 'NAGPUR'): 484} and unmatched == []


def test_renamed_districts_match_through_aliases():
    hits, _ = m.match_districts([('MAHARASHTRA', 'AHILYANAGAR'), ('BIHAR', 'GAYAJI')], LGD)
    assert hits == {('MAHARASHTRA', 'AHILYANAGAR'): 470, ('BIHAR', 'GAYAJI'): 188}


def test_state_names_differ_between_nrega_and_lgd():
    hits, _ = m.match_districts([('DN HAVELI AND DD', 'DADRA AND NAGAR HAVELI')], LGD)
    assert hits == {('DN HAVELI AND DD', 'DADRA AND NAGAR HAVELI'): 465}


def test_unmatched_districts_are_reported_not_dropped_silently():
    _, unmatched = m.match_districts([('ANDHRA PRADESH', 'Polavaram')], LGD)
    assert unmatched == [('ANDHRA PRADESH', 'Polavaram')]


def test_a_truncated_response_is_retried_not_fatal():
    # data.gov.in dropped a 9 MB page mid-transfer (http.client.IncompleteRead,
    # not an OSError), which ended the pull.
    import http.client
    attempts = []

    def flaky():
        attempts.append(1)
        if len(attempts) < 3:
            raise http.client.IncompleteRead(b'x', 10)
        return {'ok': True}

    assert m.with_retries(flaky, tries=4, wait=lambda n: None) == {'ok': True}
    assert len(attempts) == 3


REAL_LGD = [
    {'dist_lgd': 603, 'dtname': 'Nicobars', 'stname': 'ANDAMAN & NICOBAR'},
    {'dist_lgd': 759, 'dtname': 'Khairgarh Chhuikhadan Gandai', 'stname': 'CHHATTISGARH'},
    {'dist_lgd': 531, 'dtname': 'Chamarajanagara', 'stname': 'KARNATAKA'},
    {'dist_lgd': 391, 'dtname': 'Ashoknagar', 'stname': 'MADHYA PRADESH'},
    {'dist_lgd': 518, 'dtname': 'Ranga Reddy', 'stname': 'TELANGANA'},
    {'dist_lgd': 311, 'dtname': 'Dinajpur Uttar', 'stname': 'WEST BENGAL'},
    {'dist_lgd': 309, 'dtname': 'Darjeeling', 'stname': 'WEST BENGAL'},
]


def test_spelling_variants_seen_in_the_2025_26_pull_match():
    pairs = [('ANDAMAN AND NICOBAR', 'NICOBARS'), ('CHHATTISGARH', 'KHAIRAGARH CHHUIKHADAN GANDAI'),
             ('KARNATAKA', 'CHAMARAJA NAGARA'), ('MADHYA PRADESH', 'ASHOK NAGAR'),
             ('TELANGANA', 'Rangareddy'), ('WEST BENGAL', 'UTTAR DINAJPUR')]
    hits, unmatched = m.match_districts(pairs, REAL_LGD)
    assert unmatched == [] and set(hits.values()) == {603, 759, 531, 391, 518, 311}


def test_units_spanning_several_districts_stay_unmatched():
    # GTA covers Darjeeling's hills and Kalimpong: it cannot go to one district.
    _, unmatched = m.match_districts([('WEST BENGAL', 'GORKHALAND TERRITORIAL ADMINISTRATION (GTA)')], REAL_LGD)
    assert unmatched == [('WEST BENGAL', 'GORKHALAND TERRITORIAL ADMINISTRATION (GTA)')]


def test_district_rows_carry_the_year_and_a_spend_column_per_year():
    full = [{'fin_year': '2025-2026', 'state_name': 'MAHARASHTRA', 'district_code': '1810', 'district_name': 'NAGPUR',
             'month': 'March', 'Total_Exp': '300', 'Wages': '200', 'percent_of_NRM_Expenditure': '61.5'}]
    trend = [
        {'fin_year': '2024-2025', 'state_name': 'MAHARASHTRA', 'district_code': '1810', 'district_name': 'NAGPUR', 'month': 'March', 'Total_Exp': '250'},
        {'fin_year': '2025-2026', 'state_name': 'MAHARASHTRA', 'district_code': '1810', 'district_name': 'NAGPUR', 'month': 'March', 'Total_Exp': '300'},
        {'fin_year': '2025-2026', 'state_name': 'MAHARASHTRA', 'district_code': '1810', 'district_name': 'NAGPUR', 'month': 'Jan', 'Total_Exp': '120'},
        {'fin_year': 'NA', 'state_name': 'MAHARASHTRA', 'district_code': '1810', 'district_name': 'NAGPUR', 'month': 'NA', 'Total_Exp': '1'},  # seen in the source
    ]
    rows, unmatched = m.district_rows(full, trend, LGD)
    assert unmatched == []
    r = rows[484]
    assert r['Total_Exp'] == 300.0 and r['percent_of_NRM_Expenditure'] == 61.5 and r['fin_year'] == '2025-2026'
    assert r['exp_2024_25'] == 250.0 and r['exp_2025_26'] == 300.0


def test_two_nrega_units_on_one_lgd_district_fail_loudly():
    # Summing would corrupt the percentage columns; picking one would hide data.
    full = [
        {'fin_year': '2025-2026', 'state_name': 'MAHARASHTRA', 'district_code': '1', 'district_name': 'NAGPUR', 'month': 'March', 'Total_Exp': '1'},
        {'fin_year': '2025-2026', 'state_name': 'MAHARASHTRA', 'district_code': '2', 'district_name': 'Nagpur', 'month': 'March', 'Total_Exp': '2'},
    ]
    import pytest
    with pytest.raises(ValueError, match='484'):
        m.district_rows(full, [], LGD)


def test_yearly_spend_sums_units_that_share_a_district():
    # Spend is additive: NREGA split Darjeeling into the hill council and
    # Siliguri in earlier years; the district's year total is their sum.
    lgd = [{'dist_lgd': 309, 'dtname': 'Darjeeling', 'stname': 'WEST BENGAL'}]
    full = [{'fin_year': '2025-2026', 'state_name': 'WEST BENGAL', 'district_code': '3201',
             'district_name': 'SILIGURI MAHAKUMA PARISAD', 'month': 'March', 'Total_Exp': '5'}]
    trend = [
        {'fin_year': '2019-2020', 'state_name': 'WEST BENGAL', 'district_code': '3201', 'district_name': 'SILIGURI MAHAKUMA PARISAD', 'month': 'March', 'Total_Exp': '4'},
        {'fin_year': '2019-2020', 'state_name': 'WEST BENGAL', 'district_code': '3202', 'district_name': 'Darjeeling Gorkha Hill Council (DGHC)', 'month': 'March', 'Total_Exp': '6'},
    ]
    rows, _ = m.district_rows(full, trend, lgd)
    assert rows[309]['exp_2019_20'] == 10.0


# ── catalog registration ─────────────────────────────────────────────────────

SIZES = {'parquet': 1, 'pmtiles': 2, 'geojson': 3, 'kml': 4, 'shapefile': 5}
NAMES = {f: f'X.{f}' for f in SIZES}


def test_catalog_entry_is_complete_and_honest():
    e = m.catalog_entry(785, SIZES, '2026-11-15T00:00:00+00:00', 'https://r2.example', ['ANDHRA PRADESH / Polavaram'])
    assert e['id'] == 'mgnrega_districts' and e['category'] == 'economy' and e['licence'] == 'GODL-India'
    assert all(e[f]['url'].startswith('https://r2.example/economy/mgnrega-districts/') for f in SIZES)
    assert 'Rs lakh' in e['notes'] and 'Polavaram' in e['notes']  # units and unmatched districts stated
    assert e['fetched_at'] and e['attribution']['primary']['name']


def test_register_adds_the_economy_category_and_is_idempotent(tmp_path):
    import json
    cat = tmp_path / 'catalog.json'
    man = tmp_path / 'manifest.json'
    summ = tmp_path / 'summary.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': [], 'attribution': {},
                               'categories': {'health-edu': 'Health & education', 'other': 'Other'}}))
    man.write_text('[]')
    summ.write_text(json.dumps({'rows': 785, 'sizes': SIZES, 'names': NAMES, 'unmatched': []}))
    for _ in range(2):
        m.register(cat, man, summ, 'https://r2.example')
    c = json.loads(cat.read_text())
    assert [l['id'] for l in c['layers']] == ['mgnrega_districts']
    assert c['level_order'] == ['mgnrega_districts'] and c['categories']['economy'] == 'Economy & finance'
    assert list(c['categories']).index('economy') < list(c['categories']).index('other')
    assert len(json.loads(man.read_text())) == 1


def test_trend_columns_stop_at_the_layer_year():
    # 2026-27 was in progress when pulled; a part-year column beside full years misleads.
    full = [{'fin_year': '2025-2026', 'state_name': 'MAHARASHTRA', 'district_code': '1', 'district_name': 'NAGPUR', 'month': 'March', 'Total_Exp': '3'}]
    trend = [
        {'fin_year': '2025-2026', 'state_name': 'MAHARASHTRA', 'district_code': '1', 'district_name': 'NAGPUR', 'month': 'March', 'Total_Exp': '3'},
        {'fin_year': '2026-2027', 'state_name': 'MAHARASHTRA', 'district_code': '1', 'district_name': 'NAGPUR', 'month': 'April', 'Total_Exp': '1'},
    ]
    rows, _ = m.district_rows(full, trend, LGD)
    assert 'exp_2025_26' in rows[484] and 'exp_2026_27' not in rows[484]
