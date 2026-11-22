#!/usr/bin/env python3
"""
Transit layers: urban rail stations and lines (OpenStreetMap) and bus stops
(open GTFS feeds where they exist, else OpenStreetMap), national, each row
with its city, source, source licence and as-of date.

  urban_rail_stations  metro and RRTS stations in operation
  urban_rail_lines     operational lines as line geometry, one row per line
  bus_stops            one point per stop, from the feed listed for its city

Sources (owner decisions of 18 Nov 2026; research in
supporting-docs/transit-sources-2026-11.md):
  * OpenStreetMap, a dated Geofabrik India extract (ODbL 1.0). Stations are
    the stop members of route relations, snapped to their station; Delhi
    Metro uses station tags (its relations were incomplete). OPERATIONAL
    keeps lines and stations mapped before they open out (Mumbai, Chennai);
    anything disused (the suspended Mumbai Monorail) is out too. Suburban
    rail stays in ir_stations.
  * GTFS feeds, stops only (no timetables): BMTC (Vonter, ODbL), PMPML and
    Mumbai region (croyla, MIT-0), Ahmedabad (croyla, MIT), Chennai MTC
    (CUMTA, no licence stated: government data republished with credit).
  * OpenStreetMap bus stops for Delhi, Kolkata, Kochi and Hyderabad, inside
    each city's own boundary layer (used only to select, never published).
The layers are published under ODbL 1.0 as a whole; every row names its
source and that source's licence.

Steps (each cached under WORK and written atomically, so a killed run redoes
only the step it was in; a second run with the same inputs does nothing):
  pull      download the OSM extract and the feeds (once; --refresh refetches)
  extract   the OSM features transit needs, in three passes over the extract
  bake      the three layers' parquet (flat bbox, Hilbert order), GeoJSON,
            KML and Shapefile, and the audit against the reference counts
  upload    to versioned keys <stem>.<md5[:8]>.<ext> under the shared upload
            lock, skipping files R2 already holds (md5)
  register  patch catalog.json and scripts/external-ingested.json in place
Map tiles come after register, from the published parquet, by
scripts/rebake_tiles.py (popup fields, decode checks, the audit rule).

Run (R2 creds in the env for the cache backup and the upload):
    python3 -u scripts/bake_transit.py all --minutes 120     # pull, extract, bake
    python3 -u scripts/bake_transit.py upload
    python3 -u scripts/bake_transit.py register
    python3 -u scripts/rebake_tiles.py urban_rail_stations urban_rail_lines bus_stops
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pipeline  # noqa: E402
from pipeline import OutOfTime, cached, upload_lock, work_dir  # noqa: E402
from pipeline import atomic_output, log  # noqa: E402
from tile_keys import versioned_key  # noqa: E402

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
MANIFEST = HERE / 'external-ingested.json'
WORK = work_dir('transit', 'TRANSIT_WORK', legacy='/tmp/bharatlas-transit')
CACHE_PREFIX = 'bake_transit'      # R2 cache/bake_transit/: the feeds and the OSM extracts
R2_PREFIX = 'transport/transit'
LOCK_OWNER = 'bake_transit (feat/transit-layers)'
STEP_MINUTES = {'pull': 60, 'extract': 60, 'bake': 30, 'upload': 30}

OSM_LATEST = 'https://download.geofabrik.de/asia/india-latest.osm.pbf'
OSM_LICENCE = 'ODbL-1.0'
OSM_SOURCE = 'OpenStreetMap'
GOVT_NO_LICENCE = 'none stated (government data, republished with credit)'

# One per feed: (key, url, city by agency or one city, source, licence, credit page)
FEEDS = {
    'bmtc': {'url': 'https://github.com/Vonter/bmtc-gtfs/raw/refs/heads/main/gtfs/bmtc.zip',
             'city': 'Bengaluru', 'source': 'BMTC GTFS (Vonter/bmtc-gtfs)', 'licence': 'ODbL-1.0',
             'page': 'https://github.com/Vonter/bmtc-gtfs'},
    'pmpml': {'url': 'https://raw.githubusercontent.com/croyla/pmpml-gtfs/refs/heads/main/pmpml_gtfs_compat.zip',
              'city': 'Pune', 'source': 'PMPML GTFS (croyla/pmpml-gtfs)', 'licence': 'MIT-0',
              'page': 'https://github.com/croyla/pmpml-gtfs'},
    'mumbai': {'url': 'https://github.com/croyla/mumbai-gtfs/raw/refs/heads/main/gtfs_compat.zip',
               'city': {'BEST': 'Mumbai', 'TMT': 'Thane', 'KDMT': 'Kalyan-Dombivli', 'VVMT': 'Vasai-Virar'},
               'source': 'Mumbai region GTFS (croyla/mumbai-gtfs)', 'licence': 'MIT-0',
               'page': 'https://github.com/croyla/mumbai-gtfs'},
    'ahmedabad': {'url': 'https://github.com/croyla/amd-gtfs/raw/refs/heads/main/gtfs_compat.zip',
                  'city': {'AMTS': 'Ahmedabad', 'AJL': 'Ahmedabad', 'GTSL': 'Gandhinagar'},
                  'source': 'Ahmedabad GTFS (croyla/amd-gtfs)', 'licence': 'MIT',
                  'page': 'https://github.com/croyla/amd-gtfs'},
    'chennai_cumta': {'url': 'https://test.cumta.org/static_mtc_gtfs_data.zip',
                      'inner': 'static_mtc_gtfs_data/chennai.bus.gtfs.zip',
                      'city': 'Chennai', 'source': 'CUMTA MTC GTFS (cumta.org)', 'licence': GOVT_NO_LICENCE,
                      'page': 'https://cumta.tn.gov.in/'},
}


# ── small helpers ───────────────────────────────────────────────────────────

def osm_date(name: str) -> str:
    """'india-261117.osm.pbf' -> '2026-11-17': Geofabrik names each extract by its day."""
    m = re.search(r'-(\d{2})(\d{2})(\d{2})\.osm\.pbf$', name)
    if not m:
        raise ValueError(f'not a dated Geofabrik extract: {name}')
    return f'20{m.group(1)}-{m.group(2)}-{m.group(3)}'


def iso_date(value: str | None) -> str | None:
    """A GTFS date (YYYYMMDD) as YYYY-MM-DD; any other version string as published."""
    if value and re.fullmatch(r'20\d{6}', value):
        return f'{value[:4]}-{value[4:6]}-{value[6:]}'
    return value or None


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 6_371_008.8 * math.asin(math.sqrt(a))


class Deadline(pipeline.Deadline):
    """pipeline's run limit (stop between steps, finished steps kept),
    plus a limit per step (STEP_MINUTES), so one slow step can't eat the run."""

    def __init__(self, minutes: float, clock=time.monotonic):
        super().__init__(minutes, clock)
        self.step_end = self.end

    def start(self, step: str) -> None:
        self.check(step)
        self.step_end = min(self.end, self.clock() + STEP_MINUTES.get(step, 60) * 60)
        log(f'== {step}')

    def check(self, what: str) -> None:
        if self.clock() > min(self.end, self.step_end):
            raise OutOfTime(f'time limit reached before {what}')


# ── pull ────────────────────────────────────────────────────────────────────

