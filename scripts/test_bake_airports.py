"""airports from OurAirports: the pinned commit (cached, idempotent), India's rows
as published plus the LGD district each point is in, and the catalog entry.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_airports.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_airports as a  # noqa: E402
import pipeline  # noqa: E402

HEADER = ('"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country",'
          '"iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code",'
          '"home_link","wikipedia_link","keywords"')
ROWS = [
    # inside the square district
    '26555,"VOBL","large_airport","Kempegowda International Airport",13.2,77.7,3000,"AS","IN","IN-KA","Bengaluru",'
    '"yes","VOBL","BLR","VOBL",,"https://x","https://w",',
    # 10 km east of it: no polygon holds it, the nearest is within 25 km
    '7,"IN-0007","heliport","Island Helipad",13.5,78.09,,"AS","IN","IN-KA",,"no",,,,,,,',
    # far from any district
    '8,"IN-0008","closed","Far Strip",20.0,85.0,10,"AS","IN","IN-OR",,"no",,,,,,,',
    # not India
    '9,"OPKC","large_airport","Jinnah International",24.9,67.1,100,"AS","PK","PK-SD","Karachi","yes",,,,,,,',
]


@pytest.fixture
def csv(tmp_path):
    p = tmp_path / 'airports.csv'
    p.write_text('\n'.join([HEADER, *ROWS]) + '\n')
    return p


@pytest.fixture
def districts(tmp_path):
    p = tmp_path / 'districts.parquet'
    con = pipeline.make_con()
    con.execute(f"""COPY (SELECT 'Bengaluru Urban' AS dtname, 'KARNATAKA' AS stname, 572 AS dist_lgd, 29 AS state_lgd,
        ST_GeomFromText('POLYGON((77 13, 78 13, 78 14, 77 14, 77 13))') AS geometry) TO '{p}' (FORMAT PARQUET)""")
    return p


# ── pull: one pinned commit, downloaded once ─────────────────────────────────

COMMITS = [{'sha': 'abc123', 'commit': {'committer': {'date': '2026-11-20T02:53:12Z'}}}]


def test_the_pull_pins_the_latest_commit_of_the_file_and_a_rerun_downloads_nothing(tmp_path):
    got = []

    def download(url, dest):
        got.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(HEADER + '\n')

    first = a.pull(tmp_path, lambda url: COMMITS, download, now='2026-11-20T05:00:00+00:00')
    assert got == ['https://raw.githubusercontent.com/davidmegginson/ourairports-data/abc123/airports.csv']
    assert first == {'sha': 'abc123', 'committed_at': '2026-11-20T02:53:12Z', 'pulled_at': '2026-11-20T05:00:00+00:00',
                     'csv': str(tmp_path / 'abc123' / 'airports.csv')}
    again = a.pull(tmp_path, lambda url: COMMITS, download, now='2026-11-21T05:00:00+00:00')
    assert got == [got[0]] and again == first   # same commit: nothing fetched, nothing re-dated


def test_a_new_commit_is_pulled_and_dated(tmp_path):
    def download(url, dest):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(HEADER + '\n')

    a.pull(tmp_path, lambda url: COMMITS, download, now='2026-11-20T05:00:00+00:00')
    newer = [{'sha': 'def456', 'commit': {'committer': {'date': '2026-12-20T02:53:12Z'}}}]
    got = a.pull(tmp_path, lambda url: newer, download, now='2026-12-20T06:00:00+00:00')
    assert got['sha'] == 'def456' and got['pulled_at'] == '2026-12-20T06:00:00+00:00'


def test_no_commit_is_an_error_not_an_empty_layer(tmp_path):
    with pytest.raises(ValueError):
        a.pull(tmp_path, lambda url: [], lambda url, dest: None)


# ── bake: India's rows as published, plus the LGD district ───────────────────

def test_the_table_keeps_india_and_every_source_column_as_published(tmp_path, csv, districts):
    out = tmp_path / 'joined.parquet'
    stats = a.build_table(pipeline.make_con(), csv, districts, out)
    con = pipeline.make_con()
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM '{out}'").fetchall()]
    source = [c.strip('"') for c in HEADER.split(',')]
    assert cols == [*source, *a.ADDED, 'geometry']
    rows = con.execute(f"SELECT id, iso_country, scheduled_service, elevation_ft FROM '{out}' ORDER BY id").fetchall()
    assert rows == [(7, 'IN', 'no', None), (8, 'IN', 'no', 10), (26555, 'IN', 'yes', 3000)]
    assert stats == {'rows': 3, 'within': 1, 'nearest': 1, 'none': 1}


def test_each_point_gets_its_lgd_district_and_says_how(tmp_path, csv, districts):
    out = tmp_path / 'joined.parquet'
    a.build_table(pipeline.make_con(), csv, districts, out)
    got = pipeline.make_con().execute(
        f"SELECT id, state, district, state_lgd, dist_lgd, lgd_match, ST_X(geometry), ST_Y(geometry) FROM '{out}' ORDER BY id"
    ).fetchall()
    assert got == [(7, 'KARNATAKA', 'Bengaluru Urban', 29, 572, 'nearest', 78.09, 13.5),
                   (8, None, None, None, None, None, 85.0, 20.0),
                   (26555, 'KARNATAKA', 'Bengaluru Urban', 29, 572, 'within', 77.7, 13.2)]


# ── register: the catalog entry ──────────────────────────────────────────────

PULL = {'sha': 'abc123', 'committed_at': '2026-11-20T02:53:12Z', 'pulled_at': '2026-11-20T05:00:00+00:00'}
NAMES = {f: f'Airports.0123abcd.{e}' for f, e in a.EXT.items()}
SIZES = {f: 100 for f in a.EXT}
PREV = {'id': 'airports', 'level': 'airport', 'source': 'data.gov.in', 'rows': 151, 'licence': 'GODL-India',
        'refresh': {'class': 'fast', 'check': 'weekly', 'rebuild': 'monthly', 'release': 'monthly',
                    'audit': 'x', 'audited_at': None, 'next_due': '2026-06-25'},
        'fetched_at': '2026-05-25T17:54:40+00:00'}


def summary(**kw):
    return {'rows': 661, 'within': 644, 'nearest': 16, 'none': 1, 'sizes': SIZES, 'names': NAMES, 'pull': PULL, **kw}


def test_the_entry_names_ourairports_its_commit_and_a_public_domain_licence():
    e = a.catalog_entry(summary(), PREV, 'https://r2')
    assert e['source'] == 'OurAirports' and e['licence'] == 'Unlicense' and e['rows'] == 661
    assert e['parquet'] == {'url': 'https://r2/transport/airports/Airports.0123abcd.parquet', 'bytes': 100}
    assert e['source_check'] == {'method': 'github_commit', 'url': a.CHECK_URL, 'fingerprint': 'commit=abc123',
                                 'checked_at': PULL['pulled_at'], 'changed_at': PULL['committed_at']}
    assert e['fetched_at'] == PULL['pulled_at']           # a rebuild is a refresh: the card's date moves
    assert e['refresh']['class'] == 'fast'                # the owner's class and audit are kept
    assert e['refresh']['next_due'] == '2026-12-20'       # a month after this build
    assert '644' not in e['notes'] and 'nearest' in e['notes']   # the rule, not this run's counts


def test_registering_twice_changes_nothing(tmp_path):
    cat = tmp_path / 'catalog.json'
    man = tmp_path / 'manifest.json'
    cat.write_text(json.dumps({'layers': [PREV], 'level_meta': {}, 'level_order': ['airport'], 'attribution': {}}))
    man.write_text('[]')
    s = tmp_path / 'summary.json'
    s.write_text(json.dumps(summary()))
    a.register(cat, man, s, 'https://r2')
    once = cat.read_text(), man.read_text()
    a.register(cat, man, s, 'https://r2')
    assert (cat.read_text(), man.read_text()) == once
    c = json.loads(once[0])
    assert c['attribution']['OurAirports']['url'] == 'https://ourairports.com/data/'
    assert c['level_meta']['airport']['label'] == 'Airports, airfields and heliports'


def test_the_check_is_weak_the_repository_is_recommitted_nightly_for_the_world():
    import populate_refresh
    layer = {'id': 'airports', 'source_check': {'method': 'github_commit', 'url': a.CHECK_URL}}
    assert 'every night' in populate_refresh.weak_check(layer)


def test_the_tiles_show_every_airport_at_country_zoom():
    # 661 points: thinning them at low zoom left 4 on the map of India
    assert a.TILE_KEEP_ALL is True and a.TILE_MAXZOOM >= 12


def test_new_tiles_over_the_same_data_replace_the_old_tiles(tmp_path):
    # the bake makes every file of this layer: tiles rebuilt alone are not someone's rebake to keep
    cat, man, s = tmp_path / 'catalog.json', tmp_path / 'manifest.json', tmp_path / 'summary.json'
    cat.write_text(json.dumps({'layers': [PREV], 'level_meta': {}, 'level_order': ['airport'], 'attribution': {}}))
    man.write_text('[]')
    s.write_text(json.dumps(summary()))
    a.register(cat, man, s, 'https://r2')
    s.write_text(json.dumps(summary(names={**NAMES, 'pmtiles': 'Airports.9999aaaa.pmtiles'})))
    a.register(cat, man, s, 'https://r2')
    layer = json.loads(cat.read_text())['layers'][0]
    assert layer['pmtiles']['url'].endswith('Airports.9999aaaa.pmtiles')
