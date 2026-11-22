#!/usr/bin/env python3
"""
Bake airports: India's airports, airfields and heliports from OurAirports.

Source: OurAirports (https://ourairports.com/data/), released to the public
domain (the data repository davidmegginson/ourairports-data carries the
Unlicense). It is kept current by its contributors and re-published every
night. It replaced the data.gov.in "Shapefile of Airports of entire Country"
(last changed September 2022) on 20 Nov 2026.

The layer: every row with iso_country IN, every column as published (numbers
cast to numbers), a point geometry from longitude_deg/latitude_deg, plus four
columns bharatlas adds from LGD districts so a layer can be queried by state and
district: state, district, state_lgd, dist_lgd, and lgd_match saying how they
were found ('within' the district polygon, else the 'nearest' district within
25 km, for islands the LGD outline leaves out; null when neither).

Pull: the latest commit that touched airports.csv is pinned, and that exact
file is fetched from raw.githubusercontent.com, so every build names the
version it used. A second run on the same commit fetches nothing.

Usage:
    python3 -u scripts/bake_airports.py pull
    python3 -u scripts/bake_airports.py bake
    python3 -u scripts/bake_airports.py upload      # md5-skip uploads to R2
    python3 -u scripts/bake_airports.py register    # patch catalog + manifest
"""
from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402
from pipeline import log, make_con  # noqa: E402

REPO = 'davidmegginson/ourairports-data'
FILE = 'airports.csv'
COMMITS_URL = f'https://api.github.com/repos/{REPO}/commits?path={FILE}&per_page=1'
CHECK_URL = f'https://github.com/{REPO}/tree/main/{FILE}'
LAYER_ID = 'airports'
LEVEL = 'airport'
BASENAME = 'Airports'
R2_PREFIX = 'transport/airports'
RAW = ROOT / 'data' / 'raw' / 'ourairports'
CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
OUT_DIR = ROOT / 'data' / 'baked' / R2_PREFIX
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
SOURCE = 'OurAirports'
LICENCE = 'Unlicense'
ATTRIBUTION = {'name': 'OurAirports', 'url': 'https://ourairports.com/data/'}
NEAREST_KM = 25
ADDED = ('state', 'district', 'state_lgd', 'dist_lgd', 'lgd_match')
# Numbers as numbers; everything else exactly as published.
TYPES = {'id': 'BIGINT', 'latitude_deg': 'DOUBLE', 'longitude_deg': 'DOUBLE', 'elevation_ft': 'INTEGER'}
TILE_FIELDS = ('name', 'type', 'iata_code', 'icao_code', 'municipality', 'scheduled_service', 'state', 'district')
TILE_MAXZOOM = 12  # -zg guessed z2 (~2 km steps: a point beside its runway); z12 is ~2 m
TILE_KEEP_ALL = True  # 661 points: thinned at low zoom, the map of India showed 4
TAGS = ['airports', 'airfields', 'heliports', 'aviation', 'IATA', 'ICAO', 'transport', 'OurAirports']


# ── pull ─────────────────────────────────────────────────────────────────────

def raw_url(sha: str) -> str:
    return f'https://raw.githubusercontent.com/{REPO}/{sha}/{FILE}'


def pull(raw: Path, get_json: Callable[[str], list], download: Callable[[str, Path], None],
         now: str | None = None) -> dict:
    """Pin the newest commit of the file and fetch that version once. The record
    (raw/pull.json) keeps its pulled_at while the commit is the same."""
    commits = get_json(COMMITS_URL)
    if not commits:
        raise ValueError(f'no commit touches {FILE} in {REPO}')
    sha, date = commits[0]['sha'], commits[0]['commit']['committer']['date']
    record = raw / 'pull.json'
    prev = json.loads(record.read_text()) if record.exists() else {}
    csv = raw / sha / FILE
    if not csv.exists():
        download(raw_url(sha), csv)
    if prev.get('sha') == sha and csv.exists():
        return prev
    got = {'sha': sha, 'committed_at': date, 'pulled_at': now or pipeline.now_iso(), 'csv': str(csv)}
    raw.mkdir(parents=True, exist_ok=True)
    pipeline.write_json(record, got)
    return got


