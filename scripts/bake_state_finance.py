#!/usr/bin/env python3
"""
Bake state_finance: state and UT economy and finance figures on LGD states.

Sources: eight state-wise tables on data.gov.in (GODL-India), each a one-off
snapshot tabled in a Rajya Sabha answer (RESOURCES below records the session,
question and date). Figures are kept as published: numbers are cast to
numbers, NA stays empty, units are named in each column.

The layer: every lgd_states polygon with 12 columns, each naming its year or
date (gsdp_current_2021_22_rs_crore, ...). Source state names are matched to
LGD after normalising, with a hand-checked alias table; rows that fit no LGD
state (e.g. GST "Centre Jurisdiction") are listed in the layer notes, rows
skipped on purpose are explained there, and two rows landing on one state fail
loudly unless the figure is additive (GST reports Dadra and Nagar Haveli and
Daman and Diu separately; the merged UT gets their sum).

Pull: data.gov.in API (key OGD_API_KEY, else ~/Projects/rural/shc/.env; never
printed). Each table is cached under data/raw/state-finance/ as it arrives, so
a stopped run resumes and a second run fetches nothing (--refresh refetches).

Usage:
    python3 -u scripts/bake_state_finance.py pull [--refresh]
    python3 -u scripts/bake_state_finance.py bake
    python3 -u scripts/bake_state_finance.py upload      # md5-skip uploads to R2
    python3 -u scripts/bake_state_finance.py register    # patch catalog + manifest
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402

from bake_mgnrega_districts import norm, num  # noqa: E402
from pipeline import cache_backup, log, make_con  # noqa: E402

RAW = ROOT / 'data' / 'raw' / 'state-finance'
LAYER_ID = 'state_finance'
BASENAME = 'State_Finance'
R2_PREFIX = 'economy/state-finance'
CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
OUT_DIR = ROOT / 'data' / 'baked' / R2_PREFIX
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
CATEGORY = ('economy', 'Economy & finance')
SOURCE = 'data.gov.in (Rajya Sabha)'
ATTRIBUTION = {'name': 'Rajya Sabha answers (MoSPI, RBI, Ministry of Finance, Income Tax Department, '
                       'GSTN, MUDRA, NABARD, banks), via data.gov.in',
               'url': 'https://www.data.gov.in/'}
TIME_LIMIT_S = 20 * 60
DNHDD = 'dadra nagar haveli daman and diu'

# Each table: data.gov.in resource id, the source of its figures, and the
# columns taken from it as {layer column: (source field, type)}.
RESOURCES: list[dict] = [
    {'key': 'gsdp', 'id': 'b94407cc-7748-41f8-b199-b2916af3228a', 'name_field': 'state_ut',
     'title': 'State/UT-wise Gross State Domestic Product (GSDP) and Percentage Growth of GSDP at Current '
              'as well as Constant (2011-12) form 2017-18 to 2022-23',  # sic
     'source': 'Rajya Sabha session 259, unstarred question 2238, answered 20 March 2023; figures of state '
               'Directorates of Economics and Statistics as on 15-03-2023',
     'columns': {'gsdp_current_2021_22_rs_crore':
                 ('gross_state_domestic_product__gsdp_at_current_prices___2021_22', float)},
     'note': 'GSDP at current prices (2011-12 base), Rs crore; 2021-22 is the latest year reported for nearly '
             'every state. Jammu and Kashmir is the UT figure; not compiled for Ladakh, Lakshadweep, and Dadra and '
             'Nagar Haveli and Daman and Diu',
     'skip': {'jammu and kashmir': 'the erstwhile state of Jammu and Kashmir including Ladakh (figures to '
                                   '2018-19 only); the UT row is used'}},
    {'key': 'nsdp', 'id': 'c9bfd3c0-b9de-4a5b-8752-f72a4f2932ad', 'name_field': 'state_ut',
     'title': 'State/UT-wise Details of Per Capita Net State Domestic Product at Current Prices from 2019-20 '
              'to 2022-23',
     'source': 'Rajya Sabha session 262, starred question 94, answered 11 December 2023; data as on 01-08-2023',
     'columns': {'nsdp_per_capita_current_2021_22_rs': ('_2021_22', float)},
     'note': 'per capita NSDP at current prices, Rs per person (the table note says Rs crore, but the figures '
             'are rupees per person and equal the NSO per capita figures tabled in July 2024)'},
    {'key': 'debt', 'id': 'b53abcb0-fcb2-4de9-82d5-6df1cd2a6306', 'name_field': 'state_ut',
     'title': 'State/UT-wise Details of Total Outstanding Liabilities of States & UT with Legislature as '
              'Percent of (GSDP) from 2021 to 2023',
     'source': 'Rajya Sabha session 260, unstarred question 1353, answered 1 August 2023; RBI, State '
               'Finances: A Study of Budgets of 2022-23',
     'columns': {'outstanding_liabilities_pct_gsdp_mar_2021_actual': ('_at_the_end_march____2021__actual_', float),
                 'outstanding_liabilities_pct_gsdp_mar_2023_be': ('_at_the_end_march____2023__be_', float)},
     'note': 'total outstanding liabilities of the state government as percent of GSDP at end-March, '
             '2021 actual and 2023 budget estimate (states and UTs with a legislature only)'},
    {'key': 'gst', 'id': '5d0b81aa-d513-4dfd-9f57-84571829c049', 'name_field': 'state_ut', 'additive': True,
     'title': 'State/UT-wise Details of Gross Goods and Service Tax (GST) Collection from 2020-21 to 2024-25',
     'source': 'Rajya Sabha session 266, unstarred question 881, answered 3 December 2024',
     'columns': {'gst_gross_2023_24_rs_crore': ('_2023_24', float)},
     'note': 'gross GST collection on domestic supplies, 2023-24 (the latest full year; the table\'s '
             '2024-25 runs only to October 2024), Rs crore. Dadra and Nagar Haveli and Daman and Diu, '
             'reported separately, are summed',
     'totals': {'gst collection domestic', 'imports', 'total gst collection'}},
    {'key': 'direct_tax', 'id': 'e3b6c58c-0292-4b1b-b39a-8388a0d4a35b', 'name_field': 'state_ut',
     'title': 'State/UT-wise Details of Total Amount of Direct tax Collection during 2022-23',
     'source': 'Rajya Sabha session 262, unstarred question 232, answered 5 December 2023',
     'columns': {'direct_tax_gross_2022_23_rs_crore': ('gross_collection', float)},
     'note': 'gross direct tax collection, 2022-23, Rs crore, placed by the state code of the assessing '
             'officer\'s jurisdiction (so states hosting company head offices, such as Maharashtra and Delhi, '
             'carry tax earned elsewhere)'},
    {'key': 'mudra', 'id': '5848e4ad-2a80-4045-bae6-e705bfc05493', 'name_field': 'state_ut',
     'title': 'State/UT-wise Details of Loan Accounts and Disbursed Amount under Pradhan Mantri Mudra Yojana '
              '(PMMY) from 08-04-2015 to 02-01-2026',
     'source': 'Rajya Sabha session 270, unstarred question 1199, answered 10 February 2026; provisional, '
               'as uploaded by lending institutions on the Mudra portal',
     'columns': {'mudra_loan_accounts_apr_2015_to_jan_2026': ('no__of_loan_accounts', int),
                 'mudra_disbursed_apr_2015_to_jan_2026_rs_crore': ('disbursed_amount', float)},
     'note': 'PM Mudra Yojana loan accounts and amount disbursed, cumulative 08-04-2015 to 02-01-2026, Rs crore'},
    {'key': 'kcc', 'id': 'd7cf9477-e439-426e-9ee5-1b43dbcaabc9', 'name_field': 'state_ut',
     'title': 'State/UT-wise Details of Operative Kisan Credit Card (KCC) and Amount Outstanding including '
              'Maharashtra as on 30-09-2024',
     'source': 'Rajya Sabha session 266, unstarred question 1676, answered 10 December 2024',
     'columns': {'kcc_operative_accounts_sep_2024': ('total_number_of_operative_accounts', int),
                 'kcc_outstanding_sep_2024_rs_crore': ('total_amount_outstanding', float)},
     'note': 'operative Kisan Credit Card accounts and amount outstanding as on 30-09-2024, Rs crore'},
    {'key': 'pmjdy', 'id': '996d63c6-4759-4b12-90b4-b6ce61d337e3', 'name_field': 'state_ut',
     'title': 'State/UT-wise Number of PMJDY accounts, PMJJBY, PMSBY, and APY Enrolments under National '
              'Mission for Financial Inclusion (NMFI) during 31-12-2024 and 15-01-2025',
     'source': 'Rajya Sabha session 267, unstarred question 220, answered 4 February 2025; source: banks',
     'columns': {'pmjdy_accounts_jan_2025': ('number_of_pmjdy_accounts__as_on_15_01_2025___total', int)},
     'note': 'PM Jan Dhan Yojana accounts as on 15-01-2025'},
]
COLUMNS = [c for r in RESOURCES for c in r['columns']]
TILE_FIELDS = ('STNAME', *COLUMNS)  # 36 polygons: every column fits in the tiles

# Source state name (normalised) -> LGD STNAME (normalised), where they differ.
# Checked against the eight tables in Nov 2026.
STATE_ALIASES = {
    'andaman and nicobar islands': 'andaman and nicobar',
    'dadra and nagar haveli and daman and diu': DNHDD,
    'dadra and nagar haveli': DNHDD,   # merged into one UT in 2020
    'daman and diu': DNHDD,
    'jammu and kashmir ut': 'jammu and kashmir',
    'chhatisgarh': 'chhattisgarh',
    'nct of delhi': 'delhi',
}


# ── pull ─────────────────────────────────────────────────────────────────────

class TimeLimit(Exception):
    """The run reached its own time limit; finished tables are cached."""


def api_fetch(tries: int = 6) -> Callable[[str], dict]:
    key = pipeline.datagov_api_key()
    return lambda rid: pipeline.datagov_get(rid, key, tries=tries, limit=1000)


def pull_resources(cache: Path, ids: list[str], fetch: Callable[[str], dict] | None, refresh: bool = False,
                   deadline: float | None = None, now: Callable[[], float] = time.monotonic) -> dict[str, dict]:
    """{resource id: API response}; each response is saved as it arrives and
    read back from the cache on a rerun (fetch=None: cache only). Error or
    empty responses are refused, never cached."""
    cache.mkdir(parents=True, exist_ok=True)
    out = {}
    for rid in ids:
        path = cache / f'{rid}.json.gz'
        if refresh or not path.exists():
            if fetch is None:
                raise SystemExit(f'{rid} is not cached under {cache}: run pull first')
            if deadline is not None and now() > deadline:
                raise TimeLimit(f'time limit reached before {rid}; rerun to continue')
            d = fetch(rid)
            if d.get('status') != 'ok' or not d.get('records'):
                raise ValueError(f"{rid}: {d.get('message') or 'no records'}")
            if int(d.get('total') or 0) > len(d['records']):
                raise ValueError(f"{rid}: {d['total']} rows but one page holds {len(d['records'])}")
            tmp = path.with_suffix('.part')
            tmp.write_bytes(gzip.compress(json.dumps(d).encode(), mtime=0))
            tmp.replace(path)
            log(f"  {rid}: {len(d['records'])} rows  {d.get('title', '')[:80]}")
        out[rid] = json.loads(gzip.decompress(path.read_bytes()))
    return out


# ── state names -> LGD ───────────────────────────────────────────────────────

def lgd_keys(lgd: list[dict]) -> dict[str, int]:
    return {norm(s['STNAME']): int(s['State_LGD']) for s in lgd}


def match_state(name: str, keys: dict[str, int]) -> int | None:
    k = norm(name)
    return keys.get(STATE_ALIASES.get(k, k))


def cast(v, kind: type):
    f = num(v)
    return None if f is None else kind(round(f) if kind is int else f)


def resource_values(spec: dict, records: list[dict], keys: dict[str, int]) -> tuple[dict, list, dict]:
    """({State_LGD: {column: value}}, unmatched source names, {total row: values})."""
    totals_names = spec.get('totals', set()) | {'total'}
    values: dict[int, dict] = {}
    unmatched, totals = [], {}
    for r in records:
        name = str(r.get(spec['name_field']) or '').strip()
        row = {col: cast(r.get(field), kind) for col, (field, kind) in spec['columns'].items()}
        if norm(name) in spec.get('skip', {}):
            continue
        if norm(name) in totals_names:
            totals[name] = row
            continue
        code = match_state(name, keys)
        if code is None:
            unmatched.append(name)
        elif code not in values:
            values[code] = row
        elif spec.get('additive'):
            for col, v in row.items():
                parts = [x for x in (values[code][col], v) if x is not None]
                values[code][col] = sum(parts) if parts else None
        else:
            raise ValueError(f"{spec['key']}: two rows on LGD state {code}, the second {name!r}")
    return values, unmatched, totals


def state_rows(specs: list[dict], raw: dict[str, list[dict]], lgd: list[dict]) -> tuple[dict, list, dict]:
    """Every resource's values merged per State_LGD; unmatched as 'key: name';
    total rows per resource key."""
    keys = lgd_keys(lgd)
    rows: dict[int, dict] = {}
    unmatched, totals = [], {}
    for spec in specs:
        values, miss, tot = resource_values(spec, raw[spec['id']], keys)
        for code, v in values.items():
            rows.setdefault(code, {}).update(v)
        unmatched += [f"{spec['key']}: {n}" for n in miss]
        totals[spec['key']] = tot
    return rows, unmatched, totals


# ── catalog ──────────────────────────────────────────────────────────────────

def description() -> str:
    return ('State and UT economy and finance: GSDP and per capita income, state debt as a share of GSDP, '
            'GST and direct tax collections, Mudra loans, Kisan Credit Cards and Jan Dhan accounts, from '
            'official tables tabled in Rajya Sabha.')


def notes(unmatched: list[str]) -> str:
    parts = [f"{', '.join(r['columns'])}: {r['note']}. Source: \"{r['title']}\", {r['source']} "
             f"(data.gov.in resource {r['id']})." for r in RESOURCES]
    skipped = [f"{r['key']}: {why}" for r in RESOURCES for why in r.get('skip', {}).values()]
    return ('Official state-wise tables from Rajya Sabha answers, published on data.gov.in under GODL-India. '
            'Each is a one-off snapshot with its own year or date, named in every column; figures are kept as '
            'published (numbers cast to numbers, NA left empty). Money is in Rs crore unless a column says '
            'otherwise. Source state names are matched to LGD states by name with hand-checked aliases. '
            + ' '.join(parts)
            + f" Rows skipped on purpose: {'; '.join(skipped) or 'none'}."
            + f" Source rows with no LGD state: {'; '.join(unmatched) or 'none'}.")


def level_meta() -> dict:
    return {'label': 'State Economy & Finance', 'unit': 'states', 'description': description()}


TAGS = ['GSDP', 'NSDP', 'per capita income', 'state debt', 'GST', 'direct tax', 'Mudra', 'Kisan Credit Card',
        'KCC', 'Jan Dhan', 'PMJDY', 'financial inclusion', 'public finance', 'state', 'economy', 'finance']


def catalog_entry(rows: int, sizes: dict, fetched_at: str, r2_public: str, unmatched: list[str],
                  names: dict[str, str] | None = None) -> dict:
    names = names or pipeline.plain_names(BASENAME, EXT)
    entry = {'id': LAYER_ID, 'level': LAYER_ID, 'source': SOURCE, 'rows': rows,
             **pipeline.format_blocks(EXT, names, sizes, f'{r2_public}/{R2_PREFIX}')}
    entry.update({'licence': 'GODL-India', 'attribution': {'primary': dict(ATTRIBUTION), 'publisher': None},
                  'category': CATEGORY[0], 'provenance': 'curated', 'fetched_at': fetched_at,
                  'notes': notes(unmatched), 'tags': TAGS})
    return entry


def manifest_entry(rows: int, sizes: dict, unmatched: list[str], names: dict[str, str] | None = None) -> dict:
    names = names or pipeline.plain_names(BASENAME, EXT)
    return {'id': LAYER_ID, 'name': level_meta()['label'], 'level': LAYER_ID, 'category': CATEGORY[0],
            'source': SOURCE, 'description': description(), 'unit': 'states', 'features': rows,
            'license': 'GODL-India', 'r2_prefix': R2_PREFIX,
            **pipeline.manifest_files(names, sizes),
            'source_url': ATTRIBUTION['url'], 'source_org': ATTRIBUTION['name'],
            'notes': notes(unmatched), 'tags': TAGS}


def register(catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST,
             summary_path: Path = SUMMARY, r2_public: str | None = None) -> None:
    """Patch catalog.json + the manifest in place (never rebuild). Idempotent."""
    summ = json.loads(summary_path.read_text())
    names = pipeline.summary_names(summ)
    entry = catalog_entry(summ['rows'], summ['sizes'], pipeline.now_iso(), r2_public or pipeline.R2_PUBLIC,
                          summ['unmatched'], names=names)
    pipeline.register_layer(catalog_path, manifest_path, entry,
                            manifest_entry(summ['rows'], summ['sizes'], summ['unmatched'], names=names),
                            level_meta(), attribution=(SOURCE, ATTRIBUTION), category=CATEGORY)


# ── bake ─────────────────────────────────────────────────────────────────────

def bake(out_dir: Path = OUT_DIR) -> dict:
    import tempfile

    import bake_formats
    from bake_extracts import gdal_geojson_available, write_kml_from_geojson
    from bake_whole_layer import write_geojson_whole
    from pipeline import rebake_flatten_bbox

    raw = {rid: d['records'] for rid, d in pull_resources(RAW, [r['id'] for r in RESOURCES], None).items()}
    out_dir.mkdir(parents=True, exist_ok=True)
    states = bake_formats.fetch_layer_file(CATALOG, 'lgd_states', 'parquet', RAW / 'lgd_states.parquet')
    con = make_con()
    lgd = [dict(zip(('State_LGD', 'STNAME'), r)) for r in
           con.execute(f"SELECT State_LGD, STNAME FROM '{states}'").fetchall()]
    rows, unmatched, totals = state_rows(RESOURCES, raw, lgd)
    with tempfile.TemporaryDirectory(prefix='state_finance_') as tmp:
        tmp = Path(tmp)
        values = tmp / 'values.json'
        values.write_text(json.dumps([{'state_lgd_key': k, **{c: v.get(c) for c in COLUMNS}} for k, v in rows.items()]))
        sel = ', '.join(f'v."{c}"' for c in COLUMNS)
        joined = tmp / 'joined.parquet'
        con.execute(f"""COPY (SELECT g.State_LGD, g.STNAME, {sel}, g.geometry
            FROM read_parquet('{states}') g LEFT JOIN read_json_auto('{values}') v ON v.state_lgd_key = g.State_LGD
            ORDER BY g.State_LGD) TO '{joined}' (FORMAT PARQUET)""")
        n = con.execute(f"SELECT count(*) FROM '{joined}'").fetchone()[0]
        parquet = out_dir / f'{BASENAME}.parquet'
        _, prop_cols = rebake_flatten_bbox(joined, parquet)
    con = make_con()
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    path['geojson'].unlink(missing_ok=True)
    write_geojson_whole(con, parquet, path['geojson'], gdal_geojson_available(con))
    write_kml_from_geojson(path['geojson'], LAYER_ID, path['kml'])
    bake_formats.shapefile_zip_from_geojson(path['geojson'], path['shapefile'], bake_formats.short_field_names(prop_cols))
    bake_formats.write_pmtiles(path['geojson'], path['pmtiles'], LAYER_ID, TILE_FIELDS)
    summary = {'rows': n, 'states_with_values': len(rows), 'unmatched': unmatched, 'totals': totals,
               'sizes': {fmt: p.stat().st_size for fmt, p in path.items()},
               'names': pipeline.versioned_names(path)}
    SUMMARY.write_text(json.dumps(summary, indent=2))
    log(json.dumps(summary, indent=2))
    return summary


def upload(out_dir: Path = OUT_DIR) -> dict[str, str]:
    """Upload every format to its content-versioned key (<BASENAME>.<md5[:8]>.<ext>):
    changed bytes get a new key, unchanged files keep theirs (md5-skipped)."""
    return pipeline.upload_layer(out_dir, BASENAME, EXT, R2_PREFIX)


def pull(refresh: bool = False) -> None:
    ids = [r['id'] for r in RESOURCES]
    try:
        got = pull_resources(RAW, ids, api_fetch(), refresh, deadline=time.monotonic() + TIME_LIMIT_S)
    except TimeLimit as e:
        raise SystemExit(str(e))
    log(f'pulled {len(got)} of {len(ids)} tables')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['pull', 'bake', 'upload', 'register'])
    ap.add_argument('--refresh', action='store_true', help='refetch every table')
    a = ap.parse_args()
    if a.step == 'pull':
        with cache_backup(RAW, 'bake_state_finance'):
            pull(a.refresh)
    elif a.step == 'bake':
        bake()
    elif a.step == 'upload':
        upload()
    else:
        register()


if __name__ == '__main__':
    main()
