"""OSM underground layers: tunnels, underground pipelines and cables, mine shafts and caves, from a dated
Geofabrik India extract. Which features each layer takes, every OSM tag kept (common keys as columns, the
rest in other_tags), no mapper data, the geometry, and the catalog entries.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_osm_underground.py -q
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_osm_underground as u  # noqa: E402
import pipeline  # noqa: E402


# ── pull: the dated extract india-latest points at ───────────────────────────

def test_the_extract_url_follows_redirects_to_the_dated_file():
    hops = {'https://g/asia/india-latest.osm.pbf': 'https://g/asia/india/india-latest.osm.pbf',
            'https://g/asia/india/india-latest.osm.pbf': 'https://g/asia/india/india-261119.osm.pbf'}
    assert u.dated_extract_url('https://g/asia/india-latest.osm.pbf', hops.get) == \
        'https://g/asia/india/india-261119.osm.pbf'


def test_an_extract_url_that_never_reaches_a_dated_file_is_refused():
    with pytest.raises(ValueError, match='dated'):
        u.dated_extract_url('https://g/india-latest.osm.pbf', lambda url: None)


def test_the_pull_downloads_once_checks_the_md5_and_records_the_extract(tmp_path):
    body = b'pbf bytes'
    got = []

    def download(url, dest):
        got.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(body)
    md5 = hashlib.md5(body).hexdigest()
    url = 'https://g/asia/india/india-261119.osm.pbf'
    first = u.pull(tmp_path, lambda: url, download, lambda md5_url: f'{md5}  india-261119.osm.pbf',
                   now='2026-11-21T00:00:00+00:00')
    assert got == [url]
    assert first == {'url': url, 'file': str(tmp_path / 'raw' / 'india-261119.osm.pbf'), 'md5': md5,
                     'bytes': len(body), 'as_of': '2026-11-19', 'fetched_at': '2026-11-21T00:00:00+00:00'}
    again = u.pull(tmp_path, lambda: url, download, lambda md5_url: f'{md5}  x', now='2026-11-22T00:00:00+00:00')
    assert got == [url] and again == first


def test_a_download_with_the_wrong_md5_is_deleted_and_refused(tmp_path):
    def download(url, dest):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b'cut short')
    with pytest.raises(RuntimeError, match='md5'):
        u.pull(tmp_path, lambda: 'https://g/india-261119.osm.pbf', download, lambda _: '0' * 32)
    assert not (tmp_path / 'raw' / 'india-261119.osm.pbf').exists()


# ── which layer a feature belongs to ─────────────────────────────────────────

@pytest.mark.parametrize('kind, tags, want', [
    ('way', {'highway': 'primary', 'tunnel': 'yes'}, 'osm_tunnels'),
    ('way', {'railway': 'subway', 'tunnel': 'yes'}, 'osm_tunnels'),
    ('way', {'waterway': 'canal', 'tunnel': 'flooded'}, 'osm_tunnels'),
    ('way', {'waterway': 'stream', 'tunnel': 'culvert'}, None),          # a drain under a road, not a tunnel
    ('way', {'highway': 'service', 'tunnel': 'building_passage'}, None),  # through a building, above ground
    ('way', {'waterway': 'drain', 'tunnel': 'covered'}, None),
    ('way', {'highway': 'primary', 'tunnel': 'no'}, None),
    ('node', {'tunnel': 'yes'}, None),
    ('way', {'man_made': 'pipeline', 'location': 'underground', 'substance': 'water'}, 'osm_underground_utilities'),
    ('way', {'man_made': 'pipeline', 'location': 'underwater'}, 'osm_underground_utilities'),
    ('way', {'man_made': 'pipeline'}, None),                              # where it runs is not mapped
    ('way', {'man_made': 'pipeline', 'location': 'overground'}, None),
    ('way', {'power': 'cable'}, 'osm_underground_utilities'),             # a power cable is buried or submarine
    ('way', {'power': 'cable', 'location': 'underground'}, 'osm_underground_utilities'),
    ('way', {'power': 'cable', 'location': 'overground'}, None),
    ('way', {'power': 'line', 'location': 'underground'}, 'osm_underground_utilities'),
    ('way', {'power': 'minor_line', 'location': 'underground'}, 'osm_underground_utilities'),
    ('way', {'power': 'line'}, None),
    ('node', {'man_made': 'mineshaft', 'resource': 'coal'}, 'osm_mines_caves'),
    ('way', {'man_made': 'mineshaft'}, 'osm_mines_caves'),
    ('node', {'man_made': 'adit'}, 'osm_mines_caves'),
    ('node', {'natural': 'cave_entrance', 'name': 'Borra Caves'}, 'osm_mines_caves'),
    ('node', {'natural': 'sinkhole'}, 'osm_mines_caves'),
    ('node', {'historic': 'mine'}, 'osm_mines_caves'),
    ('node', {'man_made': 'water_well'}, None),
    ('way', {'highway': 'primary', 'tunnel': 'yes', 'man_made': 'pipeline', 'location': 'underground'}, 'osm_tunnels'),
])
def test_each_feature_goes_to_one_layer_by_its_tags(kind, tags, want):
    assert u.layer_of(kind, tags) == want


# ── tags: every one kept, common keys as columns ─────────────────────────────

def test_keys_carried_by_enough_rows_become_columns_most_used_first():
    tags = [{'highway': 'primary', 'tunnel': 'yes', 'name': 'A'}, {'highway': 'service', 'tunnel': 'yes'},
            {'railway': 'rail', 'tunnel': 'yes', 'rare:key': 'x'}, {'tunnel': 'yes', 'osm_id': 'clash'}]
    assert u.tag_columns(tags, min_share=0.5) == ['tunnel', 'highway']
    assert u.tag_columns(tags, min_share=0.25) == ['tunnel', 'highway', 'name', 'railway', 'rare:key']


def test_a_row_keeps_every_tag_and_puts_the_rest_in_other_tags():
    row = u.row_of({'type': 'way', 'id': 7, 'tags': {'tunnel': 'yes', 'name': 'T', 'zz': '1', 'osm_id': 'q'}},
                   ['tunnel', 'highway'])
    assert row == {'osm_type': 'way', 'osm_id': 7, 'tunnel': 'yes', 'highway': None,
                   'other_tags': json.dumps({'name': 'T', 'osm_id': 'q', 'zz': '1'}, ensure_ascii=False,
                                            sort_keys=True)}
    assert u.row_of({'type': 'node', 'id': 1, 'tags': {'tunnel': 'yes'}}, ['tunnel'])['other_tags'] is None


# ── bake: a tiny extract ─────────────────────────────────────────────────────

def tiny_extract(d: Path) -> Path:
    """features.parquet + way_nodes.parquet as extract() writes them."""
    con = pipeline.make_con()
    feats = [
        ('way', 1, {'highway': 'primary', 'tunnel': 'yes', 'name': 'Banihal'}, [10, 11], None, None),
        ('way', 2, {'waterway': 'stream', 'tunnel': 'culvert'}, [10, 11], None, None),
        ('way', 3, {'power': 'cable', 'voltage': '33000'}, [11, 12], None, None),
        ('node', 4, {'man_made': 'mineshaft', 'resource': 'coal'}, None, 25.2, 92.1),
        ('way', 5, {'man_made': 'mineshaft'}, [20, 21, 22, 23, 20], None, None),
    ]
    con.execute('CREATE TABLE f (kind VARCHAR, id BIGINT, tags MAP(VARCHAR, VARCHAR), refs BIGINT[], '
                'lat DOUBLE, lon DOUBLE)')
    for kind, oid, tags, refs, lat, lon in feats:
        con.execute('INSERT INTO f VALUES (?, ?, MAP(?, ?), ?, ?, ?)',
                    [kind, oid, list(tags), list(tags.values()), refs, lat, lon])
    con.execute(f"COPY f TO '{d / 'features.parquet'}' (FORMAT PARQUET)")
    nodes = [(10, 75.0, 33.0), (11, 75.1, 33.1), (12, 75.2, 33.2),
             (20, 92.0, 25.0), (21, 92.002, 25.0), (22, 92.002, 25.002), (23, 92.0, 25.002)]
    con.execute('CREATE TABLE n (id BIGINT, lon DOUBLE, lat DOUBLE)')
    con.executemany('INSERT INTO n VALUES (?, ?, ?)', nodes)
    con.execute(f"COPY n TO '{d / 'way_nodes.parquet'}' (FORMAT PARQUET)")
    return d


def test_the_bake_builds_each_layer_with_its_geometry_and_no_mapper_data(tmp_path):
    osm = tiny_extract(tmp_path)
    con = pipeline.make_con()
    out = {}
    for lid in u.LAYERS:
        out[lid] = tmp_path / f'{lid}.parquet'
        assert u.build_table(con, osm, lid, '2026-11-19', out[lid], min_share=0.01) == {
            'osm_tunnels': 1, 'osm_underground_utilities': 1, 'osm_mines_caves': 2}[lid]
    t = con.execute(f"""SELECT osm_type, osm_id, tunnel, highway, name, ST_AsText(geometry), as_of
                        FROM '{out['osm_tunnels']}'""").fetchall()
    assert t == [('way', 1, 'yes', 'primary', 'Banihal', 'LINESTRING (75 33, 75.1 33.1)', '2026-11-19')]
    m = con.execute(f"""SELECT osm_type, osm_id, resource, round(ST_X(geometry), 4), round(ST_Y(geometry), 4)
                        FROM '{out['osm_mines_caves']}' ORDER BY osm_id""").fetchall()
    assert m == [('node', 4, 'coal', 92.1, 25.2), ('way', 5, None, 92.001, 25.001)]   # an area at its centre
    for lid, p in out.items():
        cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM '{p}'").fetchall()]
        assert cols[:2] == ['osm_type', 'osm_id'] and cols[-2:] == ['as_of', 'geometry'], lid
        assert not {'user', 'uid', 'changeset', 'version', 'timestamp'} & set(cols), lid


# ── register ─────────────────────────────────────────────────────────────────

SOURCES = {'url': 'https://download.geofabrik.de/asia/india/india-261119.osm.pbf', 'file': 'x', 'md5': 'a' * 32,
           'bytes': 1, 'as_of': '2026-11-19', 'fetched_at': '2026-11-21T00:00:00+00:00'}


def summary():
    return {'sources': SOURCES, 'layers': {
        lid: {'rows': 10, 'sizes': {f: 100 for f in u.EXT},
              'names': {f: f'{m["basename"]}.0123abcd.{e}' for f, e in u.EXT.items()}}
        for lid, m in u.LAYERS.items()}}


def test_each_entry_is_odbl_credited_to_openstreetmap_and_says_coverage_is_incomplete():
    for lid in u.LAYERS:
        e = u.catalog_entry(lid, summary(), {}, 'https://r2')
        assert e['id'] == lid and e['rows'] == 10 and e['licence'] == 'ODbL-1.0'
        assert e['attribution']['primary'] == {'name': '© OpenStreetMap contributors',
                                               'url': 'https://www.openstreetmap.org/copyright'}
        assert e['parquet']['url'].startswith(f'https://r2/{u.R2_PREFIX}/') and e['fetched_at'] == '2026-11-19'
        assert e['category'] in ('transport', 'infrastructure', 'environment')
        assert e['refresh']['class'] == 'fast'
        assert e['source_check']['url'] == u.GEOFABRIK_INDIA
        assert 'pmtiles' in e
        for text in (e['notes'], u.LAYERS[lid]['description']):
            assert '—' not in text and 'catalog' not in text.lower()
        assert 'incomplete' in e['notes']


def test_registering_twice_changes_nothing_and_keeps_the_reviewed_labels(tmp_path):
    cat, man, sm = tmp_path / 'catalog.json', tmp_path / 'manifest.json', tmp_path / 'summary.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': [], 'attribution': {}}))
    man.write_text('[]')
    sm.write_text(json.dumps(summary()))
    u.register(cat, man, sm, 'https://r2')
    once = cat.read_text(), man.read_text()
    u.register(cat, man, sm, 'https://r2')
    assert (cat.read_text(), man.read_text()) == once
    c = json.loads(once[0])
    assert [x['id'] for x in c['layers']] == list(u.LAYERS) and c['level_order'] == list(u.LAYERS)
    import licence_watch
    for layer in c['layers']:
        assert licence_watch.labelled(layer) == layer
    assert [r['id'] for r in json.loads(once[1])] == list(u.LAYERS)


def test_populate_scripts_agree_with_the_bake():
    import populate_refresh
    import populate_source_check
    for lid in u.LAYERS:
        e = u.catalog_entry(lid, summary(), {}, 'https://r2')
        built = {k: v for k, v in e['refresh'].items() if k not in ('audited_at', 'next_due')}
        assert populate_refresh.infer(e)[0] == built
        assert populate_source_check.merge(e['source_check'], populate_source_check.infer(e, None)) == e['source_check']
