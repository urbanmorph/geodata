"""Tests for scripts/bake_cityfinance_ulbs.py.

Pure helpers only: the pull and bake steps need the network and the cached
CityFinance answers under data/raw/cityfinance/.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_cityfinance_ulbs.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_cityfinance_ulbs as b  # noqa: E402

PUNE = '5eb5844f76a3b61f40ba0694'
KOTA = '5dd24728437ba31f7eb42e7b'


def is_response(cells: dict[tuple[int | str | None, str], dict[str, float]]) -> dict:
    """A bs-is answer shaped like CityFinance's: one row per line item, one
    `<yyyyyy>_<ulbId>` key per ULB-year that has a figure."""
    rows = [{'code': None, 'isHeader': False, 'lineItem': None, 'isState': True,
             f'202324_{PUNE}': 'Pune Municipal Corporation'},
            {'code': None, 'isHeader': True, 'lineItem': 'A.Income'}]
    for (code, item), vals in cells.items():
        row = {'code': code, 'isNumber': True, 'lineItem': item}
        if code is None:
            row['calculation'] = True
        row.update(vals)
        rows.append(row)
    return {'success': True, 'data': rows}


# ── parsing the income statement answer ──────────────────────────────────

def test_parse_keeps_published_rupee_figures_per_ulb_and_year():
    resp = is_response({
        (110, 'Tax Revenue'): {f'202223_{PUNE}': 40429625850, f'202324_{PUNE}': 77501938101},
        (None, 'Total Income (A)'): {f'202324_{PUNE}': 112068375606},
    })
    recs = b.parse_income_statement(resp)
    assert sorted(recs) == sorted([
        (PUNE, '2022-23', 'tax_revenue', 40429625850),
        (PUNE, '2023-24', 'tax_revenue', 77501938101),
        (PUNE, '2023-24', 'total_income', 112068375606),
    ])


def test_parse_skips_headers_name_rows_and_empty_line_items():
    resp = is_response({(100, 'Others'): {}})
    assert b.parse_income_statement(resp) == []


def test_parse_skips_cityfinance_summary_subtotals():
    # '120-150' (Non-Tax Revenue) is CityFinance's sum of codes we already keep.
    resp = is_response({('120-150', 'Non-Tax Revenue'): {f'202324_{PUNE}': 5}})
    assert b.parse_income_statement(resp) == []


def test_parse_fails_loudly_on_an_unknown_line_item():
    resp = is_response({(999, 'Something New'): {f'202324_{PUNE}': 1}})
    with pytest.raises(ValueError, match='Something New'):
        b.parse_income_statement(resp)


@pytest.mark.parametrize('item,col', [
    ('Total Income (A)', 'total_income'),
    ('Total Expenditure(B)', 'total_expenditure'),
    ('Gross Surplus/(Deficit) of Income over Expenditure before Prior Period Items (C) (A-B)', 'surplus_before_prior_period'),
    ('Gross Surplus/(Deficit) of Income over Expenditure after Prior Period Items item(D) (C+280)', 'surplus_after_prior_period'),
    ('Net Surplus/(Deficit) carried over (E) (D+290)', 'net_surplus'),
])
def test_totals_are_named_from_their_line_item(item, col):
    resp = is_response({(None, item): {f'202324_{PUNE}': 7}})
    assert b.parse_income_statement(resp) == [(PUNE, '2023-24', col, 7)]


def test_fy_from_key():
    assert b.fy_from_key('201516') == '2015-16'
    assert b.fy_from_key('202324') == '2023-24'


# ── one row per ULB: latest year in full, headline totals for every year ──

def test_wide_rows_take_the_latest_year_with_figures():
    recs = [
        (PUNE, '2022-23', 'tax_revenue', 1), (PUNE, '2022-23', 'total_income', 10),
        (PUNE, '2023-24', 'tax_revenue', 2), (PUNE, '2023-24', 'total_income', 20),
        (PUNE, '2023-24', 'total_expenditure', 15),
        (KOTA, '2015-16', 'total_income', 3), (KOTA, '2015-16', 'rental_income', 3),
    ]
    rows = b.wide_rows(recs)
    assert rows[PUNE]['fy'] == '2023-24'
    assert rows[PUNE]['tax_revenue'] == 2
    assert rows[PUNE]['years_available'] == '2022-23,2023-24'
    assert rows[PUNE]['total_income_2022_23'] == 10
    assert rows[PUNE]['total_income_2023_24'] == 20
    assert rows[PUNE]['total_expenditure_2023_24'] == 15
    assert rows[KOTA]['fy'] == '2015-16' and 'tax_revenue' not in rows[KOTA]


def test_wide_rows_drop_years_that_carry_only_computed_totals():
    # CityFinance fills Total Income etc. with 0 for a year with no statement.
    recs = [(PUNE, '2022-23', 'tax_revenue', 1), (PUNE, '2022-23', 'total_income', 10),
            (PUNE, '2023-24', 'total_income', 0), (PUNE, '2023-24', 'net_surplus', 0),
            (KOTA, '2023-24', 'total_income', 0)]
    rows = b.wide_rows(recs)
    assert rows[PUNE]['fy'] == '2022-23' and rows[PUNE]['years_available'] == '2022-23'
    assert 'total_income_2023_24' not in rows[PUNE]
    assert KOTA not in rows


def test_finance_columns_are_stable_and_cover_every_year():
    cols = b.finance_columns()
    assert cols[:3] == ['fy', 'years_available', 'tax_revenue']
    for fy in b.YEARS:
        assert f'total_income_{fy.replace("-", "_")}' in cols
    assert len(cols) == len(set(cols))


# ── join: SBM polygon -> CityFinance ULB by code, state must agree ────────

def cf(id_, state, census=None, sb=None):
    return {'_id': id_, 'name': id_, 'state': state, 'censusCode': census, 'sbCode': sb}


STATES = {'mh': 'MH', 'ka': 'KA'}


def test_match_by_census_code_then_sb_code():
    sbm = [{'ulbcode': '802814', 'stcode': '27'}, {'ulbcode': '900402', 'stcode': '29'}]
    ulbs = [cf('pune', 'mh', census='802814'), cf('kaup', 'ka', sb='900402')]
    matches, rejects = b.match_ulbs(sbm, ulbs, STATES)
    assert matches == {0: ('pune', 'censusCode'), 1: ('kaup', 'sbCode')}
    assert rejects == []


def test_match_rejects_a_code_hit_in_another_state():
    # CityFinance gives Kolhapur (MH) the SBM code of Kollapur (Telangana).
    sbm = [{'ulbcode': '900103', 'stcode': '36'}]
    matches, rejects = b.match_ulbs(sbm, [cf('kolhapur', 'mh', sb='900103')], STATES | {'ts': 'TS'})
    assert matches == {}
    assert rejects == [(0, 'kolhapur', 'state_mismatch')]


def test_match_rejects_when_the_polygon_has_no_state_code():
    sbm = [{'ulbcode': '802814', 'stcode': None}]
    matches, rejects = b.match_ulbs(sbm, [cf('pune', 'mh', census='802814')], STATES)
    assert matches == {} and rejects == [(0, 'pune', 'no_state_code')]


def test_match_ignores_blank_codes_and_trims_whitespace():
    sbm = [{'ulbcode': '', 'stcode': '27'}, {'ulbcode': ' 802814 ', 'stcode': '27'}]
    ulbs = [cf('blank', 'mh', census=''), cf('pune', 'mh', census='802814')]
    matches, _ = b.match_ulbs(sbm, ulbs, STATES)
    assert matches == {1: ('pune', 'censusCode')}


def test_lgd_state_map_covers_every_sbm_state_code():
    for code in ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '18', '20',
                 '21', '22', '23', '24', '27', '28', '29', '30', '32', '33', '34', '36', '38']:
        assert code in b.LGD_STATE_TO_CF


def test_unmatched_lists_every_ulb_with_figures_not_on_a_polygon():
    matches = {0: ('pune', 'censusCode')}
    rejects = [(1, 'kolhapur', 'state_mismatch')]
    finance = {'pune': {}, 'kolhapur': {}, 'kota': {}}
    ulbs = {'pune': cf('pune', 'mh', census='1'), 'kolhapur': cf('kolhapur', 'mh', sb='2'),
            'kota': cf('kota', 'mh')}
    un = b.unmatched(finance, matches, rejects, ulbs)
    assert un == [('kolhapur', 'state_mismatch'), ('kota', 'no_code')]


def test_unmatched_says_when_a_code_is_absent_from_sbm():
    un = b.unmatched({'x': {}}, {}, [], {'x': cf('x', 'mh', census='801')})
    assert un == [('x', 'code_not_in_sbm')]


# ── pull: batching and the per-answer cache ──────────────────────────────

def test_ulb_path_is_one_file_per_ulb_under_its_state(tmp_path):
    assert b.ulb_path(tmp_path, 'MH', PUNE) == tmp_path / 'income_statement' / 'MH' / f'{PUNE}.json'


def test_bs_is_url_asks_for_one_ulb_as_the_selected_ulb():
    # A batch answers only the selected ULB's years for every ULB in it, and
    # fills absent years with zero totals: one ULB per request.
    url = b.bs_is_url(PUNE)
    assert url.startswith(b.API + f'dashboard/city/bs-is?btnKey=incomeStatement&selectedUlb={PUNE}&ulbIds={PUNE}')
    assert url.count('ulbIds=') == 1 and url.count('years=') == len(b.YEARS)


def test_fetch_cached_skips_answers_already_on_disk(tmp_path):
    dest = tmp_path / 'a.json'
    dest.write_text(json.dumps({'cached': True}))
    calls = []
    assert b.fetch_cached('http://x', dest, getter=lambda u: calls.append(u)) is False
    assert calls == []


def test_fetch_cached_writes_atomically(tmp_path):
    dest = tmp_path / 'sub' / 'a.json'
    assert b.fetch_cached('http://x', dest, getter=lambda u: b'{"ok": 1}') is True
    assert json.loads(dest.read_text()) == {'ok': 1}
    assert not list(dest.parent.glob('*.part'))


def test_fetch_cached_refuses_a_non_json_answer(tmp_path):
    dest = tmp_path / 'a.json'
    with pytest.raises(ValueError):
        b.fetch_cached('http://x', dest, getter=lambda u: b'<html>blocked</html>')
    assert not dest.exists()


@pytest.mark.parametrize('sbm,cf_name', [
    ('MULBAGAL (TMC)', 'Mulbagal Town Municipal Council'),
    ('KOLLAM CORPORATION', 'Kollam Municipal Corporation'),
    ('NAGAR PANCHAYAT MOUDA', 'Mouda Town Panchayat'),
])
def test_name_similarity_ignores_ulb_type_words(sbm, cf_name):
    assert b.name_similarity(sbm, cf_name) >= 0.9


def test_name_similarity_flags_a_different_town():
    assert b.name_similarity('KAUP', 'Koppa Town Panchayat') < 0.6


def test_check_columns_rejects_personal_fields():
    with pytest.raises(ValueError, match='mobile'):
        b.check_columns(['tax_revenue', 'commissioner_mobile'])
