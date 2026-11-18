#!/usr/bin/env python3
"""
Bake mgnrega_districts: MGNREGA spending, wages and work per LGD district.

Source: "District-wise MGNREGA Data at a Glance" (Ministry of Rural
Development), data.gov.in resource ee03643a-ee4c-48c2-ac30-9f2ff26ab722,
GODL-India. Rows are cumulative year-to-date snapshots, several a month, so a
financial year's figure is its latest snapshot (the largest Total_Exp).

The layer: every lgd_districts polygon, with the latest complete financial
year's 36 source columns (unedited, numbers cast to numbers) plus total
expenditure for each year since 2018-19 (exp_2018_19 ...).

NREGA district names are matched to LGD within the state after normalising;
renames and spelling differences use hand-checked tables (CODE_ALIASES is
vendored from the rural Land Ledger pipeline, nature-credit/pull_mgnrega.py).
Unmatched NREGA districts are listed in the layer notes, never dropped silently.

Pull: data.gov.in API (key OGD_API_KEY, else ~/Projects/rural/shc/.env; never
printed). Every page is cached as it arrives under data/raw/mgnrega/, so a
stopped run resumes and a second run fetches nothing (--refresh refetches).

Usage:
    python3 -u scripts/bake_mgnrega_districts.py pull [--refresh]
    python3 -u scripts/bake_mgnrega_districts.py bake
    python3 -u scripts/bake_mgnrega_districts.py upload      # md5-skip uploads to R2
    python3 -u scripts/bake_mgnrega_districts.py register    # patch catalog + manifest
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import (  # noqa: E402,F401  (re-exported for bake_state_finance)
    atomic_output,
    cache_backup,
    log,
    make_con,
    with_retries,
)

RESOURCE = 'ee03643a-ee4c-48c2-ac30-9f2ff26ab722'
API = f'https://api.data.gov.in/resource/{RESOURCE}'
ENV_FILE = Path.home() / 'Projects/rural/shc/.env'
RAW = ROOT / 'data' / 'raw' / 'mgnrega'
LIMIT = 5000
YEAR = '2025-2026'                    # latest complete financial year (snapshot runs to March 2026)
LAYER_ID = 'mgnrega_districts'
BASENAME = 'MGNREGA_Districts_2025_26'
R2_PREFIX = 'economy/mgnrega-districts'
CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
OUT_DIR = ROOT / 'data' / 'baked' / R2_PREFIX
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
CATEGORY = ('economy', 'Economy & finance')
SOURCE = 'MoRD'
ATTRIBUTION = {'name': 'Ministry of Rural Development (MGNREGA), via data.gov.in',
               'url': 'https://www.data.gov.in/'}
# Popup fields only: many tile attributes make tippecanoe drop polygons at low zoom.
TILE_FIELDS = ('dtname', 'stname', 'fin_year', 'Total_Exp', 'Wages', 'Total_Households_Worked',
               'Average_days_of_employment_provided_per_Household', 'Women_Persondays',
               'percent_of_NRM_Expenditure')
TREND_FIELDS = ['fin_year', 'month', 'state_name', 'district_code', 'district_name', 'Total_Exp']

Fetcher = Callable[[int, int, dict], dict]


# ── pull ─────────────────────────────────────────────────────────────────────

def api_key() -> str:
    if os.environ.get('OGD_API_KEY'):
        return os.environ['OGD_API_KEY']
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith('OGD_API_KEY='):
            return line.split('=', 1)[1].strip().strip('"\'')
    raise SystemExit('no OGD_API_KEY in the environment or ~/Projects/rural/shc/.env')


def api_fetch(fields: list[str] | None = None, tries: int = 6) -> Fetcher:
    key = api_key()

    def fetch(offset: int, limit: int, filters: dict) -> dict:
        q = {'api-key': key, 'format': 'json', 'offset': offset, 'limit': limit,
             **{f'filters[{k}]': v for k, v in filters.items()}}
        if fields:
            q['fields'] = ','.join(fields)
        req = urllib.request.Request(f'{API}?{urllib.parse.urlencode(q)}', headers={'User-Agent': 'curl/8'})

        def once() -> dict:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        return with_retries(once, tries)
    return fetch


def pull_pages(cache: Path, filters: dict, fetch: Fetcher, limit: int = LIMIT, refresh: bool = False) -> list[dict]:
    """All records for `filters`, one cached gzip page per offset (saved as it
    arrives). A rerun reads the cache and asks the API only for the total."""
    cache.mkdir(parents=True, exist_ok=True)
    total = int(fetch(0, 1, filters)['total'])
    records: list[dict] = []
    for offset in range(0, total, limit):
        page = cache / f'offset_{offset:07d}.json.gz'
        if refresh or not page.exists():
            recs = fetch(offset, limit, filters)['records']
            with atomic_output(page) as part:
                part.write_bytes(gzip.compress(json.dumps(recs).encode(), mtime=0))
            log(f'  {cache.name}: rows {offset:,}-{offset + len(recs):,} of {total:,}')
        records.extend(json.loads(gzip.decompress(page.read_bytes())))
    return records


# ── year end: the latest cumulative snapshot per district ────────────────────

def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def year_end(rows: list[dict]) -> list[dict]:
    """One row per (fin_year, district_code): the snapshot with the largest
    Total_Exp (the figures are cumulative within the year). Numbers cast."""
    best: dict[tuple, dict] = {}
    for r in rows:
        k = (r.get('fin_year'), r.get('district_code'))
        if k not in best or (num(r.get('Total_Exp')) or 0) > (num(best[k].get('Total_Exp')) or 0):
            best[k] = r
    out = []
    for r in best.values():
        out.append({c: (num(v) if num(v) is not None and c not in TEXT_COLS else v) for c, v in r.items()})
    return out


TEXT_COLS = {'fin_year', 'month', 'state_code', 'state_name', 'district_code', 'district_name', 'Remarks'}


# ── NREGA -> LGD matching ────────────────────────────────────────────────────

def norm(s: str) -> str:
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii', 'ignore').decode().lower()
    s = s.replace('&', ' and ')
    s = re.sub(r'\bdistrict\b', ' ', s)
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


# NREGA state name -> LGD stname, where they differ after normalising.
STATE_ALIASES = {
    'dn haveli and dd': 'the dadra and nagar haveli and daman and diu',
}

# (NREGA state, NREGA district) -> LGD district name: renames since the LGD
# vintage and spelling variants (checked Nov 2026).
NAME_ALIASES = {
    ('maharashtra', 'ahilyanagar'): 'ahmednagar',
    ('bihar', 'gayaji'): 'gaya',
    ('karnataka', 'bengaluru south'): 'ramanagara',
    ('west bengal', 'dakshin dinajpur'): 'dinajpur dakshin',
    ('west bengal', 'uttar dinajpur'): 'dinajpur uttar',
    ('west bengal', 'north 24 parganas'): '24 paraganas north',
    ('west bengal', 'south 24 parganas'): '24 paraganas south',
    ('chhattisgarh', 'khairagarh chhuikhadan gandai'): 'khairgarh chhuikhadan gandai',
    ('karnataka', 'chamaraja nagara'): 'chamarajanagara',
    ('madhya pradesh', 'ashok nagar'): 'ashoknagar',
    ('telangana', 'rangareddy'): 'ranga reddy',
}
# Left unmatched on purpose (listed in the layer notes): Keyi Panyor (2024,
# carved from Lower Subansiri; no LGD polygon yet) and Gorkhaland Territorial
# Administration (spans Darjeeling's hills and Kalimpong, not one district).

# Hand-checked (NREGA state, NREGA district) -> LGD district code, vendored
# from the rural Land Ledger pipeline (nature-credit/pipeline/pull_mgnrega.py).
# Darjeeling is split in NREGA into the hill council and Siliguri; both map to
# Darjeeling (309) and are summed.
CODE_ALIASES = {(norm(st), norm(d)): c for (st, d), c in {
    ('ANDAMAN AND NICOBAR', 'SOUTH ANDAMAN'): 602, ('ANDHRA PRADESH', 'NELLORE'): 515,
    ('ARUNACHAL PRADESH', 'UPPER DIBANG VALLEY'): 230, ('ASSAM', 'Morigaon'): 296,
    ('ASSAM', 'SOUTH SALMARA-MANKACHAR'): 707, ('ASSAM', 'Sribhumi'): 293, ('BIHAR', 'AURANAGABAD'): 189,
    ('CHHATTISGARH', 'GAURELA PENDRA MARWAHI'): 734, ('CHHATTISGARH', 'KAWARDHA'): 382,
    ('CHHATTISGARH', 'RAJNANDAGON'): 388, ('CHHATTISGARH', 'MANENDRAGARH CHIRMIRI BHARATPUR'): 760,
    ('CHHATTISGARH', 'MOHLA MANPUR AMBAGARH CHOWKI'): 761, ('DN HAVELI AND DD', 'DADRA AND NAGAR HAVELI'): 465,
    ('HARYANA', 'MEWAT'): 604, ('JAMMU AND KASHMIR', 'BADGAM'): 2, ('JAMMU AND KASHMIR', 'RAJAURI'): 12,
    ('KARNATAKA', 'BENGALURU'): 525, ('KARNATAKA', 'DAVANAGERE'): 535, ('KARNATAKA', 'DHARWAR'): 536,
    ('KARNATAKA', 'VIJAYANAGARA'): 738, ('KARNATAKA', 'VIJAYPURA'): 530, ('KERALA', 'KASARGOD'): 558,
    ('MADHYA PRADESH', 'KHANDWA'): 405, ('MAHARASHTRA', 'Chatrapati Sambhaji Nagar'): 469,
    ('MAHARASHTRA', 'Dharashiv'): 488, ('MIZORAM', 'Siaha'): 267, ('ODISHA', 'ANGUL'): 344,
    ('ODISHA', 'BOLANGIR'): 345, ('ODISHA', 'JAJPUR'): 356, ('ODISHA', 'NABARANGAPUR'): 366,
    ('PUNJAB', 'BHATINDA'): 28, ('PUNJAB', 'MUKATSAR'): 39, ('PUNJAB', 'NAWANSHAHR'): 40, ('PUNJAB', 'ROPAR'): 42,
    ('PUNJAB', 'SAS NAGAR MOHALI'): 608, ('RAJASTHAN', 'SRI GANGANAGAR'): 100,
    ('SIKKIM', 'Gangtok District'): 225, ('SIKKIM', 'Mangan District'): 226, ('SIKKIM', 'Namchi District'): 227,
    ('SIKKIM', 'Gyalshing District'): 228, ('TAMIL NADU', 'SIVAGANGAI'): 585, ('TAMIL NADU', 'THOOTHUKKUDI'): 594,
    ('TAMIL NADU', 'TIRUVALLUR'): 589, ('TAMIL NADU', 'TIRUVARUR'): 590, ('TELANGANA', 'Jagtial'): 681,
    ('TELANGANA', 'Jangaon'): 689, ('TELANGANA', 'Jayashanker Bhopalapally'): 687,
    ('TELANGANA', 'Kumram Bheem(Asifabad)'): 699, ('TELANGANA', 'Medchal'): 700,
    ('TELANGANA', 'Rajanna Sirsilla'): 683, ('UTTAR PRADESH', 'KASHGANJ'): 633,
    ('UTTAR PRADESH', 'SANT RAVIDAS NAGAR'): 179, ('WEST BENGAL', '24 PARGANAS (NORTH)'): 303,
    ('WEST BENGAL', '24 PARGANAS SOUTH'): 304, ('WEST BENGAL', 'PASCHIM MEDINIPUR'): 318,
    ('WEST BENGAL', 'PURBA MEDINIPUR'): 317, ('WEST BENGAL', 'Darjeeling Gorkha Hill Council (DGHC)'): 309,
    ('WEST BENGAL', 'SILIGURI MAHAKUMA PARISAD'): 309,
}.items()}  # fmt: skip


def match_districts(nrega: list[tuple[str, str]], lgd: list[dict]) -> tuple[dict, list]:
    """{(nrega state, nrega district): dist_lgd} and the unmatched pairs."""
    by_state: dict[str, dict[str, int]] = {}
    for d in lgd:
        by_state.setdefault(norm(d['stname']), {})[norm(d['dtname'])] = int(d['dist_lgd'])
    hits, unmatched = {}, []
    for st, dt in nrega:
        nst, ndt = norm(st), norm(dt)
        code = CODE_ALIASES.get((nst, ndt))
        if code is None:
            names = by_state.get(STATE_ALIASES.get(nst, nst), {})
            code = names.get(NAME_ALIASES.get((nst, ndt), ndt))
        if code is None:
            unmatched.append((st, dt))
        else:
            hits[(st, dt)] = code
    return hits, unmatched


def year_col(fin_year: str) -> str:
    """'2024-2025' -> 'exp_2024_25'."""
    a, b = fin_year.split('-')
    return f'exp_{a}_{b[-2:]}'


def district_rows(full: list[dict], trend: list[dict], lgd: list[dict]) -> tuple[dict[int, dict], list]:
    """{dist_lgd: row}: YEAR's year-end source columns plus exp_<year> total
    spend (Total_Exp, Rs lakh) for every year in `trend`. Raises if two NREGA
    units land on one LGD district. Returns the unmatched (state, district)."""
    current = year_end(full)
    hits, unmatched = match_districts(sorted({(r['state_name'], r['district_name']) for r in current}), lgd)
    rows: dict[int, dict] = {}
    for r in current:
        code = hits.get((r['state_name'], r['district_name']))
        if code is None:
            continue
        if code in rows:
            raise ValueError(f'two NREGA units on LGD district {code}: '
                             f"{rows[code]['district_name']!r} and {r['district_name']!r}")
        rows[code] = dict(r)
    # Yearly spend is additive, so units sharing a district in a year are summed.
    t_hits, _ = match_districts(sorted({(r['state_name'], r['district_name']) for r in trend}), lgd)
    for r in year_end(trend):
        code = t_hits.get((r['state_name'], r['district_name']))
        complete = re.fullmatch(r'\d{4}-\d{4}', r.get('fin_year') or '') and r['fin_year'] <= YEAR
        if code in rows and complete and r.get('Total_Exp') is not None:
            col = year_col(r['fin_year'])
            rows[code][col] = (rows[code].get(col) or 0) + r['Total_Exp']
    return rows, unmatched


# ── catalog ──────────────────────────────────────────────────────────────────

def description() -> str:
    return ('MGNREGA rural jobs scheme by district, financial year 2025-26: spending, wages, '
            'households and persondays of work, women, SC and ST participation, works and job cards, '
            'plus total spending each year since 2018-19.')


def notes(unmatched: list[str]) -> str:
    left = '; '.join(unmatched) if unmatched else 'none'
    return ('"District-wise MGNREGA Data at a Glance", Ministry of Rural Development, on data.gov.in '
            'under GODL-India. Values are each district\'s latest cumulative snapshot of the year as published (March for '
            'most; the month column shows which); money '
            'columns (Total_Exp, Wages, Material_and_skilled_Wages, Total_Adm_Expenditure, exp_*) are in '
            'Rs lakh. NREGA districts are matched to LGD districts by name within the state, with '
            'hand-checked renames; districts without a match have no values. MGNREGA reports Rajasthan as its 33 '
            'districts before the 2023 reorganisation and Nagaland as 11 districts, so there an older district\'s '
            'figures include the newer districts carved from it, which show no values. Urban districts '
            '(Delhi, Mumbai, Chennai, Kolkata, Hyderabad, Chandigarh) have no MGNREGA. Darjeeling covers the '
            'Siliguri subdivision only (the hill areas report as GTA, which spans Darjeeling and '
            f'Kalimpong). NREGA districts with no LGD polygon: {left}.')


def level_meta() -> dict:
    return {'label': 'MGNREGA by District (2025-26)', 'unit': 'districts', 'description': description()}


TAGS = ['MGNREGA', 'NREGA', 'rural employment', 'jobs scheme', 'wages', 'persondays', 'job cards',
        'rural development', 'public spending', 'district', 'economy', 'finance']


def catalog_entry(rows: int, sizes: dict, fetched_at: str, r2_public: str, unmatched: list[str]) -> dict:
    entry = {'id': LAYER_ID, 'level': LAYER_ID, 'source': SOURCE, 'rows': rows}
    for fmt, ext in EXT.items():
        entry[fmt] = {'url': f'{r2_public}/{R2_PREFIX}/{BASENAME}.{ext}', 'bytes': sizes[fmt]}
    entry.update({'licence': 'GODL-India', 'attribution': {'primary': dict(ATTRIBUTION), 'publisher': None},
                  'category': CATEGORY[0], 'provenance': 'curated', 'fetched_at': fetched_at,
                  'notes': notes(unmatched), 'tags': TAGS})
    return entry


def manifest_entry(rows: int, sizes: dict, unmatched: list[str]) -> dict:
    return {'id': LAYER_ID, 'name': level_meta()['label'], 'level': LAYER_ID, 'category': CATEGORY[0],
            'source': SOURCE, 'description': description(), 'unit': 'districts', 'features': rows,
            'license': 'GODL-India', 'r2_prefix': R2_PREFIX,
            'parquet_file': f'{BASENAME}.parquet', 'parquet_bytes': sizes['parquet'],
            'pmtiles_file': f'{BASENAME}.pmtiles', 'pmtiles_bytes': sizes['pmtiles'],
            'source_url': ATTRIBUTION['url'], 'source_org': ATTRIBUTION['name'],
            'notes': notes(unmatched), 'tags': TAGS}


def register(catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST,
             summary_path: Path = SUMMARY, r2_public: str | None = None) -> None:
    """Patch catalog.json + the manifest in place (never rebuild). Idempotent."""
    import pipeline
    summ = json.loads(summary_path.read_text())
    entry = catalog_entry(summ['rows'], summ['sizes'], pipeline.now_iso(), r2_public or pipeline.R2_PUBLIC,
                          summ['unmatched'])
    pipeline.register_layer(catalog_path, manifest_path, entry,
                            manifest_entry(summ['rows'], summ['sizes'], summ['unmatched']),
                            level_meta(), attribution=(SOURCE, ATTRIBUTION), category=CATEGORY)



# ── bake ─────────────────────────────────────────────────────────────────────

def load_pages(cache: Path) -> list[dict]:
    return [r for p in sorted(cache.glob('offset_*.json.gz')) for r in json.loads(gzip.decompress(p.read_bytes()))]


def bake(out_dir: Path = OUT_DIR) -> dict:
    import tempfile

    import bake_formats
    from bake_extracts import gdal_geojson_available, write_kml_from_geojson
    from bake_whole_layer import write_geojson_whole
    from ingest_ramseraph import rebake_flatten_bbox

    full, trend = load_pages(RAW / f'full_{YEAR}'), load_pages(RAW / 'trend_all_years')
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='mgnrega_') as tmp:
        tmp = Path(tmp)
        districts = bake_formats.fetch_layer_file(CATALOG, 'lgd_districts', 'parquet', tmp / 'lgd_districts.parquet')
        con = make_con()
        lgd = [dict(zip(('dist_lgd', 'dtname', 'stname'), r)) for r in
               con.execute(f"SELECT dist_lgd, dtname, stname FROM '{districts}'").fetchall()]
        rows, unmatched = district_rows(full, trend, lgd)
        cols = sorted({k for r in rows.values() for k in r}, key=lambda c: (c.startswith('exp_'), c))
        values = tmp / 'values.json'
        values.write_text(json.dumps([{'dist_lgd_key': k, **v} for k, v in rows.items()]))
        sel = ', '.join(f'v."{c}"' for c in cols)
        geom = next(c for c, t, *_ in con.execute(f"DESCRIBE SELECT * FROM '{districts}'").fetchall()
                    if 'GEOMETRY' in t or c in ('geometry', 'geom'))
        joined = tmp / 'joined.parquet'
        con.execute(f"""COPY (SELECT g.dist_lgd, g.dtname, g.stname, g.state_lgd, {sel}, g."{geom}" AS geometry
            FROM read_parquet('{districts}') g LEFT JOIN read_json_auto('{values}') v ON v.dist_lgd_key = g.dist_lgd
            ORDER BY g.dist_lgd) TO '{joined}' (FORMAT PARQUET)""")
        n, filled = con.execute(f"SELECT count(*), count(fin_year) FROM '{joined}'").fetchone()
        parquet = out_dir / f'{BASENAME}.parquet'
        _, prop_cols = rebake_flatten_bbox(joined, parquet)
    con = make_con()
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    path['geojson'].unlink(missing_ok=True)
    write_geojson_whole(con, parquet, path['geojson'], gdal_geojson_available(con))
    write_kml_from_geojson(path['geojson'], LAYER_ID, path['kml'])
    bake_formats.shapefile_zip_from_geojson(path['geojson'], path['shapefile'], bake_formats.short_field_names(prop_cols))
    bake_formats.write_pmtiles(path['geojson'], path['pmtiles'], LAYER_ID, TILE_FIELDS)
    summary = {'rows': n, 'districts_with_values': filled, 'unmatched': [f'{s} / {d}' for s, d in unmatched],
               'sizes': {fmt: p.stat().st_size for fmt, p in path.items()}}
    SUMMARY.write_text(json.dumps(summary, indent=2))
    log(json.dumps(summary, indent=2))
    return summary


def upload(out_dir: Path = OUT_DIR) -> None:
    from ingest_ramseraph import r2_client, r2_upload
    s3 = r2_client()
    for ext in EXT.values():
        r2_upload(s3, out_dir / f'{BASENAME}.{ext}', f'{R2_PREFIX}/{BASENAME}.{ext}')


def pull(refresh: bool = False) -> tuple[list[dict], list[dict]]:
    """The full source rows for YEAR, and the trend fields for every year."""
    full = pull_pages(RAW / f'full_{YEAR}', {'fin_year': YEAR}, api_fetch(), refresh=refresh)
    trend = pull_pages(RAW / 'trend_all_years', {}, api_fetch(TREND_FIELDS), refresh=refresh)
    log(f'pulled {len(full):,} rows for {YEAR}; {len(trend):,} trend rows')
    return full, trend


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['pull', 'bake', 'upload', 'register'])
    ap.add_argument('--refresh', action='store_true', help='refetch every page (the source updates daily)')
    a = ap.parse_args()
    if a.step == 'pull':
        with cache_backup(RAW, 'bake_mgnrega_districts'):
            pull(a.refresh)
    elif a.step == 'bake':
        bake()
    elif a.step == 'upload':
        upload()
    else:
        register()


if __name__ == '__main__':
    main()