def github_json(url: str) -> list:
    import urllib.request
    req = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json'})
    return pipeline.with_retries(lambda: json.loads(urllib.request.urlopen(req, timeout=60).read()))


# ── bake ─────────────────────────────────────────────────────────────────────

def build_table(con, csv: Path, districts: Path, out: Path) -> dict:
    """India's rows, every column as published, the LGD district each point is in
    (or the nearest within NEAREST_KM), and a point geometry. Returns the counts."""
    con.execute('INSTALL spatial; LOAD spatial;')
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_csv('{csv}', all_varchar = true)").fetchall()]
    sel = ', '.join(f'TRY_CAST("{c}" AS {TYPES[c]}) AS "{c}"' if c in TYPES else f'"{c}"' for c in cols)
    con.execute(f"""CREATE OR REPLACE TEMP TABLE ap AS
        SELECT {sel}, ST_Point(TRY_CAST(longitude_deg AS DOUBLE), TRY_CAST(latitude_deg AS DOUBLE)) AS pt
        FROM read_csv('{csv}', all_varchar = true) WHERE iso_country = 'IN'""")
    con.execute(f"""CREATE OR REPLACE TEMP TABLE d AS
        SELECT stname, dtname, state_lgd, dist_lgd, geometry FROM read_parquet('{districts}')""")
    # Containment first; only points no polygon holds look for the nearest district.
    con.execute("""CREATE OR REPLACE TEMP TABLE hit AS
        SELECT ap.id, d.stname, d.dtname, d.state_lgd, d.dist_lgd, 'within' AS how
        FROM ap JOIN d ON ST_Contains(d.geometry, ap.pt)
        QUALIFY row_number() OVER (PARTITION BY ap.id ORDER BY d.dist_lgd) = 1""")
    con.execute(f"""INSERT INTO hit
        SELECT ap.id, d.stname, d.dtname, d.state_lgd, d.dist_lgd, 'nearest'
        FROM ap JOIN d ON ST_DWithin(d.geometry, ap.pt, {NEAREST_KM / 100})
        WHERE ap.id NOT IN (SELECT id FROM hit)
          AND ST_Distance_Sphere(ST_ClosestPoint(d.geometry, ap.pt), ap.pt) <= {NEAREST_KM * 1000}
        QUALIFY row_number() OVER (PARTITION BY ap.id
                                   ORDER BY ST_Distance_Sphere(ST_ClosestPoint(d.geometry, ap.pt), ap.pt)) = 1""")
    src = ', '.join(f'ap."{c}"' for c in cols)
    con.execute(f"""COPY (SELECT {src}, hit.stname AS state, hit.dtname AS district, hit.state_lgd, hit.dist_lgd,
                                 hit.how AS lgd_match, ap.pt AS geometry
                          FROM ap LEFT JOIN hit USING (id) ORDER BY ap.id) TO '{out}' (FORMAT PARQUET)""")
    n, within, nearest = con.execute(f"""SELECT count(*), count(*) FILTER (WHERE lgd_match = 'within'),
        count(*) FILTER (WHERE lgd_match = 'nearest') FROM '{out}'""").fetchone()
    return {'rows': n, 'within': within, 'nearest': nearest, 'none': n - within - nearest}


def bake(out_dir: Path = OUT_DIR) -> dict:
    import tempfile

    import bake_formats

    got = json.loads((RAW / 'pull.json').read_text())
    out_dir.mkdir(parents=True, exist_ok=True)
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    with tempfile.TemporaryDirectory(prefix='airports_') as tmp:
        tmp = Path(tmp)
        districts = bake_formats.fetch_layer_file(CATALOG, 'lgd_districts', 'parquet', tmp / 'lgd_districts.parquet')
        joined = tmp / 'joined.parquet'
        stats = build_table(make_con(), Path(got['csv']), districts, joined)
        _, prop_cols = pipeline.rebake_flatten_bbox(joined, path['parquet'])
    con = make_con()
    files = bake_formats.write_all_formats(con, path, LAYER_ID, prop_cols, TILE_FIELDS, max_zoom=TILE_MAXZOOM,
                                           keep_all=TILE_KEEP_ALL)
    summary = {**stats, 'pull': {k: got[k] for k in ('sha', 'committed_at', 'pulled_at')}, **files}
    pipeline.write_json(SUMMARY, summary)
    log(json.dumps(summary, indent=2))
    return summary


