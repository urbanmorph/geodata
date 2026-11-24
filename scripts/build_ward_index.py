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
Number-only sources (Kolkata, Mumbai letter-codes, Faridabad) carry no name of
their own — we never invent one. Where scripts/fetch_osm_areas.py has fetched
OpenStreetMap's suburbs and neighbourhoods for such a city, each ward gets the
`areas` whose point lies inside it, kept apart from the layer's own fields and
credited to OSM (ODbL). The sidecar is view-only: the layer and its downloads
keep what the source published.

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
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402
OUT = ROOT / 'web' / 'public' / 'ward-index'
CATALOG = ROOT / 'catalog.json'
OSM_CACHE = ROOT / 'data' / 'osm-areas'      # scripts/fetch_osm_areas.py writes it
OSM_KIND_ORDER = {'suburb': 0, 'quarter': 1, 'neighbourhood': 2}
ZONE_MIN_UNIQUE = 0.9                         # share of features with their own ward number, for zones to be read
MAX_AREAS = 8                                 # the biggest places first, so a dense ward stays readable

# Which columns hold a ward's number and name in each ward layer, kept in one file read
# here (ward pages) and by web/functions/lib/ward-label.ts (surface_at's summary):
# shared/ward_columns.json. Every city's source names them differently.
#   columns: layer -> (number_col, name_col or None, label). name_col None => a
#            number-only source (no area table). Overrides win over the heuristic, so an
#            ambiguous column (Mumbai's NAME2 is a letter code, not an area) resolves faithfully.
#   parse:   layers that pack number and name into one column: (column, label, pattern
#            with (number)(name) groups; the view reads the number with it, case-insensitive).
#   groups:  layers whose ward numbers restart per sub-body: (group column, its label).
#            Greater Bengaluru's 5 corporations each number their wards from 1.
#   name_reject: a resolved name that is the ward number again, a placeholder, or the
#            corporation string some ward_lgd_name columns carry (dropped, case-insensitive).
#   number_patterns / name_patterns: heuristic fallbacks, lowest index wins; a name is
#            claimed only from an unmistakable area/locality column.
WARD_COLUMNS = json.loads((ROOT / 'shared' / 'ward_columns.json').read_text())
OVERRIDES: dict[str, tuple[str, str | None, str | None]] = {k: tuple(v) for k, v in WARD_COLUMNS['columns'].items()}
PARSE_WARD_NAME: dict[str, tuple[str, str, str]] = {k: tuple(v) for k, v in WARD_COLUMNS['parse'].items()}
NAME_REJECT = re.compile(WARD_COLUMNS['name_reject'], re.I)
GROUPS = {k: tuple(v) for k, v in WARD_COLUMNS['groups'].items()}
NUMBER_PATTERNS = WARD_COLUMNS['number_patterns']
NAME_PATTERNS = WARD_COLUMNS['name_patterns']


find_parquet = pipeline.find_parquet  # tests patch this module attribute


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


def zone_column(layer_id: str, cols: list[str]) -> str | None:
    """The layer's own zone column: one named zone (any case), else the column its override already reads as the
    zone (Bhubaneswar's municipalzone). None when the layer has no zone."""
    named = next((c for c in cols if c.lower() == 'zone'), None)
    if named:
        return named
    no_col, name_col, label = OVERRIDES.get(layer_id, (None, None, None))
    present = {c.lower(): c for c in cols}
    return present.get(name_col.lower()) if name_col and label == 'Zone' else None


def zones_by_ward(con, pq: Path, no_col: str, zone_col: str) -> dict[str, str]:
    """Each ward number's zone, as the layer gives it. A ward whose features sit in different zones gets none, and
    a layer whose ward numbers repeat across many features (Greater Bengaluru numbers each corporation's wards from
    1) gets none at all: there a number names no single ward, so its zone would be a guess."""
    raw = con.execute(f'SELECT "{no_col}", "{zone_col}" FROM \'{pq}\'').fetchall()
    seen: dict[str, set[str]] = {}
    for no_v, zone_v in raw:
        if clean(no_v):
            seen.setdefault(clean(no_v), set()).add(clean(zone_v))
    if len(seen) < ZONE_MIN_UNIQUE * len(raw):
        return {}
    return {no: next(iter(z)) for no, z in seen.items() if len(z) == 1 and z != {''}}


