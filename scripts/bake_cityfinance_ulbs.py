"""Bake cityfinance_ulbs: city (urban local body) income and expenditure from
CityFinance.in (MoHUA; run by NIUA and Janaagraha), on Swachh Bharat Mission
ULB polygons (the sbm_ulbs layer).

Data: CityFinance's standardised income statement, the JSON behind its city
dashboard (`/api/v1/dashboard/city/bs-is?btnKey=incomeStatement`). Figures are
in rupees, by National Municipal Accounts Manual (NMAM) line item, as
CityFinance publishes them from each ULB's annual accounts. One request carries
many ULBs and every year, so the whole country is a few dozen requests.

Join: SBM `ulbcode` is a Census 2011 town code (80xxxx) or an SBM code for
newer ULBs (90xxxx). It is matched to CityFinance `censusCode`, then `sbCode`
(never by name), and a match is kept only when the polygon's state (LGD code)
agrees with CityFinance's state. Every CityFinance ULB with figures that lands
on no polygon is listed in data/cityfinance_ulbs.unmatched.csv with the reason.

Usage:
    python3 scripts/bake_cityfinance_ulbs.py pull [--max-minutes 20]   # cached, resumable
    python3 scripts/bake_cityfinance_ulbs.py bake [--out DIR]          # local formats only
    python3 scripts/bake_cityfinance_ulbs.py register                  # patch catalog + manifest
"""
from __future__ import annotations

import argparse
import csv
import difflib
import json
import os
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402
import bake_formats  # noqa: E402
from build_catalog import ATTR  # noqa: E402
from pipeline import cache_backup, is_client_error, log, make_con, with_retries  # noqa: E402

CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
RAW = ROOT / 'data' / 'raw' / 'cityfinance'
CACHE_NAME = 'cityfinance'  # R2 cache/cityfinance/: both CityFinance bakes share RAW

LAYER_ID = 'cityfinance_ulbs'
BASENAME = 'CityFinance_ULBs'
R2_PREFIX = 'economy/cityfinance-ulbs'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
# Outside data/baked/: upload_baked.py mirrors that whole tree to the public bucket.
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'
UNMATCHED = ROOT / 'data' / f'{LAYER_ID}.unmatched.csv'
REVIEW = ROOT / 'data' / f'{LAYER_ID}.name_review.csv'
SBM_CODE_ERRORS = ROOT / 'data' / f'{LAYER_ID}.sbm_code_errors.csv'
CF_LOCATION_OFF = ROOT / 'data' / f'{LAYER_ID}.cityfinance_location_off.csv'

API = 'https://www.cityfinance.in/api/v1/'
USER_AGENT = 'Mozilla/5.0 (bharatlas data pull)'
YEARS = ['2015-16', '2016-17', '2017-18', '2018-19', '2019-20', '2020-21',
         '2021-22', '2022-23', '2023-24', '2024-25']
PAUSE_S = 0.2

SBM_COLS = ['stnm', 'stcode', 'distnm', 'distcode', 'ulbnm', 'ulbcode']

# NMAM income-statement codes -> column. Subtotal rows ('120-150' etc.) are
# CityFinance's sums of codes listed here and are skipped.
CODE_COLS = {
    110: 'tax_revenue', 120: 'assigned_revenue', 130: 'rental_income',
    140: 'fee_user_charges', 150: 'sale_hire_charges', 160: 'revenue_grants',
    170: 'income_from_investment', 171: 'interest_earned', 180: 'other_income',
    100: 'income_others',
    210: 'establishment_exp', 220: 'administrative_exp', 230: 'operation_maintenance_exp',
    240: 'interest_finance_exp', 250: 'programme_exp', 260: 'revenue_grants_exp',
    270: 'provisions_write_off', 271: 'miscellaneous_exp', 272: 'depreciation',
    200: 'expenditure_others',
    280: 'prior_period_items', 290: 'transfer_to_reserve_funds',
}
# Totals CityFinance computes and publishes, named by their line item.
TOTAL_COLS = [
    (re.compile(r'^Total Income \(A\)'), 'total_income'),
    (re.compile(r'^Total Expenditure ?\(B\)'), 'total_expenditure'),
    (re.compile(r'before Prior Period Items \(C\)'), 'surplus_before_prior_period'),
    (re.compile(r'after Prior Period Items item ?\(D\)'), 'surplus_after_prior_period'),
    (re.compile(r'^Net Surplus/\(Deficit\) carried over \(E\)'), 'net_surplus'),
]
LINE_COLS = list(CODE_COLS.values()) + [c for _, c in TOTAL_COLS]
HISTORY_COLS = ('total_income', 'total_expenditure')