def upload(out_dir: Path = OUT_DIR) -> dict[str, str]:
    """Every format to its content-versioned key: unchanged files keep theirs (md5-skipped)."""
    return pipeline.upload_layer(out_dir, BASENAME, EXT, R2_PREFIX)


# ── register ─────────────────────────────────────────────────────────────────

def description() -> str:
    return ('Airports, airfields and heliports across India from OurAirports: IATA and ICAO codes, type, '
            'scheduled service, and the LGD state and district.')


def notes() -> str:
    return ('OurAirports (ourairports.com), public domain, kept current by its contributors; every row for India '
            'as published, including small airfields, heliports and closed airports (the type column says which, '
            'and the source marks some duplicates in the name). bharatlas adds state, district, state_lgd and '
            'dist_lgd from LGD districts: the district containing the point, else the nearest within '
            f'{NEAREST_KM} km for islands the LGD outline leaves out (lgd_match says which; null when neither). '
            'Replaced the data.gov.in airports shapefile (151 airports, last changed September 2022) on 20 Nov 2026.')


def level_meta() -> dict:
    return {'label': 'Airports, airfields and heliports', 'unit': 'airports', 'description': description()}


def catalog_entry(summ: dict, prev: dict, r2_public: str) -> dict:
    from populate_refresh import next_due
    names, sizes, got = summ['names'], summ['sizes'], summ['pull']
    entry = {'id': LAYER_ID, 'level': LEVEL, 'source': SOURCE, 'rows': summ['rows'],
             **pipeline.format_blocks(EXT, names, sizes, f'{r2_public}/{R2_PREFIX}')}
    refresh = dict(prev.get('refresh') or {})
    if refresh.get('rebuild'):
        refresh['next_due'] = next_due(refresh['rebuild'], got['pulled_at'])
    entry.update({'licence': LICENCE, 'attribution': {'primary': dict(ATTRIBUTION), 'publisher': None},
                  'category': 'transport', 'provenance': 'curated', 'notes': notes(), 'tags': TAGS,
                  'fetched_at': got['pulled_at'],
                  'source_check': {'method': 'github_commit', 'url': CHECK_URL, 'fingerprint': f'commit={got["sha"]}',
                                   'checked_at': got['pulled_at'], 'changed_at': got['committed_at']},
                  'refresh': refresh})
    return entry


def manifest_entry(summ: dict) -> dict:
    names, sizes = summ['names'], summ['sizes']
    return {'id': LAYER_ID, 'name': level_meta()['label'], 'level': LEVEL, 'category': 'transport',
            'source': SOURCE, 'description': description(), 'unit': 'airports', 'features': summ['rows'],
            'license': LICENCE, 'r2_prefix': R2_PREFIX,
            **pipeline.manifest_files(names, sizes),
            'source_url': ATTRIBUTION['url'], 'source_org': ATTRIBUTION['name'],
            'source_commit': summ['pull']['sha'], 'notes': notes(), 'tags': TAGS}


def register(catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST,
             summary_path: Path = SUMMARY, r2_public: str | None = None) -> None:
    """Patch catalog.json + the manifest in place (never rebuild). Idempotent. The
    entry's fetched_at is this build's pull: a rebuild is a refresh."""
    summ = json.loads(summary_path.read_text())
    pipeline.summary_names(summ)
    pipeline.register_layer(catalog_path, manifest_path,
                            lambda prev: catalog_entry(summ, prev, r2_public or pipeline.R2_PUBLIC),
                            manifest_entry(summ), level_meta(), as_built=True, level=LEVEL,
                            attribution=(SOURCE, ATTRIBUTION))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['pull', 'bake', 'upload', 'register'])
    a = ap.parse_args()
    if a.step == 'pull':
        log(json.dumps(pull(RAW, github_json, pipeline.download), indent=2))
    elif a.step == 'bake':
        bake()
    elif a.step == 'upload':
        upload()
    else:
        register()


if __name__ == '__main__':
    main()