def dated_extract_url(url: str, location_of: Callable[[str], str | None], hops: int = 5) -> str:
    """Follow redirects from `url` (india-latest) to the dated extract it names."""
    for _ in range(hops):
        try:
            osm_date(url.rsplit('/', 1)[1])
            return url
        except ValueError:
            nxt = location_of(url)
            if not nxt:
                break
            url = urllib.parse.urljoin(url, nxt)
    raise ValueError(f'{url} does not lead to a dated Geofabrik extract')


def head_location(url: str) -> str | None:
    """The Location a HEAD of `url` redirects to, or None."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': pipeline.USER_AGENT})
    try:
        urllib.request.build_opener(NoRedirect).open(req, timeout=60)
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            return e.headers['Location']
        raise
    return None


def latest_extract_url() -> str:
    """Today's dated India extract (Geofabrik redirects india-latest to it, now in two hops)."""
    return dated_extract_url(OSM_LATEST, lambda url: head_location(url))


def get_text(url: str) -> str:
    req = urllib.request.Request(url, headers={'User-Agent': pipeline.USER_AGENT})
    return pipeline.with_retries(lambda: urllib.request.urlopen(req, timeout=60).read().decode())


def sources_path() -> Path:
    return WORK / 'cache' / 'sources.json'


def pull(deadline: Deadline, refresh: bool = False) -> dict:
    """Download the OSM extract (to raw/, 1.7 GB, re-downloadable by its dated
    name) and each feed (to cache/, backed up on R2). A source already pulled
    is never fetched again unless --refresh; sources.json records what was
    fetched (URL, md5, bytes, time)."""
    deadline.start('pull')
    path = sources_path()
    sources = json.loads(path.read_text()) if path.exists() and not refresh else {}
    if 'osm' not in sources:
        url = latest_extract_url()
        name = url.rsplit('/', 1)[1]
        dest = WORK / 'raw' / 'osm' / name
        pipeline.download(url, dest, timeout=600)
        want = get_text(url + '.md5').split()[0]
        got = pipeline.file_md5(dest)
        if got != want:
            dest.unlink()
            raise RuntimeError(f'{name}: md5 {got} is not the published {want}; deleted, re-run to fetch again')
        sources['osm'] = {'url': url, 'file': str(dest), 'md5': got, 'bytes': dest.stat().st_size,
                          'as_of': osm_date(name), 'fetched_at': pipeline.now_iso()}
        _save_sources(path, sources)
    for key, feed in FEEDS.items():
        deadline.check(f'pull {key}')
        dest = WORK / 'cache' / 'gtfs' / f'{key}.zip'
        if refresh and key not in sources:
            dest.unlink(missing_ok=True)
        pipeline.download(feed['url'], dest)
        if key not in sources:
            sources[key] = {'url': feed['url'], 'md5': pipeline.file_md5(dest), 'bytes': dest.stat().st_size,
                            'as_of': feed_as_of(dest, feed), 'fetched_at': pipeline.now_iso()}
            _save_sources(path, sources)
        log(f'  {key}: {sources[key]["bytes"]:,} bytes, as of {sources[key]["as_of"]}')
    return sources


def osm_dir(sources: dict) -> Path:
    return WORK / 'cache' / 'osm' / sources['osm']['as_of']


RAIL_ROUTES = ('subway', 'light_rail', 'monorail')
# Features any of the three layers can use: stations, stops and platforms
# (rail and bus). Kept whatever their state; is_live() decides later.
FEATURE_SQL = """
    (kind = 'relation' AND (tags['route'] IN {routes} OR tags['route_master'] IN {routes}))
 OR (kind IN ('node', 'way') AND (tags['railway'] IN ('station', 'halt', 'stop', 'platform')
                                  OR tags['public_transport'] IN ('station', 'stop_position', 'platform')
                                  OR tags['highway'] = 'bus_stop'))"""


def extract(sources: dict, deadline: Deadline) -> Path:
    """Three passes over the extract, each cached: (1) route relations and
    tagged stations/stops, (2) the ways those reference or are, (3) the
    nodes those ways use. Everything else in the 1.7 GB file is skipped."""
    deadline.start('extract')
    pbf, out = sources['osm']['file'], osm_dir(sources)
    con = pipeline.make_con()
    con.execute(f"SET temp_directory = '{WORK / 'duckdb_tmp'}'")
    read = f"ST_ReadOSM('{pbf}')"

    def pass1(part: Path) -> None:
        con.execute(f"""COPY (SELECT kind::VARCHAR AS kind, id, tags, refs, ref_roles,
                                     ref_types::VARCHAR[] AS ref_types, lat, lon
                              FROM {read} WHERE {FEATURE_SQL.format(routes=RAIL_ROUTES)})
                        TO '{part}' (FORMAT PARQUET)""")

    def pass2(part: Path) -> None:
        con.execute(f"""COPY (
            WITH wanted AS (
                SELECT UNNEST(refs) AS id, UNNEST(ref_types) AS t FROM read_parquet('{out / 'features.parquet'}')
                WHERE kind = 'relation'
                UNION ALL SELECT id, 'way' FROM read_parquet('{out / 'features.parquet'}') WHERE kind = 'way')
            SELECT w.id, w.tags, w.refs FROM {read} w
            WHERE w.kind = 'way' AND w.id IN (SELECT id FROM wanted WHERE t = 'way')) TO '{part}' (FORMAT PARQUET)""")

    def pass3(part: Path) -> None:
        con.execute(f"""COPY (
            SELECT n.id, n.lon, n.lat FROM {read} n
            WHERE n.kind = 'node' AND n.id IN (SELECT UNNEST(refs) FROM read_parquet('{out / 'ways.parquet'}')))
            TO '{part}' (FORMAT PARQUET)""")

    for name, build in (('features', pass1), ('ways', pass2), ('way_nodes', pass3)):
        deadline.check(f'extract {name}')
        t0 = time.monotonic()
        if not (out / f'{name}.parquet').exists():
            cached(out / f'{name}.parquet', build)
            log(f'  {name}: {pipeline.parquet_rows(out / f"{name}.parquet"):,} rows in {time.monotonic() - t0:,.0f} s')
    return out


WAY_GEOM_SQL = """
    CREATE OR REPLACE TEMP TABLE way_geom AS
    SELECT u.id, ST_MakeLine(list(ST_Point(n.lon, n.lat) ORDER BY u.i)) AS geom
    FROM (SELECT id, UNNEST(refs) AS ref, UNNEST(generate_series(1, len(refs))) AS i
          FROM read_parquet('{ways}')) u
    JOIN read_parquet('{nodes}') n ON n.id = u.ref
    GROUP BY u.id HAVING count(*) >= 2"""