# LGD state code (SBM stcode) -> CityFinance state code.
LGD_STATE_TO_CF = {
    '1': 'JK', '2': 'HP', '3': 'PB', '4': 'CH', '5': 'UK', '6': 'HR', '7': 'DL', '8': 'RJ',
    '9': 'UP', '10': 'BR', '11': 'SK', '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ',
    '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH', '21': 'OD', '22': 'CG',
    '23': 'MP', '24': 'GJ', '27': 'MH', '28': 'AP', '29': 'KA', '30': 'GA', '31': 'LD',
    '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TS', '37': 'LDK', '38': 'DN',
}

PERSONAL = re.compile(r'mobile|phone|email|e_mail|aadhaar|commissioner|officer|contact', re.I)

TILE_FIELDS = ('ulbnm', 'cf_ulb_name', 'cf_ulb_type', 'fy', 'total_income', 'total_expenditure',
               'tax_revenue', 'fee_user_charges', 'revenue_grants', 'establishment_exp')

SOURCE = 'CityFinance'
ATTRIBUTION = ATTR[SOURCE]


# ── pure helpers ─────────────────────────────────────────────────────────

def fy_from_key(k: str) -> str:
    """'202324' -> '2023-24' (CityFinance's year key)."""
    return f'{k[:4]}-{k[4:6]}'


def fy_col(fy: str) -> str:
    return fy.replace('-', '_')


def column_for(row: dict) -> str | None:
    """Output column for a bs-is row, None for rows we do not keep; raises on
    a numeric row we have never seen so a schema change cannot slip through."""
    code, item = row.get('code'), row.get('lineItem') or ''
    if isinstance(code, int):
        if code in CODE_COLS:
            return CODE_COLS[code]
    elif code is None:
        for pat, col in TOTAL_COLS:
            if pat.search(item):
                return col
    elif isinstance(code, str):
        return None  # CityFinance subtotal of codes we keep, e.g. '120-150'
    raise ValueError(f'unknown income statement line item: {code!r} {item!r}')


def parse_income_statement(resp: dict) -> list[tuple[str, str, str, float]]:
    """(ulb_id, fy, column, rupees) for every figure in a bs-is answer."""
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


def finance_columns() -> list[str]:
    hist = [f'{c}_{fy_col(fy)}' for c in HISTORY_COLS for fy in YEARS]
    return ['fy', 'years_available'] + LINE_COLS + hist


def wide_rows(recs) -> dict[str, dict]:
    """One row per ULB: every line item for its latest year with figures,
    plus total income and expenditure for each year. A year with no NMAM line
    item is no statement (CityFinance still emits its totals, as 0) and is skipped."""
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


def _code(v) -> str:
    return str(v or '').strip()


def match_ulbs(sbm_rows: list[dict], cf_ulbs: list[dict], cf_state_code: dict[str, str]):
    """Match SBM polygons to CityFinance ULBs on censusCode, then sbCode.
    Returns ({sbm_index: (cf_id, key)}, [(sbm_index, cf_id, reason)])."""
    index = {key: {_code(u.get(key)): u for u in cf_ulbs if _code(u.get(key))}
             for key in ('censusCode', 'sbCode')}
    matches, rejects = {}, []
    for i, r in enumerate(sbm_rows):
        code = _code(r.get('ulbcode'))
        if not code:
            continue
        for key in ('censusCode', 'sbCode'):
            u = index[key].get(code)
            if u is None:
                continue
            st = _code(r.get('stcode'))
            if not st:
                rejects.append((i, u['_id'], 'no_state_code'))
            elif LGD_STATE_TO_CF.get(st) != cf_state_code.get(u['state']):
                rejects.append((i, u['_id'], 'state_mismatch'))
            else:
                matches[i] = (u['_id'], key)
            break
    return matches, rejects


MAX_KM = 2.0  # how far CityFinance's point may sit outside the matched polygon


