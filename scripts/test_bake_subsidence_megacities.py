"""subsidence_megacities from Ohenhen et al. 2025 (figshare 25856260): the pinned
version's VLM CSVs (cached, md5-checked, idempotent), India's cities only, every
value as published plus the city, and the catalog entry.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_subsidence_megacities.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_subsidence_megacities as s  # noqa: E402
import pipeline  # noqa: E402

HEADER = 'Longitude,Latitude,VLM_cm_per_yr'
CC0 = {'value': 95, 'name': 'CC0 1.0 Universal (CC0 1.0) Public Domain Dedication',
       'url': 'https://creativecommons.org/publicdomain/zero/1.0/'}


def file_row(fid: int, name: str, md5: str = 'abc') -> dict:
    return {'id': fid, 'name': name, 'size': 10, 'computed_md5': md5,
            'download_url': f'https://ndownloader.figshare.com/files/{fid}'}


ARTICLE = {
    'id': 25856260, 'version': 3, 'license': CC0, 'doi': '10.7294/25856260.v3',
    'modified_date': '2025-11-03T12:00:00Z', 'published_date': '2025-11-03T12:00:00Z',
    'files': [file_row(1, 'New_Delhi_VLM_data.csv'), file_row(2, 'Mumbai_VLM_data.csv'),
              file_row(3, 'Bengaluru_VLM_data.csv'), file_row(4, 'Chennai_VLM_data.csv'),
              file_row(5, 'Kolkata_VLM_data.csv'),
              file_row(6, 'Jakarta_VLM_data.csv'),                      # not India: never fetched
              file_row(7, 'New_Delhi_Buildings_Damage_Risk.zip'),       # not this layer
              file_row(8, 'README.rtf')],
}


def fake_download(got: list):
    def download(url, dest, md5):
        got.append((url, md5))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(HEADER + '\n')
    return download


# ── pull: one pinned version, India's VLM files, downloaded once ─────────────

def test_the_pull_pins_the_version_fetches_india_only_and_a_rerun_downloads_nothing(tmp_path):
    asked, got = [], []

    def get_json(url):
        asked.append(url)
        return ARTICLE

    first = s.pull(tmp_path, get_json, fake_download(got), now='2026-11-20T05:00:00+00:00')
    assert asked == ['https://api.figshare.com/v2/articles/25856260/versions/3']
    assert got == [(f'https://ndownloader.figshare.com/files/{i}', 'abc') for i in range(1, 6)]
    assert first['version'] == 3 and first['licence'] == CC0['name'] and first['pulled_at'] == '2026-11-20T05:00:00+00:00'
    assert list(first['files']) == ['New Delhi', 'Mumbai', 'Bengaluru', 'Chennai', 'Kolkata']
    assert first['files']['Kolkata'] == {'name': 'Kolkata_VLM_data.csv', 'id': 5, 'md5': 'abc',
                                         'csv': str(tmp_path / 'v3' / 'Kolkata_VLM_data.csv')}
    again = s.pull(tmp_path, get_json, fake_download(got), now='2026-11-21T05:00:00+00:00')
    assert len(got) == 5 and again == first        # nothing fetched, nothing re-dated


def test_a_licence_other_than_cc0_stops_the_pull(tmp_path):
    other = {**ARTICLE, 'license': {'name': 'CC BY-NC 4.0'}}
    with pytest.raises(ValueError, match='licence'):
        s.pull(tmp_path, lambda url: other, fake_download([]))


def test_a_missing_city_is_an_error_not_a_smaller_layer(tmp_path):
    short = {**ARTICLE, 'files': ARTICLE['files'][1:]}
    with pytest.raises(ValueError, match='New_Delhi_VLM_data.csv'):
        s.pull(tmp_path, lambda url: short, fake_download([]))


# ── bake: every value as published, plus the city ────────────────────────────

@pytest.fixture
def csvs(tmp_path):
    rows = {'New Delhi': ['77.2,28.6,-1.5', '77.21,28.61,0.25'],
            'Kolkata': ['88.1425894897431,22.5482805305067,-0.196397849249115',
                        '88.1425894897431,22.5482805305067,-0.178651656095395']}   # same point twice, as published
    out = {}
    for city, lines in rows.items():
        p = tmp_path / f'{city}.csv'
        p.write_text('\n'.join([HEADER, *lines]) + '\n')
        out[city] = p
    return out


def test_the_table_keeps_every_column_and_value_as_published_plus_the_city(tmp_path, csvs):
    out = tmp_path / 'vlm.parquet'
    counts = s.build_table(pipeline.make_con(), csvs, out)
    con = pipeline.make_con()
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM '{out}'").fetchall()]
    assert cols == ['Longitude', 'Latitude', 'VLM_cm_per_yr', 'city', 'geometry']
    got = con.execute(f"""SELECT city, Longitude, Latitude, VLM_cm_per_yr, ST_X(geometry), ST_Y(geometry)
                          FROM '{out}'""").fetchall()
    assert got == [('New Delhi', 77.2, 28.6, -1.5, 77.2, 28.6), ('New Delhi', 77.21, 28.61, 0.25, 77.21, 28.61),
                   ('Kolkata', 88.1425894897431, 22.5482805305067, -0.196397849249115, 88.1425894897431,
                    22.5482805305067),
                   ('Kolkata', 88.1425894897431, 22.5482805305067, -0.178651656095395, 88.1425894897431,
                    22.5482805305067)]
    assert counts == {'New Delhi': 2, 'Kolkata': 2}


def test_a_point_published_without_a_value_stays_in_the_layer(tmp_path):
    csv = tmp_path / 'mumbai.csv'
    csv.write_text(f'{HEADER}\n73.22,19.39,NaN\n73.1,19.0,-0.5\n')
    out = tmp_path / 'vlm.parquet'
    assert s.build_table(pipeline.make_con(), {'Mumbai': csv}, out) == {'Mumbai': 2}
    got = pipeline.make_con().execute(f"SELECT isnan(VLM_cm_per_yr) FROM '{out}'").fetchall()
    assert got == [(True,), (False,)]


def test_a_city_file_with_other_columns_is_refused(tmp_path, csvs):
    csvs['Kolkata'].write_text('Longitude,Latitude,VLM_mm_per_yr\n88,22,1\n')
    with pytest.raises(ValueError, match='Kolkata'):
        s.build_table(pipeline.make_con(), csvs, tmp_path / 'vlm.parquet')


# ── register: the catalog entry ──────────────────────────────────────────────

PULL = {'article': 25856260, 'version': 3, 'doi': '10.7294/25856260.v3', 'licence': CC0['name'],
        'modified_date': '2025-11-03T12:00:00Z', 'pulled_at': '2026-11-20T05:00:00+00:00'}
NAMES = {f: f'Subsidence_Megacities.0123abcd.{e}' for f, e in s.EXT.items()}
SIZES = {f: 100 for f in s.EXT}
COUNTS = {'New Delhi': 5, 'Mumbai': 4, 'Bengaluru': 3, 'Chennai': 2, 'Kolkata': 1}


def summary(**kw):
    return {'rows': 15, 'cities': COUNTS, 'sizes': SIZES, 'names': NAMES, 'pull': PULL, **kw}


def test_the_entry_names_the_paper_its_version_a_cc0_licence_and_the_units():
    e = s.catalog_entry(summary(), {}, 'https://r2')
    assert e['id'] == 'subsidence_megacities' and e['licence'] == 'CC0-1.0' and e['rows'] == 15
    assert e['parquet'] == {'url': 'https://r2/environment/subsidence_megacities/'
                                   'Subsidence_Megacities.0123abcd.parquet', 'bytes': 100}
    assert e['attribution']['primary']['url'] == 'https://doi.org/10.7294/25856260.v3'
    assert e['source_check']['method'] == 'manual' and e['source_check']['fingerprint'] == 'version=3'
    assert e['fetched_at'] == PULL['pulled_at']
    assert e['refresh']['class'] == 'frozen' and e['refresh']['next_due'] is None
    assert e['category'] == 'environment' and e['provenance'] == 'curated'
    for text in (e['notes'], s.description()):
        assert 'cm/yr' in text and 'negative' in text and '—' not in text
        assert 'catalog' not in text.lower()


def test_registering_twice_changes_nothing(tmp_path):
    cat, man, sm = tmp_path / 'catalog.json', tmp_path / 'manifest.json', tmp_path / 'summary.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': [], 'attribution': {}}))
    man.write_text('[]')
    sm.write_text(json.dumps(summary()))
    s.register(cat, man, sm, 'https://r2')
    once = cat.read_text(), man.read_text()
    s.register(cat, man, sm, 'https://r2')
    assert (cat.read_text(), man.read_text()) == once
    c = json.loads(once[0])
    assert [x['id'] for x in c['layers']] == ['subsidence_megacities']
    assert c['level_order'] == ['subsidence_point']
    assert c['level_meta']['subsidence_point']['unit'] == 'points'
    assert c['attribution'][s.SOURCE]['url'] == 'https://doi.org/10.7294/25856260.v3'
    assert json.loads(once[1])[0]['features'] == 15


def test_populate_scripts_agree_with_the_bake():
    import populate_refresh
    import populate_source_check
    e = s.catalog_entry(summary(), {}, 'https://r2')
    block, _ = populate_refresh.infer(e)
    assert block['class'] == e['refresh']['class']
    inferred = populate_source_check.infer(e, None)
    assert populate_source_check.merge(e['source_check'], inferred) == e['source_check']
