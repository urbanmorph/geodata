"""gem_active_faults: the GEM Global Active Faults Database (Styron and Pagani 2020), the fault
traces that touch India as bharatlas publishes it (india_boundary, claims included). Pinned to
a commit and sha256, licence read from the repository, whole features kept, every column as
published, and the catalog entry.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_gem_active_faults.py -q
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_gem_active_faults as g  # noqa: E402
import pipeline  # noqa: E402


def feature(coords, **props):
    return {'type': 'Feature', 'properties': props, 'geometry': {'type': 'LineString', 'coordinates': coords}}


def geojson(*features) -> bytes:
    return json.dumps({'type': 'FeatureCollection', 'features': list(features)}).encode()


def boundary(path: Path) -> Path:
    """A square 'India' from (70, 10) to (90, 30), as a parquet like india_boundary's."""
    con = pipeline.make_con()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute(f"""COPY (SELECT 'India' AS name, ST_GeomFromText('MULTIPOLYGON(((70 10, 90 10, 90 30, 70 30, 70 10)))')
                     AS geometry) TO '{path}' (FORMAT PARQUET)""")
    return path


BODY = geojson(feature([[80, 20], [81, 21]], catalog_id='HTM_1', catalog_name='HimaTibetMap', slip_type='Reverse'))
SHA = hashlib.sha256(BODY).hexdigest()
COMMITS = [{'sha': g.COMMIT, 'commit': {'committer': {'date': '2021-06-24T16:48:23Z'}}}]
LICENCE_API = {'license': {'spdx_id': 'CC-BY-SA-4.0'}}
BOUNDARY_URL = 'https://r2/reference/india_boundary.463f149c.parquet'


def answers(commits=COMMITS, licence=LICENCE_API):
    return lambda url: licence if url == g.LICENCE_URL else commits


# ── pull: the pinned commit's file, its sha256 and licence checked, fetched once ──

def test_the_pull_fetches_the_pinned_file_and_the_boundary_once(tmp_path, monkeypatch):
    monkeypatch.setattr(g, 'SHA256', SHA)
    got = []

    def download(url, dest):
        got.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(BODY if url == g.RAW_URL else b'boundary')
    first = g.pull(tmp_path, answers(), download, BOUNDARY_URL, now='2026-11-21T10:00:00+00:00')
    assert got == [g.RAW_URL, BOUNDARY_URL]
    assert first['commit'] == g.COMMIT and first['sha256'] == SHA and first['licence'] == 'CC-BY-SA-4.0'
    assert first['committed_at'] == '2021-06-24T16:48:23Z' and first['pulled_at'] == '2026-11-21T10:00:00+00:00'
    assert first['boundary'] == {'url': BOUNDARY_URL, 'sha256': hashlib.sha256(b'boundary').hexdigest(),
                                 'path': str(tmp_path / 'india_boundary.463f149c.parquet')}
    again = g.pull(tmp_path, answers(), download, BOUNDARY_URL, now='2026-11-22T10:00:00+00:00')
    assert len(got) == 2 and again == first      # nothing fetched, nothing re-dated


def test_a_newer_commit_of_the_file_stops_the_pull(tmp_path):
    newer = [{'sha': 'abc123', 'commit': {'committer': {'date': '2027-01-01T00:00:00Z'}}}]
    with pytest.raises(ValueError, match='abc123'):
        g.pull(tmp_path, answers(commits=newer), lambda url, dest: None, BOUNDARY_URL)


def test_a_changed_licence_stops_the_pull(tmp_path):
    with pytest.raises(ValueError, match='CC-BY-4.0'):
        g.pull(tmp_path, answers(licence={'license': {'spdx_id': 'CC-BY-4.0'}}), lambda url, dest: None,
               BOUNDARY_URL)


def test_a_file_that_is_not_the_pinned_one_is_deleted_and_refused(tmp_path):
    def download(url, dest):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b'something else')
    with pytest.raises(ValueError, match='sha256'):
        g.pull(tmp_path, answers(), download, BOUNDARY_URL)
    assert not (tmp_path / g.COMMIT / g.FILE_NAME).exists()


# ── bake: the faults that touch India, whole, every column as published ──