def load_osm(con, osm: Path) -> tuple[dict, list[dict]]:
    """({(type, id): feature}, [route relation]) from the extract. A feature
    is {type, id, tags, lon, lat} (a way at its centroid); a route is
    {id, tags, members: [(type, id, role)]}. Also leaves way_geom in `con`."""
    con.execute(WAY_GEOM_SQL.format(ways=osm / 'ways.parquet', nodes=osm / 'way_nodes.parquet'))
    rows = con.execute(f"""
        SELECT f.kind, f.id, map_keys(f.tags), map_values(f.tags), f.refs, f.ref_types, f.ref_roles,
               coalesce(f.lon, ST_X(ST_Centroid(g.geom))), coalesce(f.lat, ST_Y(ST_Centroid(g.geom)))
        FROM read_parquet('{osm / 'features.parquet'}') f
        LEFT JOIN way_geom g ON f.kind = 'way' AND g.id = f.id
        ORDER BY f.kind, f.id""").fetchall()
    features, routes = {}, []
    for kind, oid, keys, values, refs, types, roles, lon, lat in rows:
        tags = dict(zip(keys, values))
        if kind == 'relation':
            routes.append({'id': oid, 'tags': tags, 'members': list(zip(types or [], refs or [], roles or []))})
        elif lon is not None:
            features[(kind, oid)] = {'type': kind, 'id': oid, 'tags': tags, 'lon': lon, 'lat': lat}
    return features, routes


# ── urban rail: systems, the reference counts, operational lists ───────────

WIKI_URL = 'https://en.wikipedia.org/wiki/Urban_rail_transit_in_India'
WIKI_REVISION = 1386429359          # 2026-11-18T13:56:58Z, read 18 Nov 2026
# OSM network -> system (Wikipedia's name), city, mode, Wikipedia's operational
# station count and its basis: 'line' when the count adds up each line's
# stations (its footnote, or the per-line table summing to it), so an
# interchange counts once per line; 'station' when each station counts once.
SYSTEMS = {
    'Agra Metro': ('Agra Metro', 'Agra', 'metro', 6, 'station'),
    'Ahmedabad Metro': ('Ahmedabad Metro', 'Ahmedabad', 'metro', 53, 'station'),
    'Bhoj Metro': ('Bhoj Metro', 'Bhopal', 'metro', 8, 'station'),
    'Chennai Metro': ('Chennai Metro', 'Chennai', 'metro', 52, 'station'),
    'Delhi Metro': ('Delhi Metro', 'Delhi', 'metro', 271, 'line'),
    'Rapid Metro Gurgaon': ('Gurugram Metro', 'Gurugram', 'metro', 11, 'station'),
    'Hyderabad Metro': ('Hyderabad Metro', 'Hyderabad', 'metro', 59, 'station'),
    'Indore Metro': ('Indore Metro', 'Indore', 'metro', 16, 'station'),
    'Jaipur Metro': ('Jaipur Metro', 'Jaipur', 'metro', 11, 'station'),
    'Kanpur Metro': ('Kanpur Metro', 'Kanpur', 'metro', 14, 'station'),
    'Kochi Metro': ('Kochi Metro', 'Kochi', 'metro', 25, 'station'),
    'Kolkata Metro': ('Kolkata Metro', 'Kolkata', 'metro', 58, 'line'),
    'Lucknow Metro': ('Lucknow Metro', 'Lucknow', 'metro', 21, 'station'),
    'Meerut Metro': ('Meerut Metro', 'Meerut', 'metro', 13, 'station'),
    'Mumbai Metro': ('Mumbai Metro', 'Mumbai', 'metro', 77, 'station'),
    'MMRDA': ('Mumbai Monorail', 'Mumbai', 'monorail', 17, 'station'),
    'Nagpur Metro': ('Nagpur Metro', 'Nagpur', 'metro', 37, 'station'),
    'Namma Metro': ('Namma Metro', 'Bengaluru', 'metro', 91, 'line'),
    'Navi Mumbai Metro': ('Navi Mumbai Metro', 'Navi Mumbai', 'metro', 11, 'station'),
    'Noida Metro': ('Noida Metro', 'Noida', 'metro', 21, 'station'),
    'Patna Metro': ('Patna Metro', 'Patna', 'metro', 5, 'station'),
    'Pune Metro': ('Pune Metro', 'Pune', 'metro', 46, 'line'),
    'RapidX': ('Delhi-Meerut RRTS (Namo Bharat)', 'Delhi NCR', 'rrts', 15, 'station'),
}
# Operational lines per system (the same table; Mumbai Metro: its own article's
# 4 operational and 2 partly operational lines).
WIKI_LINES = {'Agra Metro': 1, 'Ahmedabad Metro': 4, 'Bhoj Metro': 1, 'Chennai Metro': 3, 'Delhi Metro': 10,
              'Gurugram Metro': 1, 'Hyderabad Metro': 3, 'Indore Metro': 1, 'Jaipur Metro': 1, 'Kanpur Metro': 1,
              'Kochi Metro': 1, 'Kolkata Metro': 5, 'Lucknow Metro': 1, 'Meerut Metro': 1, 'Mumbai Metro': 6,
              'Mumbai Monorail': 1, 'Nagpur Metro': 2, 'Namma Metro': 4, 'Navi Mumbai Metro': 1, 'Noida Metro': 1,
              'Patna Metro': 1, 'Pune Metro': 3, 'Delhi-Meerut RRTS (Namo Bharat)': 1}
# Delhi Metro's line relations were incomplete when this was planned; it is
# taken from station tags (lines still come from the routes that stop there).
FROM_STATION_TAGS = {'Delhi Metro'}
# Systems with lines mapped before they open: the lines in operation by OSM
# ref, and for a partly open line its stations in operation (names as in OSM).
# Checked against Wikipedia (Mumbai Metro, Yellow and Red Line (Mumbai Metro),
# Chennai Metro, Yellow Line (Chennai Metro)), 18 Nov 2026.
OPERATIONAL = {
    'Mumbai Metro': {'lines': {'1', '2', '2B', '3', '7', '9'},
                     'stations': {'2B': {'Chembur', 'Diamond Garden', 'Shivaji Chowk (Chembur)', 'Deonar',
                                         'Mankhurd', 'Mandale'},
                                  '9': {'Dahisar (East) [Line 9]', 'Pandurang Wadi', 'Miragaon', 'Kashigaon'}}},
    'Chennai Metro': {'lines': {'1', '2', '2A', '4'},
                      'stations': {'4': {'Poonamallee Bypass', 'Poonamallee Bus Stand',
                                         'Poonamallee Government Hospital', 'Karayanchavadi', 'Kumananchavadi',
                                         'Kattupakkam', 'Iyappanthangal', 'Thelliyaragaram', 'Porur Bypass',
                                         'Porur Junction', 'Vadapalani'}}},
}
SNAP_M = 400       # a stop this close to a station belongs to it (same name first)
SNAP_ANY_M = 150   # ... or, with another name, this close
MERGE_M = 1500     # one system's same-name stations this close are one station
LIFECYCLE = ('construction', 'proposed', 'disused', 'abandoned', 'planned', 'razed', 'demolished')


def is_live(tags: dict) -> bool:
    """False for anything mapped as under construction, proposed, disused or
    closed: a lifecycle key (construction=*, disused:route=*), a lifecycle
    value (railway=proposed) or '(u/c)' / 'under construction' in the name."""
    if any(k.split(':')[0] in LIFECYCLE for k in tags):
        return False
    if any(tags.get(k) in LIFECYCLE for k in ('railway', 'public_transport', 'station', 'route')):
        return False
    return not re.search(r'\(u/c\)|under construction', tags.get('name') or '', re.I)