NAME_AGREES = 0.6  # name_similarity at or above which SBM's and CityFinance's names corroborate a code


def check_locations(con, src: str, matches: dict, by_id: dict, max_km: float = MAX_KM):
    """Corroborate each code match with a second, independent signal: CityFinance's
    own point for the ULB on (or within max_km of) the SBM polygon, or the two
    names agreeing. A match fails only when both fail: then SBM's code points at
    another town (Chamarajanagar's polygon carries Yelandur's code).
    A far point with agreeing names is CityFinance's geocoding (Akola placed at
    Akole), kept and reported. Returns (kept, dropped, cf_location_off):
    dropped = [(sbm_index, cf_id, reason, distance_km)],
    cf_location_off = [(sbm_index, cf_id, distance_km)]."""
    rows = con.execute(f'SELECT file_row_number, ulbnm, ST_AsWKB(geometry) FROM {src}').fetchall()
    sbm = {i: (name, wkb) for i, name, wkb in rows}
    kept, dropped, cf_off = {}, [], []
    for i, (cf_id, key) in matches.items():
        u = by_id.get(cf_id, {})
        name_ok = name_similarity(sbm[i][0] or '', u.get('name') or '') >= NAME_AGREES
        loc = u.get('location') or {}
        try:
            lat, lng = float(loc['lat']), float(loc['lng'])
        except (KeyError, TypeError, ValueError):
            if name_ok:
                kept[i] = (cf_id, key)
            else:
                dropped.append((i, cf_id, 'no_coordinates_and_name_differs', None))
            continue
        # degrees -> km (overstates east-west a little: errs toward a failed location check)
        km = con.execute('SELECT ST_Distance(ST_GeomFromWKB(?), ST_Point(?, ?))',
                         [sbm[i][1], lng, lat]).fetchone()[0] * 111.32
        if km <= max_km:
            kept[i] = (cf_id, key)
        elif name_ok:
            kept[i] = (cf_id, key)
            cf_off.append((i, cf_id, round(km, 1)))
        else:
            dropped.append((i, cf_id, 'far_and_name_differs', round(km, 1)))
    return kept, dropped, cf_off


def unmatched(finance: dict, matches: dict, rejects: list, ulbs: dict) -> list[tuple[str, str]]:
    """Every ULB with figures that is on no polygon, with the reason."""
    placed = {cf_id for cf_id, _ in matches.values()}
    rejected = {cf_id: reason for _, cf_id, reason in rejects}
    out = []
    for cf_id in sorted(finance):
        if cf_id in placed:
            continue
        u = ulbs.get(cf_id, {})
        if cf_id in rejected:
            reason = rejected[cf_id]
        elif not (_code(u.get('censusCode')) or _code(u.get('sbCode'))):
            reason = 'no_code'
        else:
            reason = 'code_not_in_sbm'
        out.append((cf_id, reason))
    return out


def check_columns(cols: list[str]) -> None:
    bad = [c for c in cols if PERSONAL.search(c)]
    if bad:
        raise ValueError(f'personal fields must never be published: {bad}')


def bs_is_url(ulb_id: str) -> str:
    """One ULB per request. The endpoint takes many ulbIds, but then answers
    only the selected ULB's years for all of them and fills the other years
    with zero totals, so batching silently loses and invents years."""
    q = [('btnKey', 'incomeStatement'), ('selectedUlb', ulb_id), ('ulbIds', ulb_id)]
    q += [('years', y) for y in YEARS]
    return API + 'dashboard/city/bs-is?' + urllib.parse.urlencode(q)


def http_get(url: str, wait: Callable[[int], None] | None = None) -> bytes:
    """GET with retries (backoff) on network errors and cut-off answers."""
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})

    def once() -> bytes:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()
    return with_retries(once, 4, wait, give_up=is_client_error)


def fetch_cached(url: str, dest: Path, getter: Callable[[str], bytes] = http_get) -> bool:
    """Save one answer as it arrives (atomically). Returns False when it was
    already cached, so a second run does no new work."""
    if dest.exists():
        return False
    body = getter(url)
    json.loads(body)  # refuse an HTML block page or a truncated answer
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + '.part')
    part.write_bytes(body)
    os.replace(part, dest)
    return True


