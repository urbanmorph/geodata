"""1st Census of Water Bodies point layer: data.gov.in pull (cached per page,
resumable, idempotent, own time limit), number casting, point checks, KML
names, shapefile split, catalog entries.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_wbc1_water_bodies.py -q
"""
from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_wbc1_water_bodies as w  # noqa: E402

FIELDS = [{'id': 'state_name', 'name': 'State Name', 'type': 'keyword'},
          {'id': 'unique_id', 'name': 'unique_id', 'type': 'keyword'},
          {'id': 'latitude_dec', 'name': 'latitude_dec', 'type': 'double'},
          {'id': 'longitude_dec', 'name': 'longitude_dec', 'type': 'double'},
          {'id': '_cca_water_body', 'name': 'cca_water_body', 'type': 'keyword'}]


def fake_api(total=7, fail_at=None, calls=None):
    def fetch(offset, limit):
        if calls is not None:
            calls.append(offset)
        if offset == fail_at:
            raise OSError('dropped')
        recs = [{'state_name': 'X', 'unique_id': f'1/01/{i}'} for i in range(offset, min(offset + limit, total))]
        return {'total': total, 'field': FIELDS, 'records': recs}
    return fetch


# ── listing ──────────────────────────────────────────────────────────────────

def test_resources_from_the_listing_sorted_by_state():
    listing = {'data': {'rows': [
        {'uuid': ['b'], 'title': [' State-wise Data of First Census of Water Bodies - Tripura'],
         'datafile': ['https://x/WBC_TR.csv']},
        {'uuid': ['a'], 'title': ['State-wise Data of First Census of Water Bodies - Assam'],
         'datafile': ['https://x/WBC_AS.csv']},
    ]}}
    assert w.resources(listing) == [{'uuid': 'a', 'state': 'Assam', 'datafile': 'https://x/WBC_AS.csv'},
                                    {'uuid': 'b', 'state': 'Tripura', 'datafile': 'https://x/WBC_TR.csv'}]


def test_resource_without_a_datafile_is_still_listed():
    # Tripura's listing row has no datafile (and no API rows).
    listing = {'data': {'rows': [{'uuid': ['c'], 'title': ['First Census of Water Bodies - Tripura']}]}}
    assert w.resources(listing) == [{'uuid': 'c', 'state': 'Tripura', 'datafile': None}]


# ── pull: cached per page, resumable, idempotent, own time limit ─────────────

def test_pull_saves_each_page_and_a_rerun_asks_nothing(tmp_path):
    calls = []
    assert w.pull_resource(tmp_path, fake_api(calls=calls), limit=3) == 7
    assert calls == [0, 3, 6]  # the first page also carries the total and fields
    assert sorted(p.name for p in tmp_path.glob('offset_*')) == [
        'offset_0000000.json.gz', 'offset_0000003.json.gz', 'offset_0000006.json.gz']
    calls.clear()
    assert w.pull_resource(tmp_path, fake_api(calls=calls), limit=3) == 7
    assert calls == []  # meta and every page came from the cache: no request at all


def test_pull_resumes_after_a_failure(tmp_path):
    with pytest.raises(OSError):
        w.pull_resource(tmp_path, fake_api(fail_at=3), limit=3)
    calls = []
    assert w.pull_resource(tmp_path, fake_api(calls=calls), limit=3) == 7
    assert calls == [3, 6]


def test_pull_stops_cleanly_at_its_time_limit_keeping_pages(tmp_path):
    clock = iter([0, 0, 100, 100])
    with pytest.raises(w.TimeUp):
        w.pull_resource(tmp_path, fake_api(), limit=3, deadline=50, now=lambda: next(clock))
    assert (tmp_path / 'offset_0000000.json.gz').exists()
    assert w.pull_resource(tmp_path, fake_api(), limit=3) == 7


def test_pull_refresh_refetches(tmp_path):
    w.pull_resource(tmp_path, fake_api(), limit=3)
    calls = []
    w.pull_resource(tmp_path, fake_api(calls=calls), limit=3, refresh=True)
    assert calls == [0, 3, 6]


def test_empty_resource_is_recorded_not_refetched(tmp_path):
    def none(offset, limit):
        return {'status': 'error', 'message': 'Meta not found', 'total': 0}
    assert w.pull_resource(tmp_path, none, limit=3) == 0
    assert json.loads((tmp_path / 'meta.json').read_text())['total'] == 0


def test_page_records_read_back(tmp_path):
    w.pull_resource(tmp_path, fake_api(), limit=3)
    recs = list(w.cached_records(tmp_path))
    assert [r['unique_id'] for r in recs] == [f'1/01/{i}' for i in range(7)]
    raw = json.loads(gzip.decompress((tmp_path / 'offset_0000000.json.gz').read_bytes()))
    assert len(raw) == 3