def line_label(tags: dict) -> str:
    """'Blue Line (A -> B)' / 'Green Line: A -> B' -> the line's own name."""
    return re.split(r'\s*[(:]', tags.get('name') or tags.get('ref') or '', maxsplit=1)[0].strip()


LINE_QUALIFIER = re.compile(r'\s*[(\[][^()\[\]]*\bline\b[^()\[\]]*[)\]]\s*$', re.I)


def station_name(name: str | None) -> str | None:
    """'Kirti Nagar (Blue Line)' -> 'Kirti Nagar': OSM maps many interchanges as
    one station per line, told apart by a trailing line qualifier."""
    return LINE_QUALIFIER.sub('', name) if name else name


def norm_name(name: str | None) -> str:
    s = re.sub(r'[^\w]+', ' ', (name or '').lower())
    s = re.sub(r'\b(metro\s+station|metro|station)\b', ' ', s)
    return ' '.join(s.split())


def system_of(tags: dict) -> dict | None:
    hit = SYSTEMS.get(tags.get('network') or '')
    if not hit:
        return None
    system, city, mode, count, basis = hit
    return {'system': system, 'city': city, 'mode': mode, 'reference': count, 'basis': basis}


def _route_ok(route: dict, sysinfo: dict | None) -> bool:
    if not sysinfo or route['tags'].get('route') not in RAIL_ROUTES or not is_live(route['tags']):
        return False   # also leaves out route_master relations (a grouping, not a line)
    ops = OPERATIONAL.get(sysinfo['system'])
    return ops is None or route['tags'].get('ref') in ops['lines']


def _station_ok(system: str, ref: str | None, name: str | None) -> bool:
    allowed = (OPERATIONAL.get(system) or {}).get('stations', {}).get(ref)
    return allowed is None or name in allowed


def is_transit_station(tags: dict) -> bool:
    return (tags.get('railway') == 'station' or tags.get('public_transport') == 'station') and (
        tags.get('station') in RAIL_ROUTES or any(tags.get(m) == 'yes' for m in RAIL_ROUTES))


class _Grid:
    """Points bucketed by about 0.01 degree, for 'what is within r metres'."""

    def __init__(self, items: list[dict]):
        self.cells: dict[tuple[int, int], list[dict]] = defaultdict(list)
        for it in items:
            self.cells[(int(it['lon'] * 100), int(it['lat'] * 100))].append(it)

    def near(self, lon: float, lat: float, r: float) -> list[tuple[float, dict]]:
        cx, cy, span = int(lon * 100), int(lat * 100), int(r / 1000) + 1
        out = [(haversine_m(lon, lat, it['lon'], it['lat']), it)
               for dx in range(-span, span + 1) for dy in range(-span, span + 1)
               for it in self.cells.get((cx + dx, cy + dy), ())]
        return sorted((d, it) for d, it in out if d <= r) if out else []


def _snap(stop: dict, grid: _Grid) -> dict:
    """The station a stop belongs to: same name within SNAP_M, else any within
    SNAP_ANY_M, else the stop itself."""
    near = [(d, s['type'], s['id'], s) for d, s in grid.near(stop['lon'], stop['lat'], SNAP_M)]
    near.sort(key=lambda x: x[:3])
    same = [s for d, _, _, s in near if norm_name(s['tags'].get('name')) == norm_name(stop['tags'].get('name'))]
    close = [s for d, _, _, s in near if d <= SNAP_ANY_M]
    return (same or close or [stop])[0]