ULB_TYPE_WORDS = re.compile(
    r'\b(municipal|municipality|muncipal|corporation|council|town|nagar panchayat|nagarpanchayat|'
    r'panchayat|nagar palika|parishad|cantonment|board|cantt|notified area|committee|city|greater)\b')


def name_similarity(a: str, b: str) -> float:
    """For the review list only; never used to match."""
    def clean(s):
        s = ULB_TYPE_WORDS.sub(' ', re.sub(r'\(.*?\)', '', (s or '').lower()))
        return re.sub(r'[^a-z]', '', s)
    return difflib.SequenceMatcher(None, clean(a), clean(b)).ratio()


# ── pull ─────────────────────────────────────────────────────────────────

def ulb_path(raw: Path, state: str, ulb_id: str) -> Path:
    return raw / 'income_statement' / state / f'{ulb_id}.json'


def load_master(raw: Path) -> tuple[list[dict], dict[str, str]]:
    ulbs = json.loads((raw / 'ulb.json').read_text())['data']
    states = {s['_id']: s['code'] for s in json.loads((raw / 'state.json').read_text())['data']}
    return ulbs, states


def plan(raw: Path) -> list[tuple[str, Path]]:
    ulbs, states = load_master(raw)
    return sorted(((bs_is_url(u['_id']), ulb_path(raw, states.get(u['state'], 'XX'), u['_id']))
                   for u in ulbs), key=lambda j: str(j[1]))


def pull(raw: Path = RAW, max_minutes: float = 20) -> bool:
    """Fetch every answer not yet cached, each saved as it arrives; stop
    cleanly at the time limit. Returns True when everything is cached."""
    deadline = time.monotonic() + max_minutes * 60
    raw.mkdir(parents=True, exist_ok=True)
    for name, url in (('ulb.json', API + 'ulb'), ('state.json', API + 'state')):
        if fetch_cached(url, raw / name):
            log(f'fetched {name}')
    jobs = plan(raw)
    done = sum(p.exists() for _, p in jobs)
    failed = 0
    log(f'{len(jobs)} ULB income statements, {done} cached')
    for url, path in jobs:
        if path.exists():
            continue
        if time.monotonic() > deadline:
            log(f'time limit reached: {done}/{len(jobs)} cached; run again to continue')
            return False
        try:
            fetch_cached(url, path)
            done += 1
        except (OSError, ValueError) as e:  # HTTP/network error or a non-JSON answer
            failed += 1
            log(f'  failed {path.parent.name}/{path.name}: {e}')
        if done % 100 == 0:
            log(f'[{done}/{len(jobs)}] cached, {failed} failed this run')
        time.sleep(PAUSE_S)
    log(f'{done}/{len(jobs)} cached, {failed} failed this run')
    return failed == 0


# ── bake ─────────────────────────────────────────────────────────────────

def load_finance(raw: Path) -> dict[str, dict]:
    recs = []
    for url, path in plan(raw):
        if not path.exists():
            raise SystemExit(f'missing {path.name}: run `pull` first')
        recs += parse_income_statement(json.loads(path.read_text()))
    return wide_rows(recs)