# ── columns: published names and order, numbers cast, codes kept ─────────────

def test_columns_are_the_published_names_in_order_union_across_states():
    metas = [{'fields': FIELDS}, {'fields': FIELDS[:2] + [{'id': 'extra', 'name': 'extra', 'type': 'keyword'}]}]
    assert w.columns(metas) == ['State Name', 'unique_id', 'latitude_dec', 'longitude_dec',
                                'cca_water_body', 'extra']


def test_rows_use_published_names_whatever_the_api_id():
    # The API prefixes "_" to an id when a State's file types it differently;
    # the published name is the same, so both land in one column.
    ka = [{'id': '_latitude_dec', 'name': 'latitude_dec', 'type': 'keyword'}]
    an = [{'id': 'latitude_dec', 'name': 'latitude_dec', 'type': 'double'}]
    assert w.columns([{'fields': an}, {'fields': ka}]) == ['latitude_dec']
    assert w.named(ka, {'_latitude_dec': '12.9'}) == {'latitude_dec': '12.9'}
    assert w.named(an, {'latitude_dec': 12.9}) == {'latitude_dec': 12.9}


def test_numeric_columns_need_every_value_numeric_ignoring_na_and_blank():
    t = w.NumericTracker(['a', 'b', 'c', 'unique_id', 'khasra_number'])
    for r in [{'a': 1.5, 'b': 'NA', 'c': '3', 'unique_id': '12', 'khasra_number': '45'},
              {'a': '2', 'b': '', 'c': 'x', 'unique_id': '13', 'khasra_number': '46'},
              {'a': 'NULL', 'b': None}]:
        t.add(r)
    # b has no numeric value at all, c has text, codes always stay text
    assert t.numeric() == ['a']


def test_whole_number_columns_become_integers_others_doubles():
    t = w.NumericTracker(['year', 'area'])
    for r in [{'year': '2010', 'area': '1.5'}, {'year': 1998.0, 'area': 'NA'}]:
        t.add(r)
    assert t.types() == {'year': 'BIGINT', 'area': 'DOUBLE'}


def test_cast_sql_turns_na_into_null():
    import duckdb
    sql = w.cast_sql('v', 'BIGINT')
    got = [duckdb.sql(f"SELECT {sql} FROM (SELECT ?::VARCHAR AS v)", params=[x]).fetchone()[0]
           for x in ('NA', '2010.0', ' ', 'NULL')]
    assert got == [None, 2010, None, None]


@pytest.mark.parametrize('col', ['owner_name', 'Mobile No', 'phone_number', 'email', 'aadhaar'])
def test_personal_columns_are_refused(col):
    with pytest.raises(ValueError, match=col):
        w.check_columns(['State Name', 'water_body_ownership_name', col])


def test_ownership_category_is_not_personal():
    w.check_columns(['water_body_ownership_name', 'khasra_number', 'water_body_name'])


# ── points: as published, classified for the notes ───────────────────────────

def test_point_classes():
    import duckdb
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    rows = [(None, None), (0.0, 0.0), (77.2, 28.6), (28.6, 77.2), (-77.2, 28.6), (82.7, 12050.0), (296.4, 25.0)]
    got = [con.execute(f'SELECT {w.point_class_sql("lon", "lat")} FROM (SELECT ?::DOUBLE lon, ?::DOUBLE lat)',
                       list(r)).fetchone()[0] for r in rows]
    assert got == ['null', 'zero', 'india', 'outside', 'outside', 'invalid', 'invalid']


# ── KML placemark names ──────────────────────────────────────────────────────

def test_placemark_name_prefers_the_water_body_name():
    assert w.placemark_name({'water_body_name': 'Bada Talab', 'unique_id': '1/2'}) == 'Bada Talab'


@pytest.mark.parametrize('blank', ['NA', '', None, ' na '])
def test_placemark_name_falls_back_to_the_census_id(blank):
    assert w.placemark_name({'water_body_name': blank, 'unique_id': '1/33/002'}) == 'Water body 1/33/002'


def test_placemark_is_lon_first_and_escaped():
    pm = w.placemark({'water_body_name': 'A & B', 'unique_id': '1', 'n': 2.0, 'x': None}, 77.5, 12.9)
    assert '<name>A &amp; B</name>' in pm
    assert '<coordinates>77.5,12.9</coordinates>' in pm
    assert '<Data name="n"><value>2.0</value></Data>' in pm and 'name="x"' not in pm


def test_placemark_without_coordinates_has_no_point():
    assert '<Point>' not in w.placemark({'water_body_name': 'A', 'unique_id': '1'}, None, None)