def with_zones(rows: list[dict], zones: dict[str, str]) -> list[dict]:
    """The rows, each with its zone where the layer gives one."""
    return [{**r, 'zone': zones[r['no']]} if r['no'] in zones else r for r in rows]


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


def natural(name: str) -> list:
    """Sort key that reads the numbers in a name as numbers: Sector 2 before Sector 10."""
    return [(0, int(t), '') if t.isdigit() else (1, 0, t) for t in re.findall(r'\d+|\D+', name.lower())]


def areas_by_ward(con, pq: Path, no_col: str, pts: list[dict]) -> dict[str, list[str]]:
    """OSM place names per ward number: each place goes to the ward whose polygon contains its point; suburbs
    first, then quarters, then neighbourhoods, each A to Z; a name once per ward; at most MAX_AREAS."""
    import fetch_osm_areas
    if not pts:
        return {}
    con.execute('INSTALL spatial; LOAD spatial;')
    geom = next(c for c, t, *_ in con.execute(f"DESCRIBE SELECT * FROM '{pq}'").fetchall() if str(t).startswith('GEOMETRY'))
    con.execute('CREATE OR REPLACE TEMP TABLE osm_pts (name VARCHAR, kind VARCHAR, lon DOUBLE, lat DOUBLE)')
    con.executemany('INSERT INTO osm_pts VALUES (?, ?, ?, ?)', [(p['name'], p['kind'], p['lon'], p['lat']) for p in pts])
    hits = con.execute(f"""SELECT w.no, p.name, p.kind FROM (SELECT "{no_col}" AS no, "{geom}" AS g FROM '{pq}') w
                           JOIN osm_pts p ON ST_Contains(w.g, ST_Point(p.lon, p.lat))""").fetchall()
    out: dict[str, list[tuple]] = {}
    for no, name, kind in hits:
        if fetch_osm_areas.junk(name):
            continue
        out.setdefault(clean(no), []).append((OSM_KIND_ORDER.get(kind, 9), natural(name), name.lower(), name))
    result = {}
    for no, items in out.items():
        seen, names = set(), []
        for _, _, low, name in sorted(items):
            if low not in seen:
                seen.add(low)
                names.append(name)
        result[no] = names[:MAX_AREAS]
    return result


def osm_areas(con, layer_id: str, pq: Path, no_col: str) -> tuple[dict[str, list[str]], dict] | None:
    """The layer's OSM areas per ward and their credit, from the fetched cache; None when not fetched."""
    f = OSM_CACHE / f'{layer_id}.json'
    if not f.exists():
        return None
    import fetch_osm_areas
    cached = json.loads(f.read_text())
    by_no = areas_by_ward(con, pq, no_col, fetch_osm_areas.places(cached))
    return by_no, {'name': 'OpenStreetMap contributors', 'licence': 'ODbL-1.0', 'fetched': cached.get('fetched')}


