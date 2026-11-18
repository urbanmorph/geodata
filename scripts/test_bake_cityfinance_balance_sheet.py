"""Tests for scripts/bake_cityfinance_balance_sheet.py.

Pure helpers only: pull and bake need the network and the cached CityFinance
answers under data/raw/cityfinance/balance_sheet/.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_cityfinance_balance_sheet.py -q
"""
from __future__ import annotations

import sys
import urllib.parse
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_cityfinance_balance_sheet as b  # noqa: E402

MYSORE = '5dd006d4ffbcc50cfd92c87c'


def bs_response(cells: dict[tuple, dict[str, float]]) -> dict:
    """A bs-is balance sheet answer shaped like CityFinance's."""
    rows = [{'code': None, 'isHeader': False, 'lineItem': None, 'isState': True,
             f'202223_{MYSORE}': 'Mysore Municipal Corporation'},
            {'code': None, 'isHeader': True, 'lineItem': 'A. Liabilities'}]
    for (code, item), vals in cells.items():
        row = {'code': code, 'isNumber': True, 'lineItem': item}
        row.update(vals)
        rows.append(row)
    return {'success': True, 'data': rows}


def test_parse_keeps_published_rupee_figures_per_ulb_and_year():
    resp = bs_response({
        (310, 'Municipal (General) Fund'): {f'202122_{MYSORE}': -555425641, f'202223_{MYSORE}': 604137214},
        (None, 'Total Assets (B)'): {f'202223_{MYSORE}': 20677738391},
    })
    assert sorted(b.parse_balance_sheet(resp)) == sorted([
        (MYSORE, '2021-22', 'municipal_general_fund', -555425641),
        (MYSORE, '2022-23', 'municipal_general_fund', 604137214),
        (MYSORE, '2022-23', 'total_assets', 20677738391),
    ])


def test_parse_skips_summary_subtotals_and_unlettered_duplicate_totals():
    resp = bs_response({
        ('310-312', 'Reserves & Surplus'): {f'202223_{MYSORE}': 5},
        (None, 'Total Liabilities'): {f'202223_{MYSORE}': 7},
        (None, 'Total Assets'): {f'202223_{MYSORE}': 7},
    })
    assert b.parse_balance_sheet(resp) == []


def test_parse_skips_line_items_without_figures():
    assert b.parse_balance_sheet(bs_response({(331, 'Unsecured Loans'): {}})) == []


def test_parse_fails_loudly_on_an_unknown_line_item():
    with pytest.raises(ValueError, match='Something New'):
        b.parse_balance_sheet(bs_response({(999, 'Something New'): {f'202223_{MYSORE}': 1}}))


@pytest.mark.parametrize('item,col', [
    ('Total Reserves & Surplus (I)', 'total_reserves_surplus'),
    ('Total Grants , Contribution for specific purposes (II)', 'total_grants_contributions'),
    ('Total Loans (III)', 'total_loans'),
    ('Total Current Liabilities and Provisions (IV)', 'total_current_liabilities_provisions'),
    ('Total Liabilities (A)', 'total_liabilities'),
    ('Net Block', 'net_block'),
    ('Total Fixed Assets (I)', 'total_fixed_assets'),
    ('Total Investments (II)', 'total_investments'),
    ('Net amount outstanding (i)', 'net_amount_outstanding_i'),
    ('Net amount outstanding (ii)', 'net_amount_outstanding_ii'),
    ('Total Current Assets, Loans and Advances (III)', 'total_current_assets_loans_advances'),
    ('Total Other Assets (IV)', 'total_other_assets'),
    ('Total Assets (B)', 'total_assets'),
])
def test_totals_are_named_from_their_line_item(item, col):
    resp = bs_response({(None, item): {f'202223_{MYSORE}': 7}})
    assert b.parse_balance_sheet(resp) == [(MYSORE, '2022-23', col, 7)]


def test_every_nmam_code_has_its_own_column():
    assert len(set(b.CODE_COLS.values())) == len(b.CODE_COLS)
    assert not set(b.CODE_COLS.values()) & {c for _, c in b.TOTAL_COLS}


def test_wide_rows_take_the_latest_year_and_keep_totals_for_every_year():
    recs = [(MYSORE, '2021-22', 'municipal_general_fund', 1), (MYSORE, '2021-22', 'total_assets', 10),
            (MYSORE, '2022-23', 'municipal_general_fund', 2), (MYSORE, '2022-23', 'total_assets', 20),
            (MYSORE, '2022-23', 'total_liabilities', 20)]
    row = b.wide_rows(recs)[MYSORE]
    assert row['fy'] == '2022-23'
    assert row['years_available'] == '2021-22,2022-23'
    assert row['municipal_general_fund'] == 2
    assert row['total_assets_2021_22'] == 10 and row['total_assets_2022_23'] == 20
    assert row['total_liabilities_2022_23'] == 20


def test_wide_rows_drop_years_with_only_computed_totals():
    # CityFinance emits zero totals for a year with no statement.
    recs = [(MYSORE, '2023-24', 'total_assets', 0), (MYSORE, '2022-23', 'gross_block', 5)]
    row = b.wide_rows(recs)[MYSORE]
    assert row['fy'] == '2022-23' and row['years_available'] == '2022-23'


def test_columns_are_stable_and_cover_every_year():
    cols = b.balance_columns()
    assert cols[:2] == ['fy', 'years_available']
    assert 'total_assets_2015_16' in cols and 'total_liabilities_2024_25' in cols
    assert len(cols) == len(set(cols))


def test_url_asks_for_the_balance_sheet_of_one_ulb():
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(b.balance_sheet_url(MYSORE)).query)
    assert q['btnKey'] == ['balanceSheet']
    assert q['selectedUlb'] == [MYSORE] and q['ulbIds'] == [MYSORE]
    assert q['years'] == b.YEARS


def test_answers_are_cached_one_file_per_ulb_under_its_state(tmp_path):
    assert b.bs_path(tmp_path, 'KA', MYSORE) == tmp_path / 'balance_sheet' / 'KA' / f'{MYSORE}.json'


def test_choropleth_hint_points_at_a_real_rupee_column():
    hint = b.catalog_entry(10, {f: 1 for f in b.EXT}, '2026-11-17', 'https://r2')['choropleth']
    assert hint['column'] in b.balance_columns()
    assert hint['unit'] == 'INR'


def test_catalog_entry_is_economy_with_godl_and_every_format():
    e = b.catalog_entry(3368, {f: i + 1 for i, f in enumerate(b.EXT)}, '2026-11-17', 'https://r2')
    assert e['id'] == 'cityfinance_ulb_balance_sheets' and e['category'] == 'economy'
    assert e['licence'] == 'GODL-India' and e['fetched_at'] == '2026-11-17'
    for fmt, ext in b.EXT.items():
        assert e[fmt]['url'] == f'https://r2/{b.R2_PREFIX}/{b.BASENAME}.{ext}'