def test_only_faults_touching_india_are_kept_whole_with_every_column_in_published_order(tmp_path):
    src = tmp_path / 'f.geojson'
    src.write_bytes(geojson(
        feature([[60, 20], [65, 20]], catalog_id='EMME_1', catalog_name='EMME', accuracy='100000'),  # outside
        feature([[85, 25], [95, 25]], slip_type='Reverse', catalog_id='HTM_2', catalog_name='HimaTibetMap',
                accuracy='250000', net_slip_rate='(15,10,21)'),                                          # crosses
        feature([[80, 20], [81, 21]], catalog_id='HTM_3', catalog_name='HimaTibetMap', name='Inside',
                accuracy='40000', notes='as published'),                                                  # inside
    ))
    out = tmp_path / 't.parquet'
    assert g.build_table(pipeline.make_con(), src, boundary(tmp_path / 'b.parquet'), out) == 2
    con = pipeline.make_con()
    con.execute('INSTALL spatial; LOAD spatial;')
    cols = {r[0]: r[1] for r in con.execute(f"DESCRIBE SELECT * FROM '{out}'").fetchall()}
    assert list(cols) == ['catalog_id', 'catalog_name', 'accuracy', 'slip_type', 'net_slip_rate', 'name', 'notes',
                          'geometry']
    assert cols['accuracy'] == 'BIGINT' and cols['net_slip_rate'] == 'VARCHAR'
    rows = con.execute(f"""SELECT catalog_id, accuracy, net_slip_rate, ST_AsText(geometry) FROM '{out}'""").fetchall()
    assert rows == [('HTM_2', 250000, '(15,10,21)', 'LINESTRING (85 25, 95 25)'),      # not cut at the border
                    ('HTM_3', 40000, None, 'LINESTRING (80 20, 81 21)')]


# ── register ─────────────────────────────────────────────────────────────────

PULL = {'commit': g.COMMIT, 'committed_at': '2021-06-24T16:48:23Z', 'sha256': SHA, 'licence': 'CC-BY-SA-4.0',
        'path': 'x', 'boundary': {'url': BOUNDARY_URL, 'sha256': 'b' * 64, 'path': 'y'},
        'pulled_at': '2026-11-21T10:00:00+00:00'}
NAMES = {f: f'GEM_Active_Faults.0123abcd.{e}' for f, e in g.EXT.items()}


def summary():
    return {'rows': 75, 'catalogs': {'HimaTibetMap': 49}, 'sizes': {f: 100 for f in g.EXT}, 'names': NAMES,
            'pull': PULL}


def test_the_entry_is_share_alike_and_credits_gem_as_it_asks():
    e = g.catalog_entry(summary(), {}, 'https://r2')
    assert e['id'] == 'gem_active_faults' and e['rows'] == 75 and e['licence'] == 'CC-BY-SA-4.0'
    assert e['category'] == 'environment' and e['fetched_at'] == PULL['pulled_at']
    assert e['attribution']['primary']['url'] == g.REPO_URL
    assert e['parquet'] == {'url': 'https://r2/environment/gem-active-faults/GEM_Active_Faults.0123abcd.parquet',
                            'bytes': 100}
    assert e['source_check']['method'] == 'github_commit'
    assert e['source_check']['fingerprint'] == f'commit={g.COMMIT}'
    assert e['source_check']['changed_at'] == '2021-06-24T16:48:23Z'
    assert 'Styron' in e['notes'] and '10.1177/8755293020944182' in e['notes']
    assert 'share' in e['notes'].lower()
    for text in (e['notes'], g.description()):
        assert '—' not in text and 'catalog' not in text.lower()


def test_registering_twice_changes_nothing_and_keeps_the_reviewed_labels(tmp_path):
    cat, man, sm = tmp_path / 'catalog.json', tmp_path / 'manifest.json', tmp_path / 'summary.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': [], 'attribution': {}}))
    man.write_text('[]')
    sm.write_text(json.dumps(summary()))
    g.register(cat, man, sm, 'https://r2')
    once = cat.read_text(), man.read_text()
    g.register(cat, man, sm, 'https://r2')
    assert (cat.read_text(), man.read_text()) == once
    c = json.loads(once[0])
    assert [x['id'] for x in c['layers']] == ['gem_active_faults'] and c['level_order'] == ['active_fault']
    import licence_watch
    assert licence_watch.labelled(c['layers'][0]) == c['layers'][0]
    assert licence_watch.labels_of('gem_active_faults', licence_watch.load_registry())['licence'] == 'CC-BY-SA-4.0'


def test_populate_scripts_agree_with_the_bake():
    import populate_refresh
    import populate_source_check
    e = g.catalog_entry(summary(), {}, 'https://r2')
    assert populate_refresh.infer(e)[0]['class'] == e['refresh']['class']
    assert populate_source_check.merge(e['source_check'], populate_source_check.infer(e, None)) == e['source_check']
