"""atal_bhujal_wells: groundwater levels in the Atal Bhujal Yojana monitoring wells (2015-2022),
the data.gov.in resource as CoRE Stack republishes it (one GeoJSON on Google Drive, named by
CoRE Stack's STAC item). Pinned by sha256, every column as published, a point from the
published Latitude/Longitude, and the catalog entry.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_atal_bhujal_wells.py -q
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_atal_bhujal_wells as a  # noqa: E402
import pipeline  # noqa: E402

PRE, POST = 'Pre-monsoon_2015 (meters below ground level)', 'Post-monsoon_2015 (meters below ground level)'


def feature(**props):
    base = {'Aquifer': 'Semi confined', 'Block_Name_With_LGD_Code': 'Devanahalli_5603', 'Latitude': 13.25,
            'Longitude': 77.7249984741211, POST: '24.06', PRE: '23.9', 'SOURCE': 'CGWB', 'Sr No': 1284,
            'State_Name_With_LGD_Code': 'Karnataka_29', 'TYPE': 'Bore Well', 'Well_Depth (meters)': 60.0,
            'Well_ID': 'W131500077433001'}
    return {'type': 'Feature', 'geometry': {'type': 'MultiPoint', 'coordinates': []}, 'properties': {**base, **props}}


def geojson(*features) -> bytes:
    return json.dumps({'type': 'FeatureCollection', 'features': list(features)}).encode()


ITEM = {'id': 'borewells_vector', 'assets': {'drive-link': {'href': f'https://drive.google.com/file/d/{a.DRIVE_ID}/view'}}}


# ── pull: the file CoRE Stack's STAC item names, fetched once, pinned by sha256 ──

def test_the_pull_fetches_the_file_the_stac_item_names_once(tmp_path):
    body = geojson(feature())
    got = []

    def download(url, dest):
        got.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(body)
    first = a.pull(tmp_path, lambda url: ITEM, download, now='2026-11-20T10:00:00+00:00')
    assert got == [a.DOWNLOAD_URL]
    assert first == {'drive_id': a.DRIVE_ID, 'sha256': hashlib.sha256(body).hexdigest(),
                     'path': str(tmp_path / 'borewells.geojson'), 'pulled_at': '2026-11-20T10:00:00+00:00'}
    again = a.pull(tmp_path, lambda url: ITEM, download, now='2026-11-21T10:00:00+00:00')
    assert got == [a.DOWNLOAD_URL] and again == first     # nothing fetched, nothing re-dated


def test_a_stac_item_pointing_at_another_file_stops_the_pull(tmp_path):
    moved = {'assets': {'drive-link': {'href': 'https://drive.google.com/file/d/OTHER/view'}}}
    with pytest.raises(ValueError, match='OTHER'):
        a.pull(tmp_path, lambda url: moved, lambda url, dest: None)


# ── bake: every column as published, numbers as numbers, a point from Latitude/Longitude ──

def test_the_table_keeps_every_column_in_published_order_and_casts_only_all_number_columns(tmp_path):
    src = tmp_path / 'b.geojson'
    src.write_bytes(geojson(feature(), feature(**{POST: 'NA', 'Well_ID': 'W2', 'Sr No': 2, 'Latitude': 26.1,
                                                  'Longitude': 74.5})))
    out = tmp_path / 't.parquet'
    assert a.build_table(pipeline.make_con(), src, out) == 2
    con = pipeline.make_con()
    cols = {r[0]: r[1] for r in con.execute(f"DESCRIBE SELECT * FROM '{out}'").fetchall()}
    assert list(cols) == [*feature()['properties'], 'geometry']
    assert cols[POST] == 'DOUBLE' and cols['Sr No'] == 'BIGINT' and cols['Well_ID'] == 'VARCHAR'
    rows = con.execute(f"""SELECT Well_ID, "{POST}", ST_X(geometry), ST_Y(geometry) FROM '{out}'""").fetchall()
    assert rows == [('W131500077433001', 24.06, 77.7249984741211, 13.25), ('W2', None, 74.5, 26.1)]


def test_a_well_without_coordinates_stays_with_no_point(tmp_path):
    src = tmp_path / 'b.geojson'
    src.write_bytes(geojson(feature(Latitude=None, Longitude=None)))
    out = tmp_path / 't.parquet'
    assert a.build_table(pipeline.make_con(), src, out) == 1
    assert pipeline.make_con().execute(f"SELECT geometry IS NULL FROM '{out}'").fetchall() == [(True,)]


def test_a_file_with_points_already_is_refused_rather_than_guessed(tmp_path):
    f = feature()
    f['geometry'] = {'type': 'Point', 'coordinates': [77.7, 13.2]}
    src = tmp_path / 'b.geojson'
    src.write_bytes(geojson(f))
    with pytest.raises(ValueError, match='geometry'):
        a.build_table(pipeline.make_con(), src, tmp_path / 't.parquet')


# ── register ─────────────────────────────────────────────────────────────────

PULL = {'drive_id': a.DRIVE_ID, 'sha256': 'f' * 64, 'path': 'x', 'pulled_at': '2026-11-20T10:00:00+00:00'}
NAMES = {f: f'Atal_Bhujal_Wells.0123abcd.{e}' for f, e in a.EXT.items()}


def summary():
    return {'rows': 5490, 'states': {'Karnataka_29': 1250}, 'sizes': {f: 100 for f in a.EXT}, 'names': NAMES,
            'pull': PULL}


def test_the_entry_is_godl_credited_to_the_ministry_via_core_stack():
    e = a.catalog_entry(summary(), {}, 'https://r2')
    assert e['id'] == 'atal_bhujal_wells' and e['rows'] == 5490 and e['licence'] == 'GODL-India'
    assert e['attribution']['primary']['url'] == a.DATAGOV_URL
    assert e['attribution']['publisher'] == {'name': 'CoRE Stack', 'url': 'https://core-stack.org/'}
    assert e['parquet'] == {'url': 'https://r2/water/atal-bhujal-wells/Atal_Bhujal_Wells.0123abcd.parquet',
                            'bytes': 100}
    assert e['category'] == 'water' and e['fetched_at'] == PULL['pulled_at']
    assert e['source_check']['fingerprint'] == f'sha256={"f" * 64}'
    assert e['refresh']['class'] == 'frozen'
    for text in (e['notes'], a.description()):
        assert 'metres below ground level' in text and '—' not in text and 'catalog' not in text.lower()


def test_registering_twice_changes_nothing_and_keeps_the_reviewed_labels(tmp_path):
    cat, man, sm = tmp_path / 'catalog.json', tmp_path / 'manifest.json', tmp_path / 'summary.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': [], 'attribution': {}}))
    man.write_text('[]')
    sm.write_text(json.dumps(summary()))
    a.register(cat, man, sm, 'https://r2')
    once = cat.read_text(), man.read_text()
    a.register(cat, man, sm, 'https://r2')
    assert (cat.read_text(), man.read_text()) == once
    c = json.loads(once[0])
    assert [x['id'] for x in c['layers']] == ['atal_bhujal_wells'] and c['level_order'] == ['atal_bhujal_wells']
    import licence_watch
    assert licence_watch.labelled(c['layers'][0]) == c['layers'][0]


def test_populate_scripts_agree_with_the_bake():
    import populate_refresh
    import populate_source_check
    e = a.catalog_entry(summary(), {}, 'https://r2')
    assert populate_refresh.infer(e)[0]['class'] == e['refresh']['class']
    assert populate_source_check.merge(e['source_check'], populate_source_check.infer(e, None)) == e['source_check']
