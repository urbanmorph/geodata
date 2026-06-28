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
    'wards_ahmedabad':    ('sourcewardcode', 'sourcewardname', 'Area'),
    'wards_vadodara':     ('ward_no',        'ward_name',      'Area'),
    'wards_surat':        ('wardcode',       'wardname',       'Area'),
    'wards_patna':        ('wardcode',       'wardname',       'Area'),
    'wards_pcmc':         ('wardnum',        'name',           'Area'),
    'wards_bhubaneshwar': ('wardno',         'municipalzone',  'Zone'),
    'wards_kolkata':      ('WARD',           None,             None),
    'wards_mumbai':       ('NAME2',          None,             None),
    'wards_faridabad':    ('Ward_No',        None,             None),
    'wards_vijayawada':   ('WARD_NO',        None,             None),
}

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


def build_one(con, layer: dict, level_meta: dict) -> dict | None:
    layer_id = layer['id']
    pq = find_parquet(layer)
    if not pq:
        print(f'  {layer_id}: no local parquet — skipped')
        return None
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM '{pq}'").fetchall()]
    no_col, name_col, label = resolve_columns(layer_id, cols)
    if not no_col:
        print(f'  {layer_id}: no ward-number column found — skipped')
        return None
    if not name_col:
        print(f'  {layer_id}: number-only source — skipped (no area names to give)')
        return None

    sel = f'"{no_col}" AS no, "{name_col}" AS name'
    raw = con.execute(f'SELECT {sel} FROM \'{pq}\'').fetchall()
    by_no: dict[str, str] = {}
    for no_v, name_v in raw:
        no, name = clean(no_v), clean(name_v)
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
