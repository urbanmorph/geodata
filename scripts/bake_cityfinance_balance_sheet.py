"""Bake cityfinance_ulb_balance_sheets: city (urban local body) balance sheets
from CityFinance.in (MoHUA; run by NIUA and Janaagraha), on the polygons of
the cityfinance_ulbs layer.

Data: CityFinance's standardised balance sheet, the JSON behind its city
dashboard (`/api/v1/dashboard/city/bs-is?btnKey=balanceSheet`), one ULB per
request (see bake_cityfinance_ulbs.bs_is_url for why). Figures are in rupees,
by National Municipal Accounts Manual (NMAM) line item, as published.

Join: by CityFinance ULB id (`cf_ulb_id`) onto the published cityfinance_ulbs
parquet, so the polygons and the code matching are exactly that layer's (Swachh
Bharat Mission ULB polygons matched to CityFinance by Census or SBM code).

Usage:
    python3 scripts/bake_cityfinance_balance_sheet.py pull [--max-minutes 50]  # cached, resumable
    python3 scripts/bake_cityfinance_balance_sheet.py bake [--out DIR]         # local formats only
    python3 scripts/bake_cityfinance_balance_sheet.py upload                   # R2, skips on md5
    python3 scripts/bake_cityfinance_balance_sheet.py register                 # patch catalog + manifest
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
import time
import urllib.parse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402
import bake_formats  # noqa: E402
from bake_cityfinance_ulbs import (  # noqa: E402
    API, ATTRIBUTION, CACHE_NAME, PAUSE_S, SOURCE, YEARS, check_columns, fetch_cached, fy_col, fy_from_key, load_master,
    log,
)
from pipeline import cache_backup  # noqa: E402

CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
RAW = ROOT / 'data' / 'raw' / 'cityfinance'

LAYER_ID = 'cityfinance_ulb_balance_sheets'
BASENAME = 'CityFinance_ULB_Balance_Sheets'
R2_PREFIX = 'economy/cityfinance-ulb-balance-sheets'
BASE_LAYER = 'cityfinance_ulbs'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'
WORKERS = 4  # modest concurrency: one answer takes a few seconds

# NMAM balance sheet codes -> column. String codes ('310-312') are CityFinance's
# summary subtotals of codes listed here and are skipped.
CODE_COLS = {
    310: 'municipal_general_fund', 311: 'earmarked_funds', 312: 'reserves',
    320: 'grants_contributions_specific_purposes',
    330: 'secured_loans', 331: 'unsecured_loans',
    340: 'deposits_received', 341: 'deposit_works', 350: 'other_liabilities_sundry_creditors',
    360: 'provisions', 300: 'liabilities_others',
    410: 'gross_block', 411: 'accumulated_depreciation', 412: 'capital_work_in_progress',
    420: 'investment_general_fund', 421: 'investment_other_funds',
    430: 'stock_in_hand', 431: 'sundry_debtors_receivables', 432: 'provisions_bad_doubtful_receivables',
    440: 'prepaid_expenses', 450: 'cash_bank_balance', 460: 'loans_advances_deposits',
    470: 'other_assets', 480: 'miscellaneous_expenditure_not_written_off', 400: 'assets_others',
}
# Totals CityFinance computes and publishes, named by their line item.
TOTAL_COLS = [
    (re.compile(r'^Total Reserves & Surplus \(I\)'), 'total_reserves_surplus'),
    (re.compile(r'^Total Grants ?, Contribution'), 'total_grants_contributions'),
    (re.compile(r'^Total Loans \(III\)'), 'total_loans'),
    (re.compile(r'^Total Current Liabilities and Provisions \(IV\)'), 'total_current_liabilities_provisions'),
    (re.compile(r'^Total Liabilities \(A\)'), 'total_liabilities'),
    (re.compile(r'^Net Block'), 'net_block'),
    (re.compile(r'^Total Fixed Assets \(I\)'), 'total_fixed_assets'),
    (re.compile(r'^Total Investments \(II\)'), 'total_investments'),
    (re.compile(r'^Net amount outstanding \(i\)'), 'net_amount_outstanding_i'),
    (re.compile(r'^Net amount outstanding \(ii\)'), 'net_amount_outstanding_ii'),
    (re.compile(r'^Total Current Assets, Loans and Advances \(III\)'), 'total_current_assets_loans_advances'),
    (re.compile(r'^Total Other Assets \(IV\)'), 'total_other_assets'),
    (re.compile(r'^Total Assets \(B\)'), 'total_assets'),
]
# The same sums again without the (A)/(B) letter: identical formulas, skipped.
DUPLICATE_TOTALS = {'Total Liabilities', 'Total Assets'}
LINE_COLS = list(CODE_COLS.values()) + [c for _, c in TOTAL_COLS]
HISTORY_COLS = ('total_assets', 'total_liabilities')

# Identity columns carried from the cityfinance_ulbs layer.
BASE_COLS = ['stnm', 'stcode', 'distnm', 'distcode', 'ulbnm', 'ulbcode', 'cf_ulb_id', 'cf_ulb_name',
             'cf_ulb_type', 'cf_state', 'cf_census_code', 'cf_sb_code', 'cf_lgd_code', 'cf_population',
             'cf_population_source', 'join_key']
TILE_FIELDS = ('ulbnm', 'cf_ulb_name', 'cf_ulb_type', 'fy', 'total_assets', 'total_liabilities',
               'municipal_general_fund', 'gross_block', 'cash_bank_balance', 'total_loans')


# ── pure helpers ─────────────────────────────────────────────────────────

def column_for(row: dict) -> str | None:
    """Output column for a balance sheet row, None for rows we do not keep;
    raises on a numeric row never seen before, so a schema change cannot slip through."""
    code, item = row.get('code'), (row.get('lineItem') or '').strip()
    if isinstance(code, int):
        if code in CODE_COLS:
            return CODE_COLS[code]
    elif code is None:
        if item in DUPLICATE_TOTALS:
            return None
        for pat, col in TOTAL_COLS:
            if pat.search(item):
                return col
    elif isinstance(code, str):
        return None
    raise ValueError(f'unknown balance sheet line item: {code!r} {item!r}')


def parse_balance_sheet(resp: dict) -> list[tuple[str, str, str, float]]:
    """(ulb_id, fy, column, rupees) for every figure in a balance sheet answer."""
    out = []
    for row in resp['data']:
        if not row.get('isNumber'):
            continue
        cells = [(k, v) for k, v in row.items()
                 if re.fullmatch(r'\d{6}_[0-9a-f]{24}', k) and isinstance(v, (int, float))]
        if not cells:
            continue
        col = column_for(row)
        if col is None:
            continue
        for k, v in cells:
            yk, ulb = k.split('_')
            out.append((ulb, fy_from_key(yk), col, v))
    return out


def balance_columns() -> list[str]:
    hist = [f'{c}_{fy_col(fy)}' for c in HISTORY_COLS for fy in YEARS]
    return ['fy', 'years_available'] + LINE_COLS + hist


def wide_rows(recs) -> dict[str, dict]:
    """One row per ULB: every line item for its latest year with a statement,
    plus total assets and liabilities for each year. A year with no NMAM line
    item is no statement (CityFinance still emits zero totals) and is skipped."""
    by = defaultdict(lambda: defaultdict(dict))
    for ulb, fy, col, v in recs:
        by[ulb][fy][col] = v
    coded = set(CODE_COLS.values())
    out = {}
    for ulb, all_years in by.items():
        years = {fy: vals for fy, vals in all_years.items() if coded & vals.keys()}
        if not years:
            continue
        latest = max(years)
        row = {'fy': latest, 'years_available': ','.join(sorted(years))}
        row.update(years[latest])
        for fy, vals in years.items():
            for c in HISTORY_COLS:
                if c in vals:
                    row[f'{c}_{fy_col(fy)}'] = vals[c]
        out[ulb] = row
    return out


def balance_sheet_url(ulb_id: str) -> str:
    q = [('btnKey', 'balanceSheet'), ('selectedUlb', ulb_id), ('ulbIds', ulb_id)]
    q += [('years', y) for y in YEARS]
    return API + 'dashboard/city/bs-is?' + urllib.parse.urlencode(q)


def bs_path(raw: Path, state: str, ulb_id: str) -> Path:
    return raw / 'balance_sheet' / state / f'{ulb_id}.json'


# ── pull ─────────────────────────────────────────────────────────────────

def plan(raw: Path) -> list[tuple[str, Path]]:
    ulbs, states = load_master(raw)
    return sorted(((balance_sheet_url(u['_id']), bs_path(raw, states.get(u['state'], 'XX'), u['_id']))
                   for u in ulbs), key=lambda j: str(j[1]))


def pull(raw: Path = RAW, max_minutes: float = 50) -> bool:
    """Fetch every answer not yet cached, each saved atomically as it arrives;
    stop cleanly at the time limit. True when everything is cached."""
    deadline = time.monotonic() + max_minutes * 60
    raw.mkdir(parents=True, exist_ok=True)
    for name, url in (('ulb.json', API + 'ulb'), ('state.json', API + 'state')):
        if fetch_cached(url, raw / name):
            log(f'fetched {name}')
    jobs = plan(raw)
    todo = [(url, path) for url, path in jobs if not path.exists()]
    log(f'{len(jobs)} ULB balance sheets, {len(jobs) - len(todo)} cached, {WORKERS} at a time')

    def one(job: tuple[str, Path]) -> str:
        url, path = job
        if time.monotonic() > deadline:
            return 'late'
        for attempt in range(3):
            try:
                fetch_cached(url, path)
                time.sleep(PAUSE_S)
                return 'ok'
            except (OSError, ValueError) as e:  # HTTP/network error or a non-JSON answer
                if attempt == 2:
                    log(f'  failed {path.parent.name}/{path.name}: {e}')
                    return 'failed'
                time.sleep(2 ** (attempt + 1))
        return 'failed'

    counts = {'ok': 0, 'failed': 0, 'late': 0}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for status in pool.map(one, todo):
            counts[status] += 1
            if counts['ok'] and status == 'ok' and counts['ok'] % 100 == 0:
                log(f'[{len(jobs) - len(todo) + counts["ok"]}/{len(jobs)}] cached, {counts["failed"]} failed this run')
    cached = sum(p.exists() for _, p in jobs)
    if counts['late']:
        log(f'time limit reached: {cached}/{len(jobs)} cached; run again to continue')
    log(f'{cached}/{len(jobs)} cached, {counts["failed"]} failed this run')
    return cached == len(jobs)


# ── bake ─────────────────────────────────────────────────────────────────

def load_balance(raw: Path) -> dict[str, dict]:
    recs = []
    for _, path in plan(raw):
        if not path.exists():
            raise SystemExit(f'missing {path.name}: run `pull` first')
        recs += parse_balance_sheet(json.loads(path.read_text()))
    return wide_rows(recs)


def write_joined_parquet(base: Path, raw: Path, out: Path) -> dict:
    """cityfinance_ulbs polygons and identity columns + balance sheet columns, by cf_ulb_id."""
    import duckdb

    balance = load_balance(raw)
    cols = balance_columns()
    types = {'cf_ulb_id': 'VARCHAR', 'fy': 'VARCHAR', 'years_available': 'VARCHAR',
             **{c: 'DOUBLE' for c in cols[2:]}}
    check_columns(BASE_COLS + list(types))
    con = duckdb.connect()
    con.execute('LOAD spatial;')
    con.execute(f"CREATE TABLE bs ({', '.join(f'{c} {t}' for c, t in types.items())})")
    con.executemany(f"INSERT INTO bs VALUES ({', '.join('?' * len(types))})",
                    [(ulb, *(row.get(c) for c in cols)) for ulb, row in balance.items()])
    con.execute(f"""COPY (
        SELECT {', '.join('p.' + c for c in BASE_COLS)}, {', '.join('b.' + c for c in cols)}, p.geometry
        FROM read_parquet('{base}', file_row_number = true) p
        LEFT JOIN bs b USING (cf_ulb_id) ORDER BY p.file_row_number
    ) TO '{out}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
    placed = {r[0] for r in con.execute(
        f"SELECT cf_ulb_id FROM read_parquet('{base}') WHERE cf_ulb_id IS NOT NULL").fetchall()}
    with_figures = con.execute(f"SELECT count(*) FROM read_parquet('{out}') WHERE fy IS NOT NULL").fetchone()[0]
    latest = defaultdict(int)
    for row in balance.values():
        latest[row['fy']] += 1
    return {
        'cf_ulbs_with_balance_sheet': len(balance),
        'polygons_with_balance_sheet': with_figures,
        'cf_ulbs_with_balance_sheet_not_on_a_polygon': len(set(balance) - placed),
        'latest_fy': dict(sorted(latest.items())),
    }