def build_one(con, layer: dict, level_meta: dict) -> dict | None:
    layer_id = layer['id']
    pq = find_parquet(layer)
    if not pq:
        print(f'  {layer_id}: no local parquet — skipped')
        return None
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM '{pq}'").fetchall()]

    by_no: dict[str, str] = {}
    # Which column holds the ward number (and, where it sits inside a name, how to read it), so the view can find
    # a located ward's row: the "My ward" sheet titles it by number (web/src/locate-format.ts wardTitle).
    number = {}
    zones: dict[str, str] = {}
    if layer_id in PARSE_WARD_NAME:
        # Number and name packed into one column, e.g. "Ward 91 Khairatabad".
        src_col, label, pattern = PARSE_WARD_NAME[layer_id]
        parse = re.compile(pattern, re.I)
        present = {c.lower(): c for c in cols}
        col = present.get(src_col.lower())
        if not col:
            print(f'  {layer_id}: parse column {src_col!r} absent — skipped')
            return None
        number = {'numberCol': col, 'numberFrom': pattern}
        zone_col = zone_column(layer_id, cols)
        zone_sql = f'"{zone_col}"' if zone_col else 'NULL'
        zone_sets: dict[str, set[str]] = {}
        for val, zone in con.execute(f'SELECT "{col}", {zone_sql} FROM \'{pq}\'').fetchall():
            m = parse.match(clean(val))
            if not m:
                continue
            no, name = m.group(1), real_name(clean(m.group(2)))
            if no and (no not in by_no or (not by_no[no] and name)):
                by_no[no] = name
            if no and clean(zone):
                zone_sets.setdefault(no, set()).add(clean(zone))
        zones = {no: next(iter(z)) for no, z in zone_sets.items() if len(z) == 1}
    else:
        no_col, name_col, label = resolve_columns(layer_id, cols)
        if not no_col:
            print(f'  {layer_id}: no ward-number column found — skipped')
            return None
        number = {'numberCol': no_col}
        zone_col = zone_column(layer_id, cols)
        zones = zones_by_ward(con, pq, no_col, zone_col) if zone_col else {}
        if not name_col:
            osm = osm_areas(con, layer_id, pq, no_col)
            if not osm:
                print(f'  {layer_id}: number-only source, no OSM areas fetched — skipped')
                return None
            areas, credit = osm
            nos = {clean(v) for (v,) in con.execute(f'SELECT "{no_col}" FROM \'{pq}\'').fetchall()} - {''}
            rows = with_zones([{'no': no, 'name': '', 'areas': areas.get(no, [])} for no in sorted(nos, key=sort_key)], zones)
            print(f'  {layer_id}: number-only source; OSM areas for {sum(1 for r in rows if r["areas"])} of {len(rows)} wards')
            return {'id': layer_id, 'place': place_name(layer_id, level_meta),
                    'updated': (layer.get('fetched_at') or '')[:10] or None,
                    'nameLabel': None, 'rows': rows, 'areasSource': credit, **number}
        group_col, group_label = GROUPS.get(layer_id, (None, None))
        group_col = {c.lower(): c for c in cols}.get(group_col.lower()) if group_col else None
        if group_col:
            return grouped_index(con, layer, level_meta, pq, no_col, name_col, label, group_col, group_label)
        raw = con.execute(f'SELECT "{no_col}" AS no, "{name_col}" AS name FROM \'{pq}\'').fetchall()
        for no_v, name_v in raw:
            no, name = clean(no_v), real_name(clean(name_v))
            if not no:
                continue
            # First non-empty name wins (a ward split across polygons keeps its name).
            if no not in by_no or (not by_no[no] and name):
                by_no[no] = name

    rows = with_zones([{'no': no, 'name': by_no[no]} for no in sorted(by_no, key=sort_key)], zones)
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
        **number,
    }


def grouped_index(con, layer: dict, level_meta: dict, pq: Path, no_col: str, name_col: str, label: str,
                  group_col: str, group_label: str) -> dict:
    """A sidecar keyed by (group, number): every ward listed once per group,
    sorted by group then number. No zones: numbers repeat across groups."""
    by_key: dict[tuple[str, str], str] = {}
    sql = f'SELECT "{group_col}", "{no_col}", "{name_col}" FROM \'{pq}\''
    for g_v, no_v, name_v in con.execute(sql).fetchall():
        g, no, name = clean(g_v), clean(no_v), real_name(clean(name_v))
        if no and ((g, no) not in by_key or (not by_key[(g, no)] and name)):
            by_key[(g, no)] = name
    keys = sorted(by_key, key=lambda k: (k[0].lower(), sort_key(k[1])))
    return {
        'id': layer['id'],
        'place': place_name(layer['id'], level_meta),
        'updated': (layer.get('fetched_at') or '')[:10] or None,
        'nameLabel': label,
        'rows': [{'group': g, 'no': no, 'name': by_key[(g, no)]} for g, no in keys],
        'numberCol': no_col,
        'groupCol': group_col,
        'groupLabel': group_label,
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