def write_joined_parquet(sbm: Path, raw: Path, out: Path) -> dict:
    ulbs, states = load_master(raw)
    by_id = {u['_id']: u for u in ulbs}
    finance = load_finance(raw)

    con = make_con()
    src = f"read_parquet('{sbm}', file_row_number = true)"
    sbm_rows = [dict(zip(SBM_COLS, r)) for r in con.execute(
        f"SELECT {', '.join(SBM_COLS)} FROM {src} ORDER BY file_row_number").fetchall()]
    matches, rejects = match_ulbs(sbm_rows, ulbs, states)
    # Codes can point at another town in SBM: keep a match only where
    # CityFinance's own point for the ULB is on the polygon.
    matches, loc_dropped, cf_off = check_locations(con, src, matches, by_id)
    rejects += [(i, cf_id, f'sbm_code_{why}') for i, cf_id, why, _ in loc_dropped]
    with CF_LOCATION_OFF.open('w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['sbm_ulbcode', 'sbm_name', 'cf_ulb_name', 'cf_lat', 'cf_lng', 'distance_km'])
        for i, cf_id, km in sorted(cf_off, key=lambda x: -x[2]):
            loc = by_id[cf_id].get('location') or {}
            w.writerow([sbm_rows[i]['ulbcode'], sbm_rows[i]['ulbnm'], by_id[cf_id].get('name'),
                        loc.get('lat'), loc.get('lng'), km])
    with SBM_CODE_ERRORS.open('w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['sbm_ulbcode', 'sbm_name', 'sbm_state', 'cf_ulb_name_for_that_code', 'reason', 'distance_km'])
        for i, cf_id, why, km in sorted(loc_dropped, key=lambda x: (x[2], -(x[3] or 0))):
            r = sbm_rows[i]
            w.writerow([r['ulbcode'], r['ulbnm'], r['stnm'], by_id.get(cf_id, {}).get('name'), why, km])

    fin_cols = finance_columns()
    cf_types = {'cf_ulb_id': 'VARCHAR', 'cf_ulb_name': 'VARCHAR', 'cf_ulb_type': 'VARCHAR',
                'cf_state': 'VARCHAR', 'cf_census_code': 'VARCHAR', 'cf_sb_code': 'VARCHAR',
                'cf_lgd_code': 'VARCHAR', 'cf_population': 'BIGINT', 'cf_population_source': 'VARCHAR',
                'join_key': 'VARCHAR'}
    types = {'sbm_row': 'BIGINT', **cf_types, 'fy': 'VARCHAR', 'years_available': 'VARCHAR',
             **{c: 'DOUBLE' for c in fin_cols[2:]}}
    check_columns(SBM_COLS + list(types))
    rows = []
    for i in range(len(sbm_rows)):
        cf_id, key = matches.get(i, (None, None))
        u = by_id.get(cf_id, {})
        f = finance.get(cf_id, {})
        rows.append((i, cf_id, u.get('name'), (u.get('ulbType') or {}).get('name'),
                     states.get(u.get('state')), _code(u.get('censusCode')) or None,
                     _code(u.get('sbCode')) or None, _code(u.get('lgdCode')) or None,
                     u.get('population'), u.get('population_source'), key,
                     *(f.get(c) for c in fin_cols)))
    con.execute(f"CREATE TABLE fin ({', '.join(f'{c} {t}' for c, t in types.items())})")
    con.executemany(f"INSERT INTO fin VALUES ({', '.join('?' * len(types))})", rows)
    con.execute(f"""COPY (
        SELECT {', '.join('s.' + c for c in SBM_COLS)}, {', '.join('f.' + c for c in list(types)[1:])}, s.geometry
        FROM (SELECT *, file_row_number AS sbm_row FROM {src}) s
        JOIN fin f USING (sbm_row) ORDER BY s.sbm_row
    ) TO '{out}' (FORMAT PARQUET, COMPRESSION ZSTD)""")

    un = unmatched(finance, matches, rejects, by_id)
    with UNMATCHED.open('w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['cf_ulb_id', 'cf_ulb_name', 'cf_state', 'census_code', 'sb_code', 'reason', 'fy'])
        for cf_id, reason in un:
            u = by_id.get(cf_id, {})
            w.writerow([cf_id, u.get('name'), states.get(u.get('state')), _code(u.get('censusCode')),
                        _code(u.get('sbCode')), reason, finance[cf_id]['fy']])
    review = []
    for i, (cf_id, key) in sorted(matches.items()):
        s = name_similarity(sbm_rows[i]['ulbnm'], by_id[cf_id]['name'])
        if s < 0.6:
            review.append([sbm_rows[i]['ulbcode'], sbm_rows[i]['ulbnm'], by_id[cf_id]['name'], key, round(s, 2)])
    with REVIEW.open('w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['ulbcode', 'sbm_name', 'cf_name', 'join_key', 'name_similarity'])
        w.writerows(review)

    placed = {cf_id for cf_id, _ in matches.values()}
    return {
        'sbm_polygons': len(sbm_rows),
        'cf_ulbs': len(ulbs),
        'cf_ulbs_with_figures': len(finance),
        'polygons_matched': len(matches),
        'polygons_matched_by': {k: sum(1 for _, kk in matches.values() if kk == k) for k in ('censusCode', 'sbCode')},
        'polygons_with_figures': sum(1 for cf_id, _ in matches.values() if cf_id in finance),
        'cf_ulbs_with_figures_placed': len(placed & set(finance)),
        'rejected_matches': dict(Counter(rr for *_, rr in rejects)),
        'unmatched_with_figures': dict(Counter(r for _, r in un)),
        'low_name_similarity_matches': len(review),
        'latest_fy': dict(sorted(Counter(f['fy'] for f in finance.values()).items())),
    }


def bake(out_dir: Path, raw: Path = RAW) -> dict:
    from pipeline import rebake_flatten_bbox

    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cityfinance_') as tmp:
        tmp = Path(tmp)
        sbm = bake_formats.fetch_layer_file(CATALOG, 'sbm_ulbs', 'parquet', tmp / 'sbm_ulbs.parquet')
        joined = tmp / 'joined.parquet'
        stats = write_joined_parquet(sbm, raw, joined)
        parquet = out_dir / f'{BASENAME}.parquet'
        rows, prop_cols = rebake_flatten_bbox(joined, parquet)

    con = make_con()
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    files = bake_formats.write_all_formats(con, path, LAYER_ID, prop_cols, TILE_FIELDS)

    summary = {'rows': rows, **stats, **files}
    SUMMARY.write_text(json.dumps(summary, indent=2))
    return summary


# ── catalog ──────────────────────────────────────────────────────────────

TAGS = ['municipal finance', 'urban local body', 'ULB', 'city finance', 'property tax', 'tax revenue',
        'own revenue', 'income statement', 'expenditure', 'municipal corporation', 'municipality',
        'nagar panchayat', 'NMAM', 'MoHUA']


def description() -> str:
    return ('Income and expenditure of Indian cities (urban local bodies) from their annual accounts, '
            'as standardised by CityFinance.in (MoHUA): tax revenue, fees and user charges, grants, '
            'establishment and operation costs, totals and surplus, in rupees, on Swachh Bharat '
            'Mission ULB boundaries.')


def notes() -> str:
    return ('Figures from the standardised income statements on CityFinance.in (Ministry of Housing and '
            'Urban Affairs; run by NIUA and Janaagraha), in rupees, by National Municipal Accounts Manual '
            'line item, as published. Each polygon carries every line item for its latest year with '
            'figures (fy) and total income and expenditure for every year it has (2015-16 to 2023-24; '
            'few cities have 2017-18 or 2018-19). Tax revenue includes property tax; '
            'CityFinance does not publish it separately here. Cities are matched to Swachh Bharat Mission '
            'ULB polygons by Census 2011 town code or SBM code, never by name, and only when the states '
            'agree; each match must also be corroborated by CityFinance\'s own location for the city '
            'falling on (or within 2 km of) the polygon, or by the two names agreeing. Some SBM codes point '
            'at another town; a match failing both checks is left out. Both names are kept '
            '(ulbnm from SBM, cf_ulb_name from CityFinance); where they differ, SBM\'s label is the one '
            'that is off (e.g. Bapatla\'s polygon is named GUNTUR in SBM). Cities with '
            'figures but no polygon (including all of West Bengal, which SBM does not map) are not shown. '
            'CityFinance states no licence; treated here as GODL-India.')


def level_meta() -> dict:
    return {'label': 'City Finances (CityFinance.in)', 'unit': 'ULBs', 'description': description()}


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
    catalog). Idempotent: the layer keeps its place and first fetched_at."""
    summary = json.loads(summary_path.read_text())
    names = pipeline.summary_names(summary)
    entry = catalog_entry(summary['rows'], summary['sizes'], pipeline.now_iso(), r2_public or pipeline.R2_PUBLIC,
                          names=names)
    pipeline.register_layer(catalog_path, manifest_path, entry,
                            manifest_entry(summary['rows'], summary['sizes'], names=names),
                            level_meta(), attribution=(SOURCE, ATTRIBUTION))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['pull', 'bake', 'upload', 'register'])
    ap.add_argument('--max-minutes', type=float, default=20)
    ap.add_argument('--out', type=Path, default=ROOT / 'data' / 'baked' / R2_PREFIX)
    a = ap.parse_args()
    if a.step == 'pull':
        with cache_backup(RAW, CACHE_NAME):
            done = pull(max_minutes=a.max_minutes)
        sys.exit(0 if done else 3)
    elif a.step == 'bake':
        log(json.dumps(bake(a.out), indent=2))
    elif a.step == 'upload':
        upload(a.out)
    else:
        register()


if __name__ == '__main__':
    main()