def bake(out_dir: Path, raw: Path = RAW) -> dict:
    from bake_extracts import write_kml_from_geojson
    from pipeline import rebake_flatten_bbox

    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cf_bs_') as tmp:
        tmp = Path(tmp)
        base = bake_formats.fetch_layer_file(CATALOG, BASE_LAYER, 'parquet', tmp / 'base.parquet')
        joined = tmp / 'joined.parquet'
        stats = write_joined_parquet(base, raw, joined)
        parquet = out_dir / f'{BASENAME}.parquet'
        rows, prop_cols = rebake_flatten_bbox(joined, parquet)

    con = pipeline.make_con()
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    path['geojson'].unlink(missing_ok=True)
    # Not RFC7946: GDAL's RFC7946 mode cuts invalid source polygons into
    # GeometryCollections. Geometry as published, longitude first.
    con.execute(f"COPY (SELECT * FROM read_parquet('{parquet}')) TO '{path['geojson']}' "
                "WITH (FORMAT GDAL, DRIVER 'GeoJSON')")
    write_kml_from_geojson(path['geojson'], LAYER_ID, path['kml'])
    bake_formats.shapefile_zip_from_geojson(path['geojson'], path['shapefile'],
                                            bake_formats.short_field_names(prop_cols))
    bake_formats.write_pmtiles(path['geojson'], path['pmtiles'], LAYER_ID, TILE_FIELDS)

    summary = {'rows': rows, **stats, **pipeline.sizes_and_names(path)}
    SUMMARY.write_text(json.dumps(summary, indent=2))
    return summary


