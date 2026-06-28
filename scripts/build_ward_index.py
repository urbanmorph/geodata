"""
Generate the ward#→area answer-table sidecars for ward layers.

For each ward layer with a local parquet, resolve its idiosyncratic columns down
to {no, name} pairs and emit a compact, ordered sidecar that the /view edge
function injects as a crawlable HTML table on the ward page. This is the answer
payload for the loudest 0-click GSC cluster ("ward 22 ahmedabad area name",
"vmc ward list area wise vadodara") that a map can't satisfy in the SERP.

Outputs:
  web/public/ward-index/{layer_id}.json   -- {id, place, updated, nameLabel, rows[]}

Only layers that genuinely carry an area/locality (or zone) name are emitted.
Number-only sources (Kolkata, Mumbai letter-codes, Faridabad) are skipped — we
never invent an area name. Data is what it is.

Run after baking ward parquets. Gracefully skips layers whose parquets are absent.

Usage:
    python3 scripts/build_ward_index.py
    python3 scripts/build_ward_index.py wards_ahmedabad   # single layer
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'sources' / 'india-geodata'
OUT = ROOT / 'web' / 'public' / 'ward-index'
CATALOG = ROOT / 'catalog.json'

# Per-layer column maps, keyed by the columns each city's source actually ships
# (verified against the live schemas). (number_col, name_col_or_None, label).
# name_col None => number-only source => no table emitted. Overrides win over the
# heuristic so an ambiguous column (Mumbai's NAME2 is a letter CODE, not an area;
# Bhubaneswar has a zone but no street name) resolves faithfully.
OVERRIDES: dict[str, tuple[str, str | None, str | None]] = {
    # (number_col, name_col_or_None, label). Verified against each city's actual
    # parquet columns — every city ships these under a different name. name_col
    # None => number-only source => no table.
    'wards_ahmedabad':         ('sourcewardcode', 'sourcewardname', 'Area'),
    'wards_vadodara':          ('ward_no',        'ward_name',      'Area'),
    'wards_surat':             ('wardcode',       'wardname',       'Area'),
    'wards_pune':              ('wardnum',        'Name2',          'Area'),
    'wards_bengaluru_gba':     ('ward_id',        'ward_name',      'Area'),
    'wards_bengaluru_bbmp_2022': ('KGISWardNo',   'KGISWardName',   'Area'),
    'wards_mysuru':            ('KGISWardNo',     'KGISWardName',   'Area'),
    'wards_lucknow':           ('Ward Num',       'Ward Name',      'Area'),
    'wards_kanpur':            ('Ward No',        'Ward Name',      'Area'),
    'wards_bhopal':            ('Ward_Number',    'Name',           'Area'),
    'wards_indore':            ('sourcewardcode', 'ward_lgd_name',  'Area'),
    'wards_kochi':             ('sourcewardcode', 'ward_lgd_name',  'Area'),
    # Zone-only sources: no street/area name, but a named municipal zone — itself
    # a real GSC query ("ahmedabad zone list", "bmc zone list", "surat zone map").
    'wards_bhubaneshwar':      ('wardno',         'municipalzone',  'Zone'),
    'wards_vizag':             ('sourcewardcode', 'zone',           'Zone'),
    'wards_madurai':           ('sourcewardcode', 'zone',           'Zone'),
    'wards_coimbatore':        ('2011WardNumbers', 'Zone',          'Zone'),
    # Number-only sources — the name column is the number itself, the city corp
    # string, or absent. We never fabricate an area; these get no table.
    'wards_kolkata':           ('WARD',           None,             None),
    'wards_mumbai':            ('NAME2',          None,             None),
    'wards_patna':             ('wardcode',       None,             None),  # "wardname" is spelled-out numbers (One, Two…)
    'wards_pcmc':              ('wardnum',        None,             None),  # "name" is "NN, Zone X", not a locality
    'wards_guwahati':          ('sourcewardcode', None,             None),  # sourcewardname is "<Null>" for every row
    'wards_faridabad':         ('Ward_No',        None,             None),
    'wards_vijayawada':        ('WARD_NO',        None,             None),
    'wards_chennai':           ('name2',          None,             None),
    'wards_chandigarh':        ('Ward_name',      None,             None),  # "Ward_name" holds the number
    'wards_jaipur':            ('wardcode',       None,             None),  # ward_lgd_name is the corp string
    'wards_gurugram':          ('sourcewardcode', None,             None),
    'wards_thane':             ('sourcewardcode', None,             None),
    'wards_navi_mumbai':       ('sourcewardcode', None,             None),
}

# A few cities pack "Ward 91 Khairatabad" into one column. (column, label).
PARSE_WARD_NAME: dict[str, tuple[str, str]] = {
    'wards_hyderabad': ('Name', 'Area'),
}
PARSE_RE = re.compile(r'^ward\s+(\d+)\s*(.*)$', re.I)

# A resolved name is rejected (treated as absent) when it is really the ward
# number again, an empty/placeholder, or the municipal-corporation string that
# some `ward_lgd_name` columns carry instead of a locality. Keeps Indore's
# "Mundlaa Naayta" and Kochi's "Island North" while dropping "Jaipur (M Corp.)".
NAME_REJECT = re.compile(
    r'\(m\.?\s*corp|\(m\s*cl|^ward\s*no\.?\s*\d*$|^\d+$|^<?null>?$|^none$|^n/?a$|^nil$|^-+$',
    re.I,
)

# Heuristic fallbacks for ward layers without an explicit override, lowest match
# index wins. Kept conservative: a name is only claimed from an unmistakable
# area/locality column, never from a bare "name" that might be the city.
NUMBER_PATTERNS = [
    'sourcewardcode', 'ward_no', 'wardno', 'ward_num', 'wardnum',
    'ward_number', 'wardnumber', 'ward_code', 'wardcode', 'ward',
]
NAME_PATTERNS = ['sourcewardname', 'ward_name', 'wardname', 'ward_title', 'locality']


def find_parquet(layer: dict) -> Path | None:
    pq = layer.get('parquet')
    if not pq or not pq.get('url'):
        return None
    filename = pq['url'].rsplit('/', 1)[-1]
    candidate = SRC / filename
    if candidate.exists():
        return candidate
    r2_base = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/'
    if pq['url'].startswith(r2_base):
        baked = ROOT / 'data' / 'baked' / pq['url'][len(r2_base):]
        if baked.exists():
            return baked
    return None


def resolve_columns(layer_id: str, cols: list[str]) -> tuple[str | None, str | None, str | None]:
    if layer_id in OVERRIDES:
        no_col, name_col, label = OVERRIDES[layer_id]
        present = {c.lower(): c for c in cols}
        no = present.get(no_col.lower())
        name = present.get(name_col.lower()) if name_col else None
        return no, name, (label if name else None)
    lower = {c.lower(): c for c in cols}
    no = next((lower[p] for p in NUMBER_PATTERNS if p in lower), None)
    name = next((lower[p] for p in NAME_PATTERNS if p in lower), None)
    return no, name, ('Area' if name else None)


def clean(v) -> str:
    if v is None:
        return ''
    s = re.sub(r'\s+', ' ', str(v)).strip()
    # Integral floats from parquet ("10.0") read as a plain ward number.
    if re.fullmatch(r'-?\d+\.0+', s):
        s = s[:s.index('.')]
    return s


def sort_key(no: str):
    digits = re.match(r'\d+', no)
    return (0, int(digits.group())) if digits else (1, no.lower())


def place_name(layer_id: str, level_meta: dict) -> str:
    meta = level_meta.get(layer_id, {})
    label = meta.get('label') or ''
    # "Ahmedabad (AMC) Wards" -> "Ahmedabad"; "Vadodara (VMC) Wards" -> "Vadodara"
    base = re.split(r'\s*\(', label)[0]
    base = re.sub(r'\s*wards?\s*$', '', base, flags=re.I).strip()
    if base:
        return base
    return layer_id.replace('wards_', '').replace('_', ' ').title()


def real_name(name: str) -> str:
    """Drop a 'name' that is really the ward number, a placeholder, or the
    municipal-corporation string some columns carry instead of a locality."""
    return '' if (not name or NAME_REJECT.search(name)) else name


def build_one(con, layer: dict, level_meta: dict) -> dict | None:
    layer_id = layer['id']
    pq = find_parquet(layer)
    if not pq:
        print(f'  {layer_id}: no local parquet — skipped')
        return None
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM '{pq}'").fetchall()]

    by_no: dict[str, str] = {}
    if layer_id in PARSE_WARD_NAME:
        # Number and name packed into one column, e.g. "Ward 91 Khairatabad".
        src_col, label = PARSE_WARD_NAME[layer_id]
        present = {c.lower(): c for c in cols}
        col = present.get(src_col.lower())
        if not col:
            print(f'  {layer_id}: parse column {src_col!r} absent — skipped')
            return None
        for (val,) in con.execute(f'SELECT "{col}" FROM \'{pq}\'').fetchall():
            m = PARSE_RE.match(clean(val))
            if not m:
                continue
            no, name = m.group(1), real_name(clean(m.group(2)))
            if no and (no not in by_no or (not by_no[no] and name)):
                by_no[no] = name
    else:
        no_col, name_col, label = resolve_columns(layer_id, cols)
        if not no_col:
            print(f'  {layer_id}: no ward-number column found — skipped')
            return None
        if not name_col:
            print(f'  {layer_id}: number-only source — skipped (no area names to give)')
            return None
        raw = con.execute(f'SELECT "{no_col}" AS no, "{name_col}" AS name FROM \'{pq}\'').fetchall()
        for no_v, name_v in raw:
            no, name = clean(no_v), real_name(clean(name_v))
            if not no:
                continue
            # First non-empty name wins (a ward split across polygons keeps its name).
            if no not in by_no or (not by_no[no] and name):
                by_no[no] = name

    rows = [{'no': no, 'name': by_no[no]} for no in sorted(by_no, key=sort_key)]
    if not any(r['name'] for r in rows):
        print(f'  {layer_id}: resolved name column is empty — skipped')
        return None

    updated = (layer.get('fetched_at') or '')[:10] or None
    return {
        'id': layer_id,
        'place': place_name(layer_id, level_meta),
        'updated': updated,
        'nameLabel': label,
        'rows': rows,
    }


def main() -> int:
    import duckdb
    catalog = json.loads(CATALOG.read_text())
    level_meta = catalog.get('level_meta', {})
    wards = [l for l in catalog.get('layers', []) if l['id'].startswith('wards_')]
    only = sys.argv[1] if len(sys.argv) > 1 else None
    if only:
        wards = [l for l in wards if l['id'] == only]

    OUT.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    written = 0
    for layer in wards:
        idx = build_one(con, layer, level_meta)
        if not idx:
            continue
        dest = OUT / f"{layer['id']}.json"
        dest.write_text(json.dumps(idx, ensure_ascii=False, separators=(',', ':')) + '\n')
        print(f"  {layer['id']}: wrote {len(idx['rows'])} wards ({idx['nameLabel']}) -> {dest.relative_to(ROOT)}")
        written += 1
    print(f'ward-index: wrote {written} sidecar(s) of {len(wards)} ward layer(s)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
