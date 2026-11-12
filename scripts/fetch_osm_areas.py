"""
Fetch OpenStreetMap area names (suburbs, neighbourhoods, quarters) for the number-only ward layers.

Their sources give a ward only a number, but people search "ward 42 <city> which area". OSM's named places are
placed in the ward that contains them by scripts/build_ward_index.py and shown in the view as "Areas
(OpenStreetMap)". They go in the view-only sidecar (web/public/ward-index/<id>.json), never in the layer or its
downloads: the layer keeps what its source published.

Each city's Overpass answer is saved as it arrives in data/osm-areas/<layer>.json (gitignored), so a rerun skips
the cities it already has (pass --refresh to ask again) and a stopped run continues where it stopped.

Usage:
    python3 scripts/fetch_osm_areas.py                  # every number-only ward layer
    python3 scripts/fetch_osm_areas.py wards_jaipur     # one layer
    python3 scripts/fetch_osm_areas.py --refresh        # ask again even where cached
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data' / 'osm-areas'
OVERPASS = 'https://overpass-api.de/api/interpreter'
USER_AGENT = 'bharatlas-ward-areas/1.0 (+https://bharatlas.com)'
KINDS = ('suburb', 'neighbourhood', 'quarter')
PAUSE = 5          # seconds between cities: Overpass is a shared, free service
TRIES = 4


def log(*a) -> None:
    print(*a, flush=True)


def overpass_query(bbox: tuple[float, float, float, float]) -> str:
    """bbox is (west, south, east, north); Overpass wants (south, west, north, east)."""
    w, s, e, n = bbox
    box = f'({s},{w},{n},{e})'
    sel = f'["place"~"^({"|".join(KINDS)})$"]["name"]'
    return f'[out:json][timeout:120];(node{sel}{box};way{sel}{box};relation{sel}{box};);out center tags;'


def junk(name: str) -> bool:
    """A name no map of a city should carry: one starting in lower case ("friend's house"), or someone's place
    ("meow's hose": a lower-case word ending in 's). A proper possessive ("St. Mary's Colony") stays."""
    return name[:1].islower() or bool(re.search(r"(^|\s)[a-z]+'s\b", name))


def places(answer: dict) -> list[dict]:
    """Named places from an Overpass answer: {name (English where OSM has it), kind, lat, lon}. A way or relation
    is placed at its centre; one without a centre or a name is skipped."""
    out = []
    for el in answer.get('elements', []):
        tags = el.get('tags', {})
        name = (tags.get('name:en') or tags.get('name') or '').strip()
        pt = el if el.get('type') == 'node' else el.get('center')
        if not name or junk(name) or not pt or tags.get('place') not in KINDS:
            continue
        out.append({'name': name, 'kind': tags['place'], 'lat': pt['lat'], 'lon': pt['lon']})
    return out


def ask(query: str) -> dict:
    data = urllib.parse.urlencode({'data': query}).encode()
    req = urllib.request.Request(OVERPASS, data=data, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def fetch_one(layer_id: str, bbox: tuple[float, float, float, float], refresh: bool = False) -> str:
    """Save the layer's OSM places to the cache; 'cached' if it is already there."""
    dest = CACHE / f'{layer_id}.json'
    if dest.exists() and not refresh:
        return 'cached'
    for i in range(TRIES):
        try:
            answer = ask(overpass_query(bbox))
            break
        except Exception as e:  # network errors, 429 and 504 from a busy Overpass: wait and try again
            if i == TRIES - 1:
                raise
            log(f'  {layer_id}: {e}; trying again in {30 * (i + 1)} s')
            time.sleep(30 * (i + 1))
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix('.part')
    tmp.write_text(json.dumps({'bbox': list(bbox), 'fetched': date.today().isoformat(),
                               'elements': answer.get('elements', [])}, ensure_ascii=False))
    tmp.replace(dest)            # a stopped run never leaves half a file in the cache
    return f'{len(places(answer))} named places'


def bbox_of(con, parquet: Path) -> tuple[float, float, float, float]:
    geom = next(c for c, t, *_ in con.execute(f"DESCRIBE SELECT * FROM '{parquet}'").fetchall() if str(t).startswith('GEOMETRY'))
    (w, s, e, n), = con.execute(f'SELECT ST_XMin(b), ST_YMin(b), ST_XMax(b), ST_YMax(b) FROM '
                                f'(SELECT ST_Extent_Agg("{geom}") b FROM \'{parquet}\')').fetchall()
    return (round(w, 5), round(s, 5), round(e, 5), round(n, 5))


def main() -> int:
    import duckdb
    import build_ward_index as w
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    refresh = '--refresh' in sys.argv
    catalog = json.loads(w.CATALOG.read_text())
    number_only = {k for k, (_, name, _) in w.OVERRIDES.items() if name is None}
    layers = [l for l in catalog.get('layers', []) if l['id'] in number_only and (not args or l['id'] in args)]
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    log(f'osm-areas: {len(layers)} number-only ward layer(s)')
    for n, layer in enumerate(layers, 1):
        pq = w.find_parquet(layer)
        if not pq:
            log(f'  [{n}/{len(layers)}] {layer["id"]}: no local parquet — skipped')
            continue
        result = fetch_one(layer['id'], bbox_of(con, pq), refresh)
        log(f'  [{n}/{len(layers)}] {layer["id"]}: {result}')
        if result != 'cached' and n < len(layers):
            time.sleep(PAUSE)
    return 0


if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