# ── catalog ──────────────────────────────────────────────────────────────

TAGS = ['municipal finance', 'urban local body', 'ULB', 'city finance', 'balance sheet', 'assets',
        'liabilities', 'municipal debt', 'loans', 'reserves', 'fixed assets', 'receivables',
        'municipal corporation', 'municipality', 'nagar panchayat', 'NMAM', 'MoHUA']

CHOROPLETH = {'column': 'total_assets', 'label': 'Total assets (latest year)', 'unit': 'INR'}


def description() -> str:
    return ('Balance sheets of Indian cities (urban local bodies) from their annual accounts, as '
            'standardised by CityFinance.in (MoHUA): municipal fund and reserves, grants, loans, '
            'current liabilities, fixed assets, investments, receivables and cash, in rupees, on '
            'Swachh Bharat Mission ULB boundaries.')


def notes() -> str:
    return ('Figures from the standardised balance sheets on CityFinance.in (Ministry of Housing and Urban '
            'Affairs; run by NIUA and Janaagraha), in rupees, by National Municipal Accounts Manual line '
            'item, as published. Each polygon carries every line item for its latest year with a balance '
            'sheet (fy) and total assets and total liabilities for every year it has. Accumulated '
            'depreciation and provisions for bad debts are negative, as CityFinance publishes them. '
            'Polygons and the city matching are those of the City Finances (cityfinance_ulbs) layer: '
            'Swachh Bharat Mission ULB polygons matched to CityFinance by Census 2011 town code or SBM '
            'code, never by name; see that layer for the method and its gaps (no West Bengal polygons). '
            'Polygons with no matched city or no balance sheet carry empty figures. '
            'CityFinance states no licence; treated here as GODL-India.')