# ── shapefile: one file unless a .dbf would pass 2 GB ────────────────────────

def test_split_needed_only_when_a_dbf_reaches_the_limit():
    assert not w.needs_split([10, 20], limit=100)
    assert w.needs_split([10, 100], limit=100)


# ── catalog ──────────────────────────────────────────────────────────────────

SUMMARY = {'rows': 1000, 'points': {'india': 990, 'outside': 5, 'zero': 2, 'null': 3, 'invalid': 4}, 'text_coords': 7,
           'states': 32, 'missing': ['Tripura'], 'fetched_at': '2026-11-15T15:19:45+00:00',
           'partial': {'West Bengal': [54876, 747480]},
           'sizes': {'parquet': 1, 'pmtiles': 2, 'geojson': 3, 'kml': 4, 'shapefile': 5},
           'names': {f: f'X.{f}' for f in w.EXT}}


def test_catalog_entry_shape():
    e = w.catalog_entry(SUMMARY, '2026-11-15T00:00:00+00:00', 'https://r2')
    assert e['id'] == 'wbc1_water_bodies' and e['category'] == 'water' and e['licence'] == 'GODL-India'
    assert e['rows'] == 1000 and e['fetched_at'].startswith('2026-11-15')
    assert e['kml']['url'] == 'https://r2/water/wbc1-water-bodies/WBC1_Water_Bodies_2017_18.kml'
    assert e['shapefile']['bytes'] == 5


def test_notes_state_the_gaps_and_point_counts_without_em_dashes():
    n = w.notes(SUMMARY)
    for s in ('Tripura', 'West Bengal', '54,876', '747,480', '5 ', '(0,0)', '3 ', '7 ', '17/41/29', '4 ', 'impossible'):
        assert s in n
    assert '—' not in n and '—' not in w.description()


def test_notes_lead_with_the_coverage_gaps_in_plain_words():
    n = w.notes(SUMMARY)
    lead = n.split('. ')[0]
    assert '1,000 of the 2,424,540 water bodies' in lead and 'data.gov.in API' in lead
    assert 'Partial States: West Bengal 54,876 of 747,480.' in n
    assert 'Tripura is missing (the census counted 36,239 there).' in n
    assert 'complete for the other 31 States/UTs' in n
    assert '7 records without usable coordinates are kept with no geometry' in n  # 3 null + 4 invalid


def test_register_patches_in_place_and_is_idempotent(tmp_path):
    cat = tmp_path / 'catalog.json'
    man = tmp_path / 'm.json'
    summ = tmp_path / 's.json'
    cat.write_text(json.dumps({'layers': [{'id': 'x'}], 'level_meta': {}, 'level_order': ['x'], 'attribution': {}}))
    man.write_text('[]')
    summ.write_text(json.dumps(SUMMARY))
    for _ in range(2):
        w.register(cat, man, summ, r2_public='https://r2')
    c = json.loads(cat.read_text())
    assert [l['id'] for l in c['layers']] == ['x', 'wbc1_water_bodies']
    assert c['level_order'] == ['x', 'wbc1_water_bodies'] and w.SOURCE in c['attribution']
    assert [e['id'] for e in json.loads(man.read_text())] == ['wbc1_water_bodies']


@pytest.mark.parametrize('lon,lat,has_point', [('77.5', '12.9', True), ('NA', '12.9', False),
                                               ('83/23/28', '17/41/29', False), (None, None, False)])
def test_points_only_from_numeric_coordinates(lon, lat, has_point):
    import duckdb
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    sql = (f'SELECT ST_Point({w.coord_sql("longitude_dec")}, {w.coord_sql("latitude_dec")}) IS NOT NULL '
           'FROM (SELECT ?::VARCHAR AS longitude_dec, ?::VARCHAR AS latitude_dec)')
    assert con.execute(sql, [lon, lat]).fetchone()[0] is has_point


def test_upload_is_resumable_with_a_patient_client(monkeypatch, tmp_path):
    import pipeline as ir
    seen = {}
    monkeypatch.setattr(ir, 'r2_client', lambda **kw: seen.setdefault('kw', kw) and 'S3')
    monkeypatch.setattr(ir, 'r2_upload_resumable',
                        lambda s3, local, key, state_dir: seen.setdefault('keys', []).append(key))
    for f in w.local_paths(tmp_path).values():
        f.write_bytes(b'x')
    w.upload(tmp_path)
    assert seen['kw']['read_timeout'] >= 300
    assert seen['keys'][2] == 'water/wbc1-water-bodies/WBC1_Water_Bodies_2017_18.9dd4e461.geojson'  # md5 of b'x'