def _groups(items: list[dict]) -> list[list[dict]]:
    """Union same (system, name) items within MERGE_M of each other."""
    parent = list(range(len(items)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    by_key: dict[tuple, list[int]] = defaultdict(list)
    for i, it in enumerate(items):
        by_key[(it['system'], norm_name(station_name(it['feature']['tags'].get('name'))))].append(i)
    for idx in by_key.values():
        for a in idx:
            for c in idx:
                if a < c and haversine_m(items[a]['feature']['lon'], items[a]['feature']['lat'],
                                         items[c]['feature']['lon'], items[c]['feature']['lat']) <= MERGE_M:
                    parent[find(c)] = find(a)
    out: dict[int, list[dict]] = defaultdict(list)
    for i, it in enumerate(items):
        out[find(i)].append(it)
    return list(out.values())


def build_stations(features: dict, routes: list[dict]) -> list[dict]:
    """One row per station in operation: the stops of operational route
    relations snapped to their station, or (FROM_STATION_TAGS) the system's
    live station features; same-name stations within MERGE_M are one row."""
    stations = [f for f in features.values() if is_transit_station(f['tags']) and is_live(f['tags'])]
    grid = _Grid(stations)
    items = []   # {'system', 'info', 'feature', 'line', 'ref'}
    for r in sorted(routes, key=lambda r: r['id']):
        info = system_of(r['tags'])
        if not _route_ok(r, info):
            continue
        for t, oid, role in r['members']:
            stop = features.get((t, oid))
            if stop is None or not (role or '').startswith('stop'):
                continue
            if not _station_ok(info['system'], r['tags'].get('ref'), stop['tags'].get('name')):
                continue
            items.append({'system': info['system'], 'info': info, 'feature': _snap(stop, grid),
                          'line': line_label(r['tags']), 'route': True})
    lines_at = defaultdict(set)
    for it in items:
        lines_at[(it['system'], norm_name(station_name(it['feature']['tags'].get('name'))))].add(it['line'])
    tagged = [it for it in items if it['system'] not in FROM_STATION_TAGS]
    for f in stations:
        info = system_of(f['tags'])
        if info and info['system'] in FROM_STATION_TAGS:
            tagged.append({'system': info['system'], 'info': info, 'feature': f, 'line': None, 'route': False})
    rows = []
    for group in _groups(tagged):
        f = min((it['feature'] for it in group),
                key=lambda f: (not is_transit_station(f['tags']), f['type'] != 'node', f['id']))
        info = group[0]['info']
        lines = sorted({it['line'] for it in group if it['line']}
                       | lines_at.get((info['system'], norm_name(station_name(f['tags'].get('name')))), set()))
        t = f['tags']
        rows.append({'name': station_name(t.get('name')), 'name_hi': station_name(t.get('name:hi')),
                     'system': info['system'],
                     'operator': t.get('operator'), 'mode': info['mode'], 'lines': '; '.join(lines) or None,
                     'line_count': len(lines), 'city': info['city'], 'wikidata': t.get('wikidata'),
                     'osm_type': f['type'], 'osm_id': f['id'], 'lon': f['lon'], 'lat': f['lat']})
    return sorted(rows, key=lambda r: (r['system'], r['name'] or '', r['osm_id']))


def build_lines(routes: list[dict]) -> list[dict]:
    """One row per operational line (system + ref, both directions merged):
    name, ref, colour, operator, from, to and the ways to draw it with."""
    ok = [(system_of(r['tags'])['system'], r) for r in sorted(routes, key=lambda r: r['id'])
          if _route_ok(r, system_of(r['tags']))]
    # a direction mapped without a ref takes the ref its same-named sibling has (when only one does)
    refs: dict[tuple, set] = defaultdict(set)
    for system, r in ok:
        if r['tags'].get('ref'):
            refs[(system, line_label(r['tags']))].add(r['tags']['ref'])
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for system, r in ok:
        sibling = refs.get((system, line_label(r['tags'])), set())
        ref = r['tags'].get('ref') or (next(iter(sibling)) if len(sibling) == 1 else line_label(r['tags']))
        groups[(system, ref)].append(r)
    out = []
    for (system, _), rs in sorted(groups.items()):
        info = system_of(rs[0]['tags'])
        first = lambda k: next((r['tags'][k] for r in rs if r['tags'].get(k)), None)  # noqa: E731
        ways = sorted({oid for r in rs for t, oid, role in r['members']
                       if t == 'way' and not (role or '').startswith(('platform', 'stop'))})
        out.append({'name': line_label(rs[0]['tags']), 'ref': first('ref'), 'colour': first('colour'),
                    'system': system, 'operator': first('operator'), 'mode': info['mode'], 'from': first('from'),
                    'to': first('to'), 'city': info['city'], 'osm_ids': ';'.join(f'r{r["id"]}' for r in rs),
                    'ways': ways})
    return out


def audit_stations(rows: list[dict], tagged: dict[str, int]) -> dict:
    """Per system: rows, station-line pairs, the OSM tagged count, Wikipedia's
    count, the difference on the reference's basis and whether it is within 2."""
    out = {}
    for system, city, mode, count, basis in sorted(SYSTEMS.values()):
        mine = [r for r in rows if r['system'] == system]
        n, pairs = len(mine), sum(max(r['line_count'], 1) for r in mine)
        compared = pairs if basis == 'line' else n
        out[system] = {'city': city, 'rows': n, 'station_lines': pairs, 'osm_tagged': tagged.get(system, 0),
                       'reference': count, 'basis': basis, 'compared': compared, 'diff': compared - count,
                       'ok': abs(compared - count) <= 2}
    return out


def is_bus_stop(tags: dict) -> bool:
    platform = tags.get('public_transport') == 'platform' and tags.get('bus') == 'yes'
    return tags.get('highway') == 'bus_stop' or platform


# Cities whose bus stops come from OSM, each inside its own boundary layer
# (catalog layer, row filter): used only to select stops, never published.
OSM_BUS_CITIES = {
    'Delhi': ('lgd_states', "upper(STNAME) LIKE '%DELHI%'"),
    'Kolkata': ('wards_kolkata', None),
    'Kochi': ('wards_kochi', None),
    'Hyderabad': ('wards_hyderabad', None),
}


def area_path(layer_id: str) -> Path:
    return WORK / 'cache' / 'areas' / f'{layer_id}.parquet'


def osm_bus_stops(con, features: dict) -> list[dict]:
    """OSM bus stops (highway=bus_stop, or a bus platform) inside each
    OSM_BUS_CITIES boundary, as stop rows (stop_id 'node/<id>' or 'way/<id>')."""
    stops = [f for f in features.values() if is_bus_stop(f['tags'])]
    con.execute('CREATE OR REPLACE TEMP TABLE osm_stops (i INTEGER, lon DOUBLE, lat DOUBLE)')
    con.executemany('INSERT INTO osm_stops VALUES (?, ?, ?)', [(i, f['lon'], f['lat']) for i, f in enumerate(stops)])
    rows = []
    for city, (layer_id, where) in OSM_BUS_CITIES.items():
        src = area_path(layer_id)
        col, typ = next((r[0], r[1]) for r in con.execute(f"DESCRIBE SELECT * FROM '{src}'").fetchall()
                        if r[0] in ('geometry', 'geom', 'wkb_geometry'))
        geom = col if 'GEOMETRY' in typ else f'ST_GeomFromWKB({col})'
        hits = con.execute(f"""
            WITH area AS (SELECT ST_Union_Agg(ST_MakeValid({geom})) AS g
                          FROM '{src}' {f'WHERE {where}' if where else ''})
            SELECT s.i FROM osm_stops s, area WHERE ST_Intersects(area.g, ST_Point(s.lon, s.lat)) ORDER BY s.i
            """).fetchall()
        for (i,) in hits:
            f = stops[i]
            rows.append({'stop_id': f'{f["type"]}/{f["id"]}', 'name': f['tags'].get('name'), 'city': city,
                         'operator': f['tags'].get('operator') or f['tags'].get('network'),
                         'lon': f['lon'], 'lat': f['lat']})
        log(f'  OpenStreetMap {city}: {len(hits):,} stops')
    return rows


def _save_sources(path: Path, sources: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with atomic_output(path) as part:
        part.write_text(json.dumps(sources, indent=1, sort_keys=True) + '\n')


# ── GTFS ────────────────────────────────────────────────────────────────────

def _read_csv(zf: zipfile.ZipFile, name: str) -> list[dict]:
    """A GTFS table as dicts (empty when the feed leaves it out); BOM and
    surrounding spaces in headers are ignored."""
    member = next((n for n in zf.namelist() if n.rsplit('/', 1)[-1] == name), None)
    if member is None:
        return []
    with zf.open(member) as f:
        text = io.TextIOWrapper(f, encoding='utf-8-sig', newline='')
        reader = csv.DictReader(text)
        reader.fieldnames = [h.strip() for h in reader.fieldnames or []]
        return [{k: (v or '').strip() for k, v in row.items() if k} for row in reader]


def open_feed(path: Path, feed: dict) -> zipfile.ZipFile:
    """The feed's GTFS zip; feed['inner'] names a GTFS zip inside the download
    (CUMTA wraps its feed with GeoJSON copies)."""
    zf = zipfile.ZipFile(path)
    if not feed.get('inner'):
        return zf
    with zf:
        return zipfile.ZipFile(io.BytesIO(zf.read(feed['inner'])))


def feed_as_of(path: Path, feed: dict) -> str | None:
    """feed_info.feed_version when it is a date, else feed_info.feed_start_date,
    else the earliest calendar start_date, as YYYY-MM-DD."""
    with open_feed(path, feed) as zf:
        info = (_read_csv(zf, 'feed_info.txt') or [{}])[0]
        version = iso_date(info.get('feed_version'))
        if version and re.fullmatch(r'\d{4}-\d{2}-\d{2}', version):
            return version
        starts = [r['start_date'] for r in _read_csv(zf, 'calendar.txt') if r.get('start_date')]
        return iso_date(info.get('feed_start_date') or (min(starts) if starts else None))


def _serving_agencies(zf: zipfile.ZipFile) -> dict[str, list[str]]:
    """{stop_id: agency ids serving it, in agency.txt order}, through
    stop_times -> trips -> routes. Only the two id columns are kept."""
    agency_of_route = {r['route_id']: r.get('agency_id', '') for r in _read_csv(zf, 'routes.txt')}
    agency_of_trip = {r['trip_id']: agency_of_route.get(r['route_id'], '') for r in _read_csv(zf, 'trips.txt')}
    order = {r.get('agency_id', ''): i for i, r in enumerate(_read_csv(zf, 'agency.txt'))}
    served: dict[str, set[str]] = defaultdict(set)
    member = next(n for n in zf.namelist() if n.rsplit('/', 1)[-1] == 'stop_times.txt')
    with zf.open(member) as f:
        for row in csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig', newline='')):
            row = {k.strip(): v for k, v in row.items() if k}
            served[row['stop_id'].strip()].add(agency_of_trip.get(row['trip_id'].strip(), ''))
    return {s: sorted(a, key=lambda x: order.get(x, len(order))) for s, a in served.items()}


def gtfs_stops(path: Path, key: str, feed: dict) -> list[dict]:
    """The feed's stops and platforms (location_type 0 or empty) with a
    position: stop_id, name, city, operator, lon, lat. A one-agency feed's
    operator is that agency; otherwise every agency serving the stop, and the
    city is the first one's (feed['city'] maps agency id to city)."""
    with open_feed(path, feed) as zf:
        agencies = _read_csv(zf, 'agency.txt')
        names = {a.get('agency_id', ''): a.get('agency_name') or None for a in agencies}
        serving = _serving_agencies(zf) if len(agencies) > 1 else None
        rows = []
        for s in _read_csv(zf, 'stops.txt'):
            if s.get('location_type', '') not in ('', '0') or not s.get('stop_lat') or not s.get('stop_lon'):
                continue
            if serving is None:
                operator, city = (next(iter(names.values()), None), feed['city'])
            else:
                ids = serving.get(s['stop_id'], [])
                operator = '; '.join(names.get(a) or a for a in ids) or None
                city = feed['city'].get(ids[0]) if ids else None
            rows.append({'stop_id': s['stop_id'], 'name': s.get('stop_name') or None, 'city': city,
                         'operator': operator, 'lon': float(s['stop_lon']), 'lat': float(s['stop_lat'])})
    log(f'  {key}: {len(rows):,} stops')
    return rows


# ── bake ────────────────────────────────────────────────────────────────────

EXT = {'parquet': 'parquet', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
COLUMNS = {   # published columns, in order (geometry last); VARCHAR unless named
    'urban_rail_stations': ['name', 'name_hi', 'system', 'city', 'mode', 'lines', 'operator', 'wikidata',
                            'osm_type', ('osm_id', 'BIGINT'), 'source', 'source_licence', 'as_of'],
    'urban_rail_lines': ['name', 'ref', 'colour', 'system', 'city', 'mode', 'operator', 'from', 'to', 'osm_ids',
                         'source', 'source_licence', 'as_of'],
    'bus_stops': ['stop_id', 'name', 'city', 'operator', 'source', 'source_licence', 'as_of'],
}


def out_dir() -> Path:
    return WORK / 'out'


def _cols(lid: str) -> list[tuple[str, str]]:
    return [(c, 'VARCHAR') if isinstance(c, str) else c for c in COLUMNS[lid]]


def write_parquet(con, lid: str, rows: list[dict], geometry_sql: str, out: Path, tmp: Path) -> int:
    """rows -> parquet with the layer's columns, flat bbox and Hilbert order
    (pipeline.rebake_flatten_bbox). `geometry_sql` builds the geometry from a
    row's other fields (lon/lat, or a WKT)."""
    cols = _cols(lid)
    ndjson, raw = tmp / f'{lid}.ndjson', tmp / f'{lid}.raw.parquet'
    with ndjson.open('w') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    extra = {'lon': 'DOUBLE', 'lat': 'DOUBLE', 'wkt': 'VARCHAR'}
    spec = ', '.join(f"'{c}': '{t}'" for c, t in [*cols, *extra.items()])
    select = ', '.join(f'"{c}"' for c, _ in cols)
    con.execute(f"""COPY (SELECT {select}, {geometry_sql} AS geometry
                          FROM read_json('{ndjson}', format = 'newline_delimited', columns = {{{spec}}}))
                    TO '{raw}' (FORMAT PARQUET)""")
    n, _ = pipeline.rebake_flatten_bbox(raw, out, con)
    return n


def write_downloads(con, lid: str, parquet: Path, stage: Path) -> dict[str, Path]:
    """GeoJSON, KML and a zipped Shapefile (with its columns.txt key) from the parquet."""
    import bake_formats
    from bake_extracts import write_kml_from_geojson
    from bake_whole_layer import write_geojson_whole
    base = LAYERS[lid]['basename']
    paths = {fmt: stage / f'{base}.{ext}' for fmt, ext in EXT.items() if fmt != 'parquet'}
    write_geojson_whole(con, parquet, paths['geojson'])
    write_kml_from_geojson(paths['geojson'], lid, paths['kml'])
    props = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM '{parquet}'").fetchall() if 'GEOMETRY' not in r[1]]
    bake_formats.shapefile_zip_from_geojson(paths['geojson'], paths['shapefile'],
                                            bake_formats.short_field_names(props))
    return paths


def line_geometries(con, lines: list[dict]) -> list[str | None]:
    """Each line's ways merged (ST_LineMerge of their union), as WKT."""
    con.execute('CREATE OR REPLACE TEMP TABLE line_ways (i INTEGER, way BIGINT)')
    con.executemany('INSERT INTO line_ways VALUES (?, ?)', [(i, w) for i, ln in enumerate(lines) for w in ln['ways']])
    got = dict(con.execute("""SELECT l.i, ST_AsText(ST_LineMerge(ST_Union_Agg(g.geom)))
                              FROM line_ways l JOIN way_geom g ON g.id = l.way GROUP BY l.i""").fetchall())
    return [got.get(i) for i in range(len(lines))]


def tagged_counts(features: dict) -> dict[str, int]:
    """Per system, distinct names of live stations tagged in OSM (the
    research's 'tagged' count; a cross-check, not the layer)."""
    names = defaultdict(set)
    for f in features.values():
        info = system_of(f['tags'])
        if info and is_transit_station(f['tags']) and is_live(f['tags']):
            names[info['system']].add(norm_name(station_name(f['tags'].get('name'))))
    return {k: len(v) for k, v in names.items()}


def audit_lines(lines: list[dict]) -> dict:
    """Per system: lines built (and their refs) against Wikipedia's operational lines."""
    out = {}
    for system, *_ in sorted(SYSTEMS.values()):
        refs = sorted(ln['ref'] or ln['name'] for ln in lines if ln['system'] == system)
        out[system] = {'lines': len(refs), 'refs': refs, 'reference': WIKI_LINES[system],
                       'diff': len(refs) - WIKI_LINES[system]}
    return out


def audit_bus(rows: list[dict]) -> dict:
    by = Counter((r['city'], r['source']) for r in rows)
    ordered = sorted(by.items(), key=lambda kv: (str(kv[0][0]), kv[0][1]))
    return {f'{city} | {source}': n for (city, source), n in ordered}


def _inputs_hash(sources: dict) -> str:
    import hashlib
    h = hashlib.md5(json.dumps(sources, sort_keys=True).encode())
    areas = [area_path(layer_id) for layer_id, _ in OSM_BUS_CITIES.values()]
    for p in (Path(__file__), HERE / 'pipeline.py', HERE / 'bake_formats.py', *areas):
        h.update(p.read_bytes())
    return h.hexdigest()


def bake(sources: dict, deadline: Deadline) -> dict:
    """Build the three layers into out/. Nothing happens when the last bake
    used the same sources and code and every file is still there."""
    import tempfile
    deadline.start('bake')
    out, summary_path = out_dir(), out_dir() / 'summary.json'
    inputs = _inputs_hash(sources)
    if summary_path.exists():
        prev = json.loads(summary_path.read_text())
        if prev.get('inputs') == inputs and all(Path(f['path']).exists() for lyr in prev['layers'].values()
                                                for f in lyr['files'].values()):
            log('  up to date: same sources and code as the last bake')
            return prev
    out.mkdir(parents=True, exist_ok=True)
    con = pipeline.make_con()
    con.execute(f"SET temp_directory = '{WORK / 'duckdb_tmp'}'")
    features, routes = load_osm(con, osm_dir(sources))
    osm_as_of = sources['osm']['as_of']
    osm = {'source': OSM_SOURCE, 'source_licence': OSM_LICENCE, 'as_of': osm_as_of}

    stations = [{**r, **osm} for r in build_stations(features, routes)]
    lines = build_lines(routes)
    for ln, wkt in zip(lines, line_geometries(con, lines)):
        ln.update(osm, wkt=wkt)
    missing = [ln['osm_ids'] for ln in lines if not ln['wkt']]
    if missing:
        raise RuntimeError(f'lines without geometry: {missing}')
    deadline.check('bake: bus stops')
    bus = []
    for key, feed in FEEDS.items():
        for r in gtfs_stops(WORK / 'cache' / 'gtfs' / f'{key}.zip', key, feed):
            bus.append({**r, 'source': feed['source'], 'source_licence': feed['licence'],
                        'as_of': sources[key]['as_of']})
    bus += [{**r, **osm} for r in osm_bus_stops(con, features)]

    layer_rows = {'urban_rail_stations': (stations, 'ST_Point(lon, lat)'),
                  'urban_rail_lines': (lines, 'ST_GeomFromText(wkt)'),
                  'bus_stops': (bus, 'ST_Point(lon, lat)')}
    audits = {'urban_rail_stations': audit_stations(stations, tagged_counts(features)),
              'urban_rail_lines': audit_lines(lines), 'bus_stops': audit_bus(bus)}
    summary = {'inputs': inputs, 'built': datetime.now(timezone.utc).date().isoformat(), 'sources': sources,
               'reference': {'url': WIKI_URL, 'revision': WIKI_REVISION}, 'layers': {}}
    with tempfile.TemporaryDirectory(prefix='transit_', dir=out) as tmp:
        stage = Path(tmp)
        for lid, (rows, geom) in layer_rows.items():
            deadline.check(f'bake {lid}')
            base = LAYERS[lid]['basename']
            pq = stage / f'{base}.parquet'
            n = write_parquet(con, lid, rows, geom, pq, stage)
            files = {'parquet': pq, **write_downloads(con, lid, pq, stage)}
            built = {}
            for fmt, p in files.items():
                final = out / p.name
                os.replace(p, final)
                built[fmt] = {'path': str(final), 'bytes': final.stat().st_size, 'md5': pipeline.file_md5(final)}
            summary['layers'][lid] = {'rows': n, 'audit': audits[lid], 'files': built}
            log(f'  {lid}: {n:,} rows, parquet {built["parquet"]["bytes"]:,} bytes')
    with atomic_output(summary_path) as part:
        part.write_text(json.dumps(summary, indent=1, ensure_ascii=False) + '\n')
    return summary


def upload(summary_path: Path, uploaded_path: Path) -> dict:
    """Every built file to its versioned key, holding the shared upload lock;
    a file R2 already holds (same md5) is skipped. Records the keys for register."""
    summary = json.loads(summary_path.read_text())
    s3 = pipeline.r2_client()
    uploaded = {}
    with upload_lock(owner=LOCK_OWNER):
        for lid, built in summary['layers'].items():
            uploaded[lid] = {}
            for fmt, f in built['files'].items():
                key = versioned_key(f"{R2_PREFIX}/{Path(f['path']).name}", f['md5'])
                pipeline.r2_upload(s3, Path(f['path']), key)
                uploaded[lid][fmt] = {'key': key, 'bytes': f['bytes'], 'md5': f['md5']}
    with atomic_output(uploaded_path) as part:
        part.write_text(json.dumps(uploaded, indent=1, sort_keys=True) + '\n')
    return uploaded


# ── catalog ─────────────────────────────────────────────────────────────────

OSM_ATTRIBUTION = {'name': '© OpenStreetMap contributors', 'url': 'https://www.openstreetmap.org/copyright'}
PUBLISHER = {'name': 'bharatlas', 'url': 'https://bharatlas.com'}
ODBL_NOTE = ('Published under the Open Database License (ODbL 1.0): you may copy, change and share it if you credit '
             '© OpenStreetMap contributors and the sources named here and share changed versions of the data '
             'under ODbL. ')
LAYERS = {
    'urban_rail_stations': {
        'basename': 'Urban_Rail_Stations', 'source': 'OpenStreetMap', 'unit': 'stations',
        'label': 'Metro and RRTS stations',
        'description': ('Stations in operation on India\'s metro and regional rapid transit (Namo Bharat) '
                        'systems, one point per station, with its system, city and the lines that stop there.'),
        'tags': ['metro stations', 'metro', 'monorail', 'RRTS', 'Namo Bharat', 'urban rail', 'transit',
                 'OpenStreetMap', 'transport'],
    },
    'urban_rail_lines': {
        'basename': 'Urban_Rail_Lines', 'source': 'OpenStreetMap', 'unit': 'lines',
        'label': 'Metro and RRTS lines',
        'description': ('Lines in operation on India\'s metro and regional rapid transit systems, one '
                        'feature per line with its name, number and colour where OpenStreetMap has them.'),
        'tags': ['metro lines', 'metro', 'monorail', 'RRTS', 'urban rail', 'transit', 'OpenStreetMap', 'transport'],
    },
    'bus_stops': {
        'basename': 'Bus_Stops', 'source': 'OpenStreetMap and city bus feeds', 'unit': 'bus stops',
        'label': 'Bus stops',
        'description': ('City bus stops from the open bus feeds of Bengaluru, Pune, the Mumbai region, Ahmedabad and '
                        'Chennai, and from OpenStreetMap for Delhi, Kolkata, Kochi and Hyderabad, each row with its '
                        'city, operator, source and licence.'),
        'tags': ['bus stops', 'bus', 'BMTC', 'PMPML', 'BEST', 'AMTS', 'Janmarg', 'MTC', 'GTFS', 'transit',
                 'OpenStreetMap', 'transport'],
    },
}


def notes(lid: str) -> str:
    if lid == 'urban_rail_stations':
        return ODBL_NOTE + (
            'From a dated Geofabrik extract of OpenStreetMap. A station is a stop on a route relation of an '
            'operational line, placed at its station; stations of one name on one system within 1.5 km are one '
            'row, and lines lists every line stopping there. Delhi Metro comes from its station tags (its line '
            'relations were incomplete; both ways give the same stations in this extract). OpenStreetMap maps some '
            'lines and stations before they open; a hand-kept list of operational lines and stations (Mumbai '
            'Metro lines 2B and 9, Chennai Metro Yellow Line) leaves those out, and anything tagged as under '
            'construction, proposed or disused is never included. An interchange mapped as one station per line '
            '(\'Kirti Nagar (Blue Line)\') is one row named without the line. The Mumbai Monorail is left out '
            'while its operations are suspended (OpenStreetMap marks its route disused). Checked each build '
            'against the operational station counts on Wikipedia (Urban rail transit in India); suburban rail '
            'stations are in the Railway stations layer (ir_stations).')
    if lid == 'urban_rail_lines':
        return ODBL_NOTE + (
            'From a dated Geofabrik extract of OpenStreetMap: the ways of each operational route relation, both '
            'directions merged into one feature per line, with the relation\'s name, ref, colour, from and to. '
            'OpenStreetMap draws each track, so a double-track line\'s length is about twice its route length. Partly '
            'open lines (Mumbai Metro 2B and 9, Chennai Metro Yellow Line) are mapped over their operational stretch '
            'only. A direction mapped without a ref joins its same-named line. The colour column holds '
            'OpenStreetMap\'s colour tag as mapped (a name or a hex code).')
    feeds = '; '.join(f'{f["source"]}, {f["licence"]}, {f["page"]}' for f in FEEDS.values())
    return ODBL_NOTE + (
        f'Stops only, no timetables. Bus feeds (GTFS): {feeds}. The volunteer feeds are compiled from the operators\' '
        'apps and websites; the CUMTA feed is government data with no licence stated, republished with credit '
        '(bharatlas.com/about#sources-and-licensing); takedown on request. OpenStreetMap '
        '(© OpenStreetMap contributors, ODbL 1.0) gives the stops of Delhi (NCT), Kolkata, Kochi and Hyderabad '
        '(highway=bus_stop, or a bus platform), inside the city\'s boundary layer (lgd_states, wards_kolkata, '
        'wards_kochi, wards_hyderabad). Every row names its source, source_licence and as_of (the feed\'s version '
        'or start date, or the OpenStreetMap extract date). Stop names and positions are as published.')


def catalog_entry(lid: str, built: dict, uploaded: dict, fetched_at: str) -> dict:
    meta = LAYERS[lid]
    entry = {'id': lid, 'level': lid, 'source': meta['source'], 'rows': built['rows']}
    for fmt in EXT:
        entry[fmt] = {'url': f'{pipeline.R2_PUBLIC}/{uploaded[fmt]["key"]}', 'bytes': uploaded[fmt]['bytes']}
    entry.update({'licence': OSM_LICENCE,
                  'attribution': {'primary': dict(OSM_ATTRIBUTION), 'publisher': dict(PUBLISHER)},
                  'category': 'transport', 'provenance': 'curated', 'fetched_at': fetched_at,
                  'notes': notes(lid), 'tags': list(meta['tags'])})
    return entry


def manifest_entry(lid: str, built: dict, uploaded: dict, tiles: dict | None = None) -> dict:
    """The external-ingested.json row. `tiles` is the catalog's pmtiles block
    (rebake_tiles.py adds it after register); build_catalog.py reads
    pmtiles_file from every row, so it is None until then."""
    meta = LAYERS[lid]
    tiles_file = tiles['url'].rsplit('/', 1)[1] if tiles else None
    return {'id': lid, 'name': meta['label'], 'level': lid, 'category': 'transport', 'source': meta['source'],
            'description': meta['description'], 'unit': meta['unit'], 'features': built['rows'],
            'license': OSM_LICENCE, 'r2_prefix': R2_PREFIX,
            'parquet_file': uploaded['parquet']['key'].rsplit('/', 1)[1], 'parquet_bytes': uploaded['parquet']['bytes'],
            'pmtiles_file': tiles_file, 'pmtiles_bytes': tiles['bytes'] if tiles else None,
            'source_url': OSM_ATTRIBUTION['url'], 'source_org': OSM_ATTRIBUTION['name'],
            'notes': notes(lid), 'tags': list(meta['tags'])}


def register(catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST, summary_path: Path | None = None,
             uploaded_path: Path | None = None) -> None:
    """Patch catalog.json and external-ingested.json in place (never rebuild the
    catalog). Keeps what later steps added (tiles from rebake_tiles.py, the
    source check's fingerprint, the refresh block) and records this build's
    audit in refresh.audited_at / audit_result. Idempotent."""
    from tile_keys import keep_rebaked
    summary = json.loads((summary_path or out_dir() / 'summary.json').read_text())
    uploaded = json.loads((uploaded_path or out_dir() / 'uploaded.json').read_text())
    fetched_at = summary['sources']['osm']['as_of']
    catalog = json.loads(catalog_path.read_text())
    manifest = json.loads(manifest_path.read_text())
    for lid, meta in LAYERS.items():
        built = summary['layers'][lid]
        prev = next((x for x in catalog['layers'] if x.get('id') == lid), None) or {}
        entry = catalog_entry(lid, built, uploaded[lid], fetched_at)
        keep_rebaked(entry, prev, 'pmtiles')
        for key in ('source_check', 'refresh'):
            if key in prev:
                entry[key] = dict(prev[key])
        entry['refresh'] = {**entry.get('refresh', {}), 'audited_at': summary['built'], 'audit_result': built['audit']}
        level_meta = {'label': meta['label'], 'unit': meta['unit'], 'description': meta['description']}
        pipeline.upsert_layer(catalog, entry, level_meta)
        next(x for x in catalog['layers'] if x['id'] == lid)['fetched_at'] = fetched_at
        manifest = pipeline.upsert_by_id(manifest, manifest_entry(lid, built, uploaded[lid], entry.get('pmtiles')))
    pipeline.write_json(catalog_path, catalog)
    pipeline.write_json(manifest_path, manifest)


# ── CLI ─────────────────────────────────────────────────────────────────────

def fetch_areas() -> None:
    """The city boundary layers OSM bus stops are selected by (cached)."""
    from bake_formats import fetch_layer_file
    for layer_id, _ in OSM_BUS_CITIES.values():
        area_path(layer_id).parent.mkdir(parents=True, exist_ok=True)
        fetch_layer_file(CATALOG, layer_id, 'parquet', area_path(layer_id))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['all', 'pull', 'extract', 'bake', 'upload', 'register'])
    ap.add_argument('--minutes', type=float, default=150, help='stop cleanly between steps after this long')
    ap.add_argument('--refresh', action='store_true', help='pull: fetch every source again')
    a = ap.parse_args(argv)
    deadline = Deadline(a.minutes)
    try:
        if a.step in ('all', 'pull', 'extract', 'bake'):
            # cache/ (feeds, boundaries, OSM extracts) is restored from and backed up to R2
            # every 10 minutes and on exit; raw/ (the 1.7 GB extract) is re-downloadable by its dated name.
            with pipeline.cache_backup(WORK / 'cache', CACHE_PREFIX):
                if a.step in ('all', 'pull') or not sources_path().exists():
                    pull(deadline, a.refresh)
                    fetch_areas()
                sources = json.loads(sources_path().read_text())
                if a.step in ('all', 'extract', 'bake'):
                    extract(sources, deadline)
                if a.step in ('all', 'bake'):
                    summary = bake(sources, deadline)
                    log(json.dumps({lid: lyr['rows'] for lid, lyr in summary['layers'].items()}))
        elif a.step == 'upload':
            deadline.start('upload')
            upload(out_dir() / 'summary.json', out_dir() / 'uploaded.json')
        else:
            register()
    except OutOfTime as e:
        log(f'STOPPED: {e}; finished steps are kept, re-run to continue')
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main())