def level_meta() -> dict:
    return {'label': 'City Balance Sheets (CityFinance.in)', 'unit': 'ULBs', 'description': description()}


def catalog_entry(rows: int, sizes: dict[str, int], fetched_at: str, r2_public: str,
                  names: dict[str, str] | None = None) -> dict:
    names = names or pipeline.plain_names(BASENAME, EXT)
    entry = {'id': LAYER_ID, 'level': LAYER_ID, 'source': SOURCE, 'rows': rows,
             **pipeline.format_blocks(EXT, names, sizes, f'{r2_public}/{R2_PREFIX}')}
    entry.update({
        'licence': 'GODL-India',
        'attribution': {'primary': dict(ATTRIBUTION), 'publisher': None},
        'category': 'economy',
        'provenance': 'curated',
        'fetched_at': fetched_at,
        'notes': notes(),
        'tags': TAGS,
        'choropleth': dict(CHOROPLETH),
    })
    return entry


def manifest_entry(rows: int, sizes: dict[str, int], names: dict[str, str] | None = None) -> dict:
    names = names or pipeline.plain_names(BASENAME, EXT)
    return {
        'id': LAYER_ID, 'name': level_meta()['label'], 'level': LAYER_ID, 'category': 'economy',
        'source': SOURCE, 'description': description(), 'unit': 'ULBs', 'features': rows,
        'license': 'GODL-India', 'r2_prefix': R2_PREFIX,
        **pipeline.manifest_files(names, sizes),
        'source_url': ATTRIBUTION['url'], 'source_org': ATTRIBUTION['name'],
        'notes': notes(), 'tags': TAGS,
    }


