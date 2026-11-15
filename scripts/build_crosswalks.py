"""
Build the Census 2011 <-> LGD crosswalk: one tidy table per level (states, districts, subdistricts, blocks,
villages), from the Census 2011 codes that bharatlas's own LGD layers already carry beside their LGD codes.

Each row is one distinct (LGD code, Census 2011 code) pair found on that level's polygons, with the unit's name, a
`code_status` for the 2011 code and a `relation` derived from how the pairs repeat:

    1:1            the 2011 code is on one LGD unit, and that unit carries no other 2011 code
    split          one 2011 unit's code is on several LGD units
    merge          one LGD unit carries several 2011 codes
    split+merge    both
    post-2011 code the code is past the Census 2011 range: the source numbers units made after 2011 (states,
                   districts, sub-districts, blocks) past it, and LGD numbers villages it adds, including urban
                   units such as BBMP, from 800,000
    no 2011 code   the layer carries none (blank, zero, or a word such as "Urban")
    no LGD code    the polygon has no LGD code (e.g. the districts the source draws in Pakistan-administered Kashmir)

What the data cannot show: the source gives a district created after 2011 a new code (past 640) instead of its
parent's 2011 code, so the district table cannot say which 2011 district a new one came from; splits show at the
subdistrict, block and village levels, where the 2011 codes are kept. A 1:1 pair means the code continues, not
that the boundary is unchanged.

Codes are kept exactly as carried (never re-padded or cleaned); bharatlas never edits a source's attributes.
Each table keeps its source layer's licence (see release-meta.json).

Caching and idempotency: each layer's attribute columns (no geometry) are read once from R2 and kept in
data/cache/lgd/<layer>-<etag>.parquet; a re-run with an unchanged R2 file reads the cache, and output files are
rewritten only when their bytes change.

Usage:
    python3 scripts/build_crosswalks.py           # -> data/release-staging/cw/
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from catalog_record import CACHE as RECORD_CACHE, ChecksumCache, checksum, github_release, head, log, source_version  # noqa: E402,E501

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data' / 'cache' / 'lgd'
OUT = ROOT / 'data' / 'release-staging' / 'cw'

# Census 2011 counted 35 states and UTs, 640 districts and 5,924 sub-districts. The source gives units made after
# 2011 codes past those ranges (Telangana 36, Andhra Pradesh 37, Ladakh 38; districts 641+; sub-districts 05925+).
# Census 2011 village codes run to 645,603 in this data; LGD numbers villages made later from 800,000 up.


def _int(code) -> int | None:
    s = (code or '').strip() if isinstance(code, str) else ('' if code is None else str(code))
    return int(s) if s.isdigit() else None


def _ranged(top: int):
    def status(code) -> str:
        n = _int(code)
        if not n:
            return 'missing'
        return 'census2011' if n <= top else 'post2011'
    return status


def _block_status(code) -> str:
    """A Census 2011 block code is state (2) + district (3) + block (4) digits, e.g. 29 572 0110."""
    s = (code or '').strip()
    if not re.fullmatch(r'\d{9}', s) or s[5:] == '0000':
        return 'missing'
    st, dt = int(s[:2]), int(s[2:5])
    if not st or not dt:
        return 'missing'
    return 'census2011' if st <= 35 and dt <= 640 else 'post2011'


# Per level: the LGD layer, its LGD-code, 2011-code and name columns, and context columns kept as carried
# (output name -> source column).
LEVELS = {
    'states': {'layer': 'lgd_states', 'lgd': 'State_LGD', 'code11': 'STCODE11', 'name': 'STNAME',
               'context': {}, 'status': _ranged(35)},
    'districts': {'layer': 'lgd_districts', 'lgd': 'dist_lgd', 'code11': 'dtcode11', 'name': 'dtname',
                  'context': {'state_lgd': 'state_lgd', 'state_name': 'stname', 'year_stat': 'year_stat'},
                  'status': _ranged(640)},
    'subdistricts': {'layer': 'lgd_subdistricts', 'lgd': 'subdt_lgd', 'code11': 'sdtcode11', 'name': 'sdtname',
                     'context': {'state_lgd': 'state_lgd', 'dist_lgd': 'dist_lgd', 'district_name': 'dtname'},
                     'status': _ranged(5924)},
    'blocks': {'layer': 'lgd_blocks', 'lgd': 'block_lgd', 'code11': 'code2011', 'name': 'block_name',
               'context': {'state_lgd': 'state_lgd', 'dist_lgd': 'dist_lgd', 'district_name': 'district'},
               'status': _block_status},
    'villages': {'layer': 'lgd_villages', 'lgd': 'vil_lgd', 'code11': 'vilcode11', 'name': 'vilname11',
                 'context': {'state_lgd': 'state_lgd', 'dist_lgd': 'dist_lgd', 'subdt_lgd': 'subdt_lgd',
                             'name_soi': 'vilnam_soi'},
                 'status': _ranged(799999)},
}

COLUMNS = ['lgd_code', 'name', 'census2011_code', 'code_status', 'relation', 'lgd_units_for_2011_code',
           'census2011_codes_for_lgd_unit', 'features']


def derive(rows: list[dict], status) -> list[dict]:
    """Rows of {lgd_code, census2011_code, name, **context} (one per polygon) -> one row per distinct pair."""
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        groups[(r['lgd_code'] or 0, r['census2011_code'])].append(r)

    code_status = {code: status(code) for _, code in groups}
    valid = [(lgd, c) for (lgd, c) in groups if lgd and code_status[c] == 'census2011']
    lgd_per_code, codes_per_lgd = defaultdict(set), defaultdict(set)
    for lgd, c in valid:
        lgd_per_code[c].add(lgd)
        codes_per_lgd[lgd].add(c)

    out = []
    for (lgd, c), members in groups.items():
        st = code_status[c]
        n_lgd, n_11 = len(lgd_per_code.get(c, ())), len(codes_per_lgd.get(lgd, ()))
        if not lgd:
            rel = 'no LGD code'
        elif st == 'missing':
            rel = 'no 2011 code'
        elif st == 'post2011':
            rel = 'post-2011 code'
        else:
            rel = {(False, False): '1:1', (True, False): 'split', (False, True): 'merge',
                   (True, True): 'split+merge'}[(n_lgd > 1, n_11 > 1)]
        row = {'lgd_code': lgd, 'name': Counter(m.get('name') for m in members).most_common(1)[0][0],
               'census2011_code': c, 'code_status': st, 'relation': rel,
               'lgd_units_for_2011_code': n_lgd if st == 'census2011' else None,
               'census2011_codes_for_lgd_unit': n_11 if lgd else None, 'features': len(members)}
        for k in members[0]:
            if k not in row and k not in ('lgd_code', 'census2011_code'):
                row[k] = members[0][k]
        out.append(row)
    out.sort(key=lambda r: (r['lgd_code'], str(r['census2011_code'])))
    return out


def _write_if_changed(path: Path, data: bytes) -> bool:
    if path.exists() and path.read_bytes() == data:
        return False
    path.write_bytes(data)
    return True


def write_level(out: Path, level: str, rows: list[dict]) -> bool:
    """cw_<level>.csv and cw_<level>.parquet; True when either changed."""
    out.mkdir(parents=True, exist_ok=True)
    cols = COLUMNS + [k for k in (rows[0] if rows else {}) if k not in COLUMNS]
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols, lineterminator='\n')
    w.writeheader()
    for r in rows:
        w.writerow({k: ('' if r.get(k) is None else r.get(k)) for k in cols})
    a = _write_if_changed(out / f'cw_{level}.csv', buf.getvalue().encode('utf-8'))
    b = _write_if_changed(out / f'cw_{level}.parquet', _parquet_from_csv(out / f'cw_{level}.csv', cols))
    return a or b


INT_COLUMNS = {'lgd_code', 'lgd_units_for_2011_code', 'census2011_codes_for_lgd_unit', 'features',
               'state_lgd', 'dist_lgd', 'subdt_lgd'}


def _parquet_from_csv(src: Path, cols: list[str]) -> bytes:
    """The same table as parquet, typed explicitly so 2011 codes keep their leading zeros."""
    types = {c: ('BIGINT' if c in INT_COLUMNS else 'VARCHAR') for c in cols}
    tmp = src.with_suffix('.parquet.part')
    con = duckdb.connect()
    con.execute('SET threads = 1')
    con.execute(f"COPY (SELECT * FROM read_csv('{src}', header = true, quote = '\"', escape = '\"', "
                f"columns = {types!r})) TO '{tmp}' (FORMAT parquet, COMPRESSION zstd)")
    data = tmp.read_bytes()
    tmp.unlink()
    return data


def cached_attributes(con, layer: dict) -> Path:
    """The layer's non-geometry columns as a local parquet, keyed by R2's ETag (one read per change)."""
    url = layer['parquet']['url']
    etag = (head(url)[0] or 'noetag').strip('"')
    dest = CACHE / f'{layer["id"]}-{etag}.parquet'
    if dest.exists():
        log(f'  {layer["id"]}: cached')
        return dest
    CACHE.mkdir(parents=True, exist_ok=True)
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{url}')").fetchall()
            if 'geom' not in r[0].lower()]
    sel = ', '.join(f'"{c}"' for c in cols)
    tmp = dest.with_suffix('.part')
    con.execute(f"COPY (SELECT {sel} FROM read_parquet('{url}')) TO '{tmp}' (FORMAT parquet)")
    tmp.rename(dest)
    log(f'  {layer["id"]}: read from R2')
    return dest


def level_rows(con, path: Path, spec: dict) -> list[dict]:
    ctx = spec['context']
    sel = [f'"{spec["lgd"]}" AS lgd_code', f'"{spec["code11"]}" AS census2011_code', f'"{spec["name"]}" AS name']
    sel += [f'"{src}" AS "{dst}"' for dst, src in ctx.items()]
    cur = con.execute(f"SELECT {', '.join(sel)} FROM read_parquet('{path}')")
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


def release_meta(layers: dict[str, dict], counts: dict[str, int], served: dict[str, dict]) -> dict:
    files = {}
    for level, spec in LEVELS.items():
        layer = layers[spec['layer']]
        for ext in ('csv', 'parquet'):
            files[f'cw_{level}.{ext}'] = {'licence': layer['licence'], 'source_layer': spec['layer'],
                                          'rows': counts[level]}
    att = layers['lgd_districts']['attribution']
    return {
        'dataset': 'cw',
        'title': 'Census 2011 <-> LGD crosswalk',
        'description': 'One table per level (states, districts, subdistricts, blocks, villages): each LGD unit '
                       'with the Census 2011 code its LGD layer carries, and the relation (1:1, split, merge, '
                       'post-2011 code) derived from how the codes repeat.',
        'licence': 'Each file keeps its source layer\'s licence (named per file); bharatlas does not relicense',
        'sources': [
            {'name': att['primary']['name'] + ' (LGD), Ministry of Panchayati Raj, Government of India',
             'url': att['primary']['url'],
             'note': 'LGD codes, and the Census 2011 codes as carried in the LGD boundary data'},
            {'name': att['publisher']['name'], 'url': att['publisher']['url'],
             'version': {spec['layer']: source_version(layers[spec['layer']], github_release)
                         for spec in LEVELS.values()},
             'fetched': {spec['layer']: layers[spec['layer']].get('fetched_at') for spec in LEVELS.values()}},
            {'name': 'bharatlas (the LGD layers as served, read for this crosswalk)', 'url': 'https://bharatlas.com',
             'version': served},
        ],
        'method': __doc__.split('Caching and idempotency')[0].strip(),
        'files': files,
    }


def main(argv=None) -> int:
    catalog = json.loads((ROOT / 'catalog.json').read_text())
    layers = {layer['id']: layer for layer in catalog['layers']}
    con = duckdb.connect()
    con.execute('INSTALL httpfs; LOAD httpfs;')
    counts, changed = {}, False
    for level, spec in LEVELS.items():
        path = cached_attributes(con, layers[spec['layer']])
        rows = derive(level_rows(con, path, spec), spec['status'])
        counts[level] = len(rows)
        changed |= write_level(OUT, level, rows)
        rel = Counter(r['relation'] for r in rows)
        log(f'{level}: {len(rows):,} rows; ' + ', '.join(f'{k} {v:,}' for k, v in rel.most_common()))
    cache = ChecksumCache(RECORD_CACHE / 'served-sha256.jsonl')      # shared with scripts/catalog_record.py
    served = {}
    for spec in LEVELS.values():
        url = layers[spec['layer']]['parquet']['url']
        entry, _ = checksum(url, cache)
        served[spec['layer']] = {'url': url, 'sha256': entry['sha256'], 'bytes': entry['bytes']}
    meta = json.dumps(release_meta(layers, counts, served), indent=1, ensure_ascii=False) + '\n'
    changed |= _write_if_changed(OUT / 'release-meta.json', meta.encode('utf-8'))
    log(f'{"written" if changed else "unchanged"}: {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
