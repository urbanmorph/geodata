"""Tests for scripts/bake_transit.py: the pure helpers, GTFS reading, the
station and line rules on small OSM-shaped inputs, the audit and the catalog
patch. Pull, extract and upload need the network and the extract.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_transit.py -q
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_transit as b  # noqa: E402


def gtfs_zip(path: Path, **tables: str) -> Path:
    """A GTFS zip from {table name: csv text}."""
    with zipfile.ZipFile(path, 'w') as zf:
        for name, text in tables.items():
            zf.writestr(f'{name}.txt', text)
    return path


# ── small helpers ───────────────────────────────────────────────────────────

def test_osm_date_reads_the_geofabrik_day():
    assert b.osm_date('india-261117.osm.pbf') == '2026-11-17'
    with pytest.raises(ValueError):
        b.osm_date('india-latest.osm.pbf')


@pytest.mark.parametrize('raw,out', [('20261109', '2026-11-09'), ('v1.2', 'v1.2'), ('', None), (None, None)])
def test_iso_date_formats_gtfs_dates_and_keeps_other_versions(raw, out):
    assert b.iso_date(raw) == out


def test_haversine_one_degree_of_latitude():
    assert b.haversine_m(77, 12, 77, 13) == pytest.approx(111_195, rel=1e-3)


def test_deadline_stops_a_step_at_its_own_limit_before_the_run_limit():
    now = [0.0]
    d = b.Deadline(600, clock=lambda: now[0])
    d.start('bake')                       # 30 minutes for bake
    now[0] = 29 * 60
    d.check('bake: parquet')
    now[0] = 31 * 60
    with pytest.raises(b.OutOfTime):
        d.check('bake: downloads')


def test_deadline_stops_at_the_run_limit():
    now = [0.0]
    d = b.Deadline(1, clock=lambda: now[0])
    now[0] = 61
    with pytest.raises(b.OutOfTime):
        d.start('pull')


# ── GTFS ────────────────────────────────────────────────────────────────────

def test_feed_as_of_prefers_feed_version_then_start_date_then_calendar(tmp_path):
    info = 'feed_publisher_name,feed_version,feed_start_date\n'
    a = gtfs_zip(tmp_path / 'a.zip', feed_info=info + 'X,20261109,20260101\n')
    c = gtfs_zip(tmp_path / 'c.zip', feed_info='feed_publisher_name,feed_start_date\nX,20261114\n')
    d = gtfs_zip(tmp_path / 'd.zip',
                 calendar='service_id,start_date,end_date\ns2,20260901,20261231\ns1,20260819,20261231\n')
    v = gtfs_zip(tmp_path / 'v.zip', feed_info='feed_publisher_name,feed_version,feed_start_date\nX,1.0,20251028\n')
    assert b.feed_as_of(a, {}) == '2026-11-09'
    assert b.feed_as_of(c, {}) == '2026-11-14'
    assert b.feed_as_of(d, {}) == '2026-08-19'
    assert b.feed_as_of(v, {}) == '2025-10-28'      # a version that is not a date says less than the start date


def test_a_feed_inside_a_zip_is_read_from_its_inner_zip(tmp_path):
    inner = gtfs_zip(tmp_path / 'inner.zip', stops='stop_id,stop_name,stop_lat,stop_lon\n4,Adyar,13.0,80.25\n',
                     agency='agency_id,agency_name\nCUMTA,Chennai Unified Metropolitan Transport Authority\n',
                     feed_info='feed_version,feed_start_date\n1.0,20251028\n')
    outer = tmp_path / 'outer.zip'
    with zipfile.ZipFile(outer, 'w') as zf:
        zf.writestr('data/readme.geojson', '{}')
        zf.write(inner, 'data/chennai.bus.gtfs.zip')
    feed = {'city': 'Chennai', 'inner': 'data/chennai.bus.gtfs.zip'}
    assert b.feed_as_of(outer, feed) == '2025-10-28'
    assert [(r['stop_id'], r['operator']) for r in b.gtfs_stops(outer, 'chennai', feed)] == [
        ('4', 'Chennai Unified Metropolitan Transport Authority')]


STOPS = ('﻿stop_id,stop_name,stop_lat,stop_lon,location_type\n'
         '1, Majestic ,12.97,77.57,0\n'
         '2,Hebbal,13.03,77.59,\n'
         'S1,Majestic station,12.97,77.57,1\n'
         '3,No position,,,0\n')


def test_gtfs_stops_keep_stops_and_platforms_only_with_the_single_agency_as_operator(tmp_path):
    z = gtfs_zip(tmp_path / 'bmtc.zip', stops=STOPS,
                 agency='agency_id,agency_name\nBMTC,Bangalore Metropolitan Transport Corporation\n')
    rows = b.gtfs_stops(z, 'bmtc', {'city': 'Bengaluru'})
    assert [(r['stop_id'], r['name'], r['city'], r['operator']) for r in rows] == [
        ('1', 'Majestic', 'Bengaluru', 'Bangalore Metropolitan Transport Corporation'),
        ('2', 'Hebbal', 'Bengaluru', 'Bangalore Metropolitan Transport Corporation')]
    assert (rows[0]['lon'], rows[0]['lat']) == (77.57, 12.97)


def test_gtfs_stops_of_a_multi_agency_feed_name_every_agency_serving_them_and_the_first_ones_city(tmp_path):
    z = gtfs_zip(
        tmp_path / 'mumbai.zip',
        stops=('stop_id,stop_name,stop_lat,stop_lon\n'
               'a,Thane Stn,19.18,72.97\nb,CSMT,18.94,72.83\nc,Unserved,19.0,72.9\n'),
        agency='agency_id,agency_name\nBEST,BEST Undertaking\nTMT,Thane Municipal Transport\n',
        routes='route_id,agency_id\nr1,TMT\nr2,BEST\n',
        trips='route_id,trip_id,service_id\nr1,t1,s\nr2,t2,s\n',
        stop_times='trip_id,stop_id,stop_sequence\nt1,a,1\nt2,a,2\nt2,b,1\n')
    feed = {'city': {'BEST': 'Mumbai', 'TMT': 'Thane'}}
    rows = {r['stop_id']: r for r in b.gtfs_stops(z, 'mumbai', feed)}
    assert (rows['a']['operator'], rows['a']['city']) == ('BEST Undertaking; Thane Municipal Transport', 'Mumbai')
    assert (rows['b']['operator'], rows['b']['city']) == ('BEST Undertaking', 'Mumbai')
    assert (rows['c']['operator'], rows['c']['city']) == (None, None)


# ── OSM stations and lines ──────────────────────────────────────────────────

M = 1 / 111_195  # one metre of latitude in degrees


def node(oid, lon, lat, **tags):
    return {'type': 'node', 'id': oid, 'tags': tags, 'lon': lon, 'lat': lat}


def station(oid, name, lon, lat, network='Namma Metro', **tags):
    return node(oid, lon, lat, name=name, railway='station', public_transport='station', station='subway',
                network=network, **tags)


def route(rid, name, ref, stops, ways=(), network='Namma Metro', **tags):
    members = [('node', s, 'stop') for s in stops] + [('way', w, '') for w in ways]
    return {'id': rid, 'tags': {'type': 'route', 'route': 'subway', 'name': name, 'ref': ref, 'network': network,
                                **tags}, 'members': members}


def feats(*fs):
    return {(f['type'], f['id']): f for f in fs}


@pytest.mark.parametrize('tags,live', [
    ({'railway': 'station'}, True),
    ({'railway': 'station', 'opening_hours': '06:00-23:00'}, True),
    ({'railway': 'proposed'}, False),
    ({'railway': 'station', 'construction': 'yes'}, False),
    ({'disused:route': 'monorail', 'disused': 'yes'}, False),
    ({'construction:railway': 'station'}, False),
    ({'name': 'Line 3: SIPCOT → Madhavaram (u/c)'}, False),
    ({'name': 'Green Line (Under Construction)'}, False),
])
def test_is_live_drops_construction_proposed_and_disused(tags, live):
    assert b.is_live(tags) is live


@pytest.mark.parametrize('name,label', [
    ('Blue Line (Noida Electronic City → Dwarka Sector 21)', 'Blue Line'),
    ('Green Line: Chennai Central → St. Thomas Mount', 'Green Line'),
    ('Line 2B (Chembur → Mandale)', 'Line 2B'),
    ('Airport Express Line', 'Airport Express Line'),
])
def test_line_label_is_the_name_without_its_terminals(name, label):
    assert b.line_label({'name': name}) == label


def test_norm_name_ignores_case_punctuation_and_the_word_metro_station():
    assert b.norm_name('Rajiv Chowk Metro Station') == b.norm_name('rajiv  chowk') == 'rajiv chowk'
    assert b.norm_name('Dahisar (East) [Line 9]') == 'dahisar east line 9'


def test_system_of_maps_the_network_and_knows_nothing_else():
    assert b.system_of({'network': 'Namma Metro'})['city'] == 'Bengaluru'
    assert b.system_of({'network': 'RapidX'})['mode'] == 'rrts'
    assert b.system_of({'network': 'Surat Metro'}) is None
    assert b.system_of({}) is None


def test_stops_snap_to_their_station_and_one_row_per_station_lists_every_line():
    f = feats(station(1, 'Majestic', 77.5720, 12.9757), node(11, 77.5721, 12.9757, name='Majestic'),
              node(12, 77.5722, 12.9758, name='Majestic'), node(13, 77.60, 12.98, name='MG Road'),
              station(2, 'MG Road', 77.6001, 12.9801))
    routes = [route(100, 'Purple Line (A → B)', 'Purple', [11, 13]),
              route(101, 'Purple Line (B → A)', 'Purple', [13, 11]),
              route(200, 'Green Line (C → D)', 'Green', [12])]
    rows = {r['name']: r for r in b.build_stations(f, routes)}
    assert set(rows) == {'Majestic', 'MG Road'}
    m = rows['Majestic']
    assert (m['osm_type'], m['osm_id'], m['lon']) == ('node', 1, 77.5720)
    assert (m['lines'], m['system'], m['city']) == ('Green Line; Purple Line', 'Namma Metro', 'Bengaluru')
    assert m['mode'] == 'metro'
    assert m['line_count'] == 2


@pytest.mark.parametrize('name,base', [
    ('Kirti Nagar (Blue Line)', 'Kirti Nagar'), ('Dahisar (East) [Line 9]', 'Dahisar (East)'),
    ('Esplanade (Line 2)', 'Esplanade'), ('Shivaji Chowk (Chembur)', 'Shivaji Chowk (Chembur)'),
    ('Dwarka - Kakrola (Grey Line)', 'Dwarka - Kakrola'), (None, None)])
def test_station_name_drops_a_trailing_line_qualifier_only(name, base):
    assert b.station_name(name) == base


def test_an_interchange_mapped_once_per_line_is_one_station_with_both_lines():
    f = feats(station(1, 'Dahisar (East) [Line 2]', 72.8640, 19.2580, network='Mumbai Metro'),
              station(2, 'Dahisar (East) [Line 9]', 72.8645, 19.2584, network='Mumbai Metro'),
              node(11, 72.8640, 19.2580, name='Dahisar (East) [Line 2]'),
              node(12, 72.8645, 19.2584, name='Dahisar (East) [Line 9]'))
    rows = b.build_stations(f, [route(1, 'Line 2 (A → B)', '2', [11], network='Mumbai Metro'),
                                route(2, 'Line 9 (C → D)', '9', [12], network='Mumbai Metro')])
    assert [(r['name'], r['lines'], r['line_count'], r['osm_id']) for r in rows] == [
        ('Dahisar (East)', 'Line 2; Line 9', 2, 1)]


def test_a_stop_far_from_any_station_stands_for_itself_and_same_names_far_apart_stay_apart():
    f = feats(node(11, 77.50, 12.90, name='Depot'), node(12, 77.60, 12.90, name='Depot'))
    rows = b.build_stations(f, [route(1, 'Pink Line', 'Pink', [11, 12])])
    assert sorted((r['osm_id'], r['name']) for r in rows) == [(11, 'Depot'), (12, 'Depot')]


def test_routes_not_live_unknown_or_off_the_operational_list_give_no_stations():
    f = feats(station(1, 'A', 80.20, 13.00, network='Chennai Metro'), node(11, 80.20, 13.00, name='A'),
              station(2, 'B', 80.25, 13.05, network='Surat Metro'), node(12, 80.25, 13.05, name='B'))
    routes = [route(1, 'Line 3: X → Y (u/c)', '3', [11], network='Chennai Metro', construction='yes'),
              route(2, 'Line 5', '5', [11], network='Chennai Metro'),       # not on Chennai's operational list
              route(3, 'Green', 'G', [12], network='Surat Metro')]
    assert b.build_stations(f, routes) == []


def test_route_masters_are_not_lines_and_give_no_stations():
    master = {'id': 9, 'tags': {'type': 'route_master', 'route_master': 'monorail', 'network': 'MMRDA',
                                'name': 'Mumbai Monorail Line 1'}, 'members': [('relation', 1, '')]}
    assert b.build_lines([master]) == []
    assert b.build_stations({}, [master]) == []


def test_a_partly_open_line_keeps_only_its_operational_stations():
    f = feats(*(node(10 + i, 72.90 + i * 0.01, 19.05, name=n)
                for i, n in enumerate(['Mandale', 'Mankhurd', 'Shivaji Chowk (Chembur)', 'Chembur', 'Not Open Yet'])))
    rows = b.build_stations(f, [route(1, 'Line 2B (Chembur → Mandale)', '2B', [10, 11, 12, 13, 14],
                                      network='Mumbai Metro')])
    assert sorted(r['name'] for r in rows) == ['Chembur', 'Mandale', 'Mankhurd', 'Shivaji Chowk (Chembur)']


def test_delhi_metro_comes_from_live_station_tags_with_lines_from_the_routes_that_stop_there():
    f = feats(station(1, 'Rajiv Chowk', 77.2196, 28.6328, network='Delhi Metro'),
              station(2, 'Kashmere Gate', 77.2280, 28.6675, network='Delhi Metro'),
              station(3, 'Not Yet', 77.10, 28.50, network='Delhi Metro', construction='yes'),
              node(11, 77.2196, 28.6329, name='Rajiv Chowk'))
    rows = {r['name']: r for r in b.build_stations(f, [route(1, 'Yellow Line (A → B)', '2', [11],
                                                             network='Delhi Metro')])}
    assert set(rows) == {'Rajiv Chowk', 'Kashmere Gate'}
    assert rows['Rajiv Chowk']['lines'] == 'Yellow Line' and rows['Kashmere Gate']['lines'] is None


def test_lines_merge_both_directions_and_keep_name_ref_colour():
    routes = [route(100, 'Purple Line (A → B)', 'Purple', [11], ways=[5, 6], colour='#800080', operator='BMRCL'),
              route(101, 'Purple Line (B → A)', 'Purple', [11], ways=[6, 7], colour='#800080'),
              route(102, 'Line 5', '5', [11], ways=[8], network='Chennai Metro')]
    lines = b.build_lines(routes)
    assert len(lines) == 1
    ln = lines[0]
    assert (ln['name'], ln['ref'], ln['colour'], ln['operator'], ln['system']) == (
        'Purple Line', 'Purple', '#800080', 'BMRCL', 'Namma Metro')
    assert (ln['ways'], ln['osm_ids']) == ([5, 6, 7], 'r100;r101')


def test_a_direction_without_a_ref_joins_its_line_by_name_but_a_branch_with_its_own_ref_stays_apart():
    routes = [route(1, 'Blue Line (A → B)', 'Blue', [], ways=[5], network='Kolkata Metro'),
              route(2, 'Blue Line (B → A)', None, [], ways=[6], network='Kolkata Metro'),
              route(3, 'Blue Line (Vaishali → Yamuna Bank)', '4', [], ways=[7], network='Delhi Metro'),
              route(4, 'Blue Line (Dwarka → Noida)', '3', [], ways=[8], network='Delhi Metro')]
    assert sorted((ln['system'], ln['ref'], ln['osm_ids']) for ln in b.build_lines(routes)) == [
        ('Delhi Metro', '3', 'r4'), ('Delhi Metro', '4', 'r3'), ('Kolkata Metro', 'Blue', 'r1;r2')]


def test_line_audit_counts_lines_per_system_against_wikipedia():
    a = b.audit_lines([{'system': 'Kochi Metro', 'ref': 'I', 'name': 'Phase I'}])
    assert a['Kochi Metro'] == {'lines': 1, 'refs': ['I'], 'reference': 1, 'diff': 0}
    assert a['Delhi Metro']['reference'] == 10 and a['Delhi Metro']['diff'] == -10


def test_audit_compares_each_system_on_its_reference_basis_and_flags_differences_over_two():
    rows = [{'system': 'Namma Metro', 'line_count': 2}] + [{'system': 'Namma Metro', 'line_count': 1}] * 88 + \
        [{'system': 'Kochi Metro', 'line_count': 1}] * 20
    tagged = {'Namma Metro': 88, 'Kochi Metro': 25}
    a = b.audit_stations(rows, tagged)
    assert a['Namma Metro']['rows'] == 89 and a['Namma Metro']['station_lines'] == 90
    assert a['Namma Metro']['compared'] == 90 and a['Namma Metro']['diff'] == -1 and a['Namma Metro']['ok']
    assert a['Kochi Metro']['diff'] == -5 and not a['Kochi Metro']['ok']
    assert a['Agra Metro']['rows'] == 0 and not a['Agra Metro']['ok']
    assert a['Kochi Metro']['osm_tagged'] == 25


# ── publish + catalog ───────────────────────────────────────────────────────

def test_versioned_key_puts_the_md5_before_the_full_extension():
    key = b.versioned_key(f'{b.R2_PREFIX}/Bus_Stops.shp.zip', '0123456789abcdef')
    assert key == 'transport/transit/Bus_Stops.01234567.shp.zip'


UPLOADED = {lid: {fmt: {'key': f'transport/transit/{lid}.{n:08x}.{ext}', 'bytes': 100 + n}
                  for n, (fmt, ext) in enumerate(b.EXT.items())}
            for lid in b.LAYERS}
SUMMARY = {'built': '2026-11-18', 'sources': {'osm': {'as_of': '2026-11-17'}},
           'layers': {lid: {'rows': 10, 'audit': {'Delhi Metro': {'rows': 243}}} for lid in b.LAYERS}}


def test_every_entry_is_odbl_transport_credits_osm_and_names_each_bus_source():
    for lid in b.LAYERS:
        e = b.catalog_entry(lid, SUMMARY['layers'][lid], UPLOADED[lid], '2026-11-17')
        assert e['licence'] == 'ODbL-1.0' and e['category'] == 'transport' and e['provenance'] == 'curated'
        assert e['attribution']['primary']['name'] == '© OpenStreetMap contributors'
        assert e['parquet']['url'].endswith(UPLOADED[lid]['parquet']['key'])
        assert e['fetched_at'] == '2026-11-17' and e['rows'] == 10
        assert '—' not in e['notes'] and 'catalog' not in e['notes'].lower()
    notes = b.catalog_entry('bus_stops', SUMMARY['layers']['bus_stops'], UPLOADED['bus_stops'], '2026-11-17')['notes']
    for feed in b.FEEDS.values():
        assert feed['source'] in notes and feed['licence'] in notes


def catalog_file(tmp_path, layers=()):
    cat = {'layers': [{'id': 'ir_stations', 'category': 'transport'}, *layers], 'level_meta': {},
           'level_order': ['ir_stations'], 'attribution': {}, 'categories': {'transport': 'T', 'other': 'O'}}
    (tmp_path / 'catalog.json').write_text(json.dumps(cat, indent=2) + '\n')
    (tmp_path / 'manifest.json').write_text('[]\n')
    (tmp_path / 'uploaded.json').write_text(json.dumps(UPLOADED))
    (tmp_path / 'summary.json').write_text(json.dumps(SUMMARY))
    return tmp_path / 'catalog.json', tmp_path / 'manifest.json'


def register(tmp_path, cat, man):
    b.register(cat, man, tmp_path / 'summary.json', tmp_path / 'uploaded.json')


def test_register_adds_three_layers_with_their_refresh_audit_and_is_idempotent(tmp_path):
    cat, man = catalog_file(tmp_path)
    register(tmp_path, cat, man)
    first = cat.read_text(), man.read_text()
    c = json.loads(first[0])
    assert [lyr['id'] for lyr in c['layers']] == ['ir_stations', *b.LAYERS]
    for lid in b.LAYERS:
        lyr = next(x for x in c['layers'] if x['id'] == lid)
        assert lyr['refresh']['audited_at'] == '2026-11-18'
        assert lyr['refresh']['audit_result'] == {'Delhi Metro': {'rows': 243}}
        assert lid in c['level_order'] and c['level_meta'][lid]['label']
        assert 'pmtiles' not in lyr          # tiles come from rebake_tiles.py after register
    rows = json.loads(first[1])
    assert {r['id'] for r in rows} == set(b.LAYERS)
    # build_catalog.py reads pmtiles_file from every row when imported (no tiles yet: None)
    assert all('pmtiles_file' in r and r['pmtiles_file'] is None for r in rows)
    register(tmp_path, cat, man)
    assert (cat.read_text(), man.read_text()) == first


def test_register_keeps_the_tiles_rebake_tiles_published_and_the_refresh_block(tmp_path):
    tiles = {'url': 'https://x.r2.dev/transport/transit/Bus_Stops.0a1b2c3d.pmtiles', 'bytes': 5}
    prev = {'id': 'bus_stops', 'pmtiles': tiles, 'fetched_at': '2026-10-01',
            'source_check': {'method': 'github_commit', 'fingerprint': 'commit=abc'},
            'refresh': {'class': 'fast', 'audited_at': '2026-10-01', 'next_due': '2026-11-01'}}
    cat, man = catalog_file(tmp_path, [prev])
    register(tmp_path, cat, man)
    lyr = next(x for x in json.loads(cat.read_text())['layers'] if x['id'] == 'bus_stops')
    assert lyr['pmtiles'] == tiles and lyr['source_check']['fingerprint'] == 'commit=abc'
    row = next(r for r in json.loads(man.read_text()) if r['id'] == 'bus_stops')
    assert (row['pmtiles_file'], row['pmtiles_bytes']) == ('Bus_Stops.0a1b2c3d.pmtiles', 5)
    assert lyr['fetched_at'] == '2026-11-17'                 # a rebuild moves the card's Updated date
    assert lyr['refresh']['class'] == 'fast' and lyr['refresh']['audited_at'] == '2026-11-18'