def upload(out_dir: Path) -> dict[str, str]:
    """Upload every format to its content-versioned key (<BASENAME>.<md5[:8]>.<ext>):
    changed bytes get a new key, unchanged files keep theirs (md5-skipped)."""
    return pipeline.upload_layer(out_dir, BASENAME, EXT, R2_PREFIX)


def register(catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST,
             summary_path: Path = SUMMARY, r2_public: str | None = None) -> None:
    """Patch catalog.json + external-ingested.json in place (never rebuild the
    catalog). Idempotent: the layer keeps its place, its first fetched_at and
    any rebaked tiles (pipeline.register_layer)."""
    summary = json.loads(summary_path.read_text())
    names = pipeline.summary_names(summary)
    fetched_at = datetime.now(timezone.utc).date().isoformat()
    entry = catalog_entry(summary['rows'], summary['sizes'], fetched_at, r2_public or pipeline.R2_PUBLIC, names=names)
    pipeline.register_layer(catalog_path, manifest_path, entry,
                            manifest_entry(summary['rows'], summary['sizes'], names=names),
                            level_meta(), attribution=(SOURCE, ATTRIBUTION))


def main() -> None:
    def pull_step(a) -> None:
        with cache_backup(a.raw, CACHE_NAME):
            done = pull(a.raw, a.max_minutes)
        sys.exit(0 if done else 3)
    pipeline.step_cli(__doc__, {'pull': pull_step, 'bake': lambda a: log(json.dumps(bake(a.out, a.raw), indent=2)),
                                'upload': lambda a: upload(a.out), 'register': lambda a: register()},
                      ('--max-minutes', {'type': float, 'default': 50}), ('--raw', {'type': Path, 'default': RAW}),
                      ('--out', {'type': Path, 'default': ROOT / 'data' / 'baked' / R2_PREFIX}))


if __name__ == '__main__':
    main()
