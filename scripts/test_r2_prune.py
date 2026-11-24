"""Tests for scripts/r2_prune.py (no R2: every listing is a fixture, every delete goes to a fake client).

Rule 4 of the data-lifecycle spec: keep every parquet and download version, every release file, the current map
tiles and the version before them; prune only older tiles. Rule 5: anything a release manifest names is pinned.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_r2_prune.py -q
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import r2_prune as rp  # noqa: E402

R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'
NOW = datetime(2026, 11, 18, tzinfo=timezone.utc)


def obj(key, days_old, size=1000):
    return {'key': key, 'size': size, 'last_modified': NOW - timedelta(days=days_old)}


def catalog(*urls_by_layer):
    layers = []
    for i, urls in enumerate(urls_by_layer):
        lyr = {'id': f'l{i}'}
        for fmt, key in urls.items():
            lyr[fmt] = {'url': f'{R2}/{key}', 'bytes': 1}
        layers.append(lyr)
    return {'layers': layers}


CAT = catalog({'pmtiles': 'admin/states/LGD_States.cccccccc.pmtiles',
               'parquet': 'admin/states/LGD_States.148c41d7.parquet',
               'geojson': 'admin/states/LGD_States.geojson'},
              {'pmtiles': 'ramseraph/forests/FSI_Beats.pmtiles'})

LISTING = [
    obj('admin/states/LGD_States.pmtiles', 300),            # the original upstream-named tile
    obj('admin/states/LGD_States.aaaaaaaa.pmtiles', 200),
    obj('admin/states/LGD_States.bbbbbbbb.pmtiles', 100),   # the previous version: kept
    obj('admin/states/LGD_States.cccccccc.pmtiles', 50),    # current
    obj('admin/states/LGD_States.parquet', 300),            # an old parquet: kept forever
    obj('admin/states/LGD_States.148c41d7.parquet', 50),
    obj('admin/states/LGD_States.geojson', 300),
    obj('admin/states/LGD_States.shp.zip', 300),
    obj('admin/states/LGD_Districts.z12.pmtiles', 90),      # a tile no current layer uses
    obj('ramseraph/forests/FSI_Beats.pmtiles', 40),         # current, no older sibling
]


def plan(listing=LISTING, cat=CAT, pinned=frozenset(), min_age_days=30):
    return rp.plan(listing, rp.current_keys(cat), set(pinned), NOW, min_age_days)


def proposed(p):
    return sorted(o['key'] for o in p.delete)


def test_r2_keys_come_from_public_r2_urls_and_bharatlas_release_urls():
    assert rp.r2_key(f'{R2}/admin/states/LGD_States.parquet') == 'admin/states/LGD_States.parquet'
    assert rp.r2_key('https://bharatlas.com/releases/bharatlas-cw-2026.11/cw_states.csv') == \
        'releases/bharatlas-cw-2026.11/cw_states.csv'
    assert rp.r2_key('https://github.com/x/y/releases/download/a/b.parquet') is None
    assert rp.r2_key(f'{R2}/a/b.pmtiles?v=2') == 'a/b.pmtiles'


def test_current_keys_are_every_r2_url_anywhere_in_the_catalog():
    cur = rp.current_keys({'layers': [{'id': 'a', 'pmtiles': {'url': f'{R2}/a/x.pmtiles'},
                                       'extra': {'deep': [f'{R2}/a/y.pmtiles']}}],
                           'state_extracts': [{'url': f'{R2}/s/z.parquet'}]})
    assert cur == {'a/x.pmtiles', 'a/y.pmtiles', 's/z.parquet'}


def test_pinned_keys_are_every_file_a_release_manifest_names_by_url_or_key():
    manifest = {'code': 'bharatlas-cw-2026.11',
                'files': [{'name': 'cw_states.csv',
                           'url': 'https://bharatlas.com/releases/bharatlas-cw-2026.11/cw_states.csv'}],
                'attribution': {'sources': [{'version': {'lgd_states': {
                    'url': f'{R2}/admin/states/LGD_States.parquet', 'sha256': 'x'}}}]},
                'inputs': [{'key': 'admin/states/LGD_States.aaaaaaaa.pmtiles'}]}
    assert rp.pinned_keys([manifest]) == {'releases/bharatlas-cw-2026.11/cw_states.csv',
                                          'admin/states/LGD_States.parquet',
                                          'admin/states/LGD_States.aaaaaaaa.pmtiles'}


def test_the_real_release_manifests_pin_the_four_crosswalk_inputs():
    pinned = rp.pinned_keys(rp.load_manifests(rp.RELEASES_ROOT))
    for name in ('States', 'Districts', 'Subdistricts', 'Blocks'):
        assert f'admin/{name.lower()}/LGD_{name}.parquet' in pinned


def test_only_tiles_older_than_the_previous_version_are_proposed():
    p = plan()
    assert proposed(p) == ['admin/states/LGD_Districts.z12.pmtiles',
                           'admin/states/LGD_States.aaaaaaaa.pmtiles',
                           'admin/states/LGD_States.pmtiles']


def test_the_current_and_previous_tiles_are_kept_with_their_reasons():
    kept = {o['key']: why for o, why in plan().keep}
    assert kept['admin/states/LGD_States.cccccccc.pmtiles'] == 'current'
    assert kept['admin/states/LGD_States.bbbbbbbb.pmtiles'] == 'previous version'
    assert kept['ramseraph/forests/FSI_Beats.pmtiles'] == 'current'


def test_parquet_downloads_zips_and_release_files_are_never_proposed():
    listing = LISTING + [obj('releases/bharatlas-cw-2026.11/x.pmtiles', 400), obj('cache/x/y.pmtiles', 400),
                         obj('admin/states/old.kml', 400)]
    keys = proposed(plan(listing))
    assert all(k.endswith('.pmtiles') for k in keys)
    assert not any(k.startswith(('releases/', 'cache/')) for k in keys)


def test_a_pinned_tile_is_never_proposed():
    p = plan(pinned={'admin/states/LGD_States.pmtiles'})
    assert 'admin/states/LGD_States.pmtiles' not in proposed(p)
    assert ('admin/states/LGD_States.pmtiles', 'pinned by a release') in [(o['key'], w) for o, w in p.keep]


def test_a_tile_younger_than_the_minimum_age_is_kept():
    p = plan(min_age_days=250)
    assert proposed(p) == ['admin/states/LGD_States.pmtiles']


def test_a_family_whose_current_tile_is_missing_from_the_listing_is_left_alone():
    listing = [o for o in LISTING if o['key'] != 'admin/states/LGD_States.cccccccc.pmtiles']
    keys = proposed(plan(listing))
    assert not any(k.startswith('admin/states/LGD_States') for k in keys)


def test_the_prefixes_listed_are_the_folders_of_current_keys_without_releases_or_cache():
    cur = {'admin/states/a.pmtiles', 'admin/states/b.parquet', 'community/x/x.parquet', 'releases/c/f.csv',
           'top.pmtiles'}
    assert rp.layer_prefixes(cur) == ['admin/states/', 'community/x/']


class FakeS3:
    def __init__(self, listing):
        self.listing = listing
        self.deleted: list[str] = []

    def list_objects(self, prefix):
        return [o for o in self.listing if o['key'].startswith(prefix) and '/' not in o['key'][len(prefix):]]

    def delete_keys(self, keys):
        self.deleted += keys


def test_the_dry_run_writes_the_list_with_sizes_and_deletes_nothing(tmp_path):
    s3 = FakeS3(LISTING)
    out = tmp_path / 'prune.txt'
    p = rp.dry_run(s3, rp.current_keys(CAT), set(), NOW, 30, out)
    assert s3.deleted == []
    lines = out.read_text().splitlines()
    assert [ln.split('\t')[0] for ln in lines if not ln.startswith('#')] == proposed(p)
    assert all(ln.split('\t')[1] == '1000' for ln in lines if not ln.startswith('#'))


def test_delete_needs_the_dry_run_list_and_rechecks_current_and_pinned_at_delete_time(tmp_path):
    out = tmp_path / 'prune.txt'
    rp.dry_run(FakeS3(LISTING), rp.current_keys(CAT), set(), NOW, 30, out)
    # between the dry run and the delete, a release pins one tile and the catalog rolls back a version,
    # which makes the one before it the previous version again
    cat2 = catalog({'pmtiles': 'admin/states/LGD_States.bbbbbbbb.pmtiles'},
                   {'pmtiles': 'ramseraph/forests/FSI_Beats.pmtiles'})
    s3 = FakeS3(LISTING)
    pinned_now = {'admin/states/LGD_Districts.z12.pmtiles'}
    deleted, refused = rp.delete_listed(s3, rp.current_keys(cat2), pinned_now, NOW, 30, out)
    assert s3.deleted == deleted == ['admin/states/LGD_States.pmtiles']
    assert sorted(refused) == ['admin/states/LGD_Districts.z12.pmtiles', 'admin/states/LGD_States.aaaaaaaa.pmtiles']


def test_delete_refuses_a_list_naming_anything_but_tiles(tmp_path):
    out = tmp_path / 'prune.txt'
    out.write_text('admin/states/LGD_States.parquet\t1\n')
    s3 = FakeS3(LISTING)
    deleted, refused = rp.delete_listed(s3, rp.current_keys(CAT), set(), NOW, 30, out)
    assert deleted == [] and refused == ['admin/states/LGD_States.parquet'] and s3.deleted == []


def test_main_without_a_list_file_never_deletes(tmp_path):
    with pytest.raises(SystemExit):
        rp.main(['--delete'])


def test_load_manifests_reads_every_release_folder(tmp_path):
    (tmp_path / 'bharatlas-a-2026.11').mkdir()
    (tmp_path / 'bharatlas-a-2026.11' / 'manifest.json').write_text(json.dumps({'code': 'bharatlas-a-2026.11'}))
    (tmp_path / 'index.json').write_text('{}')
    assert rp.load_manifests(tmp_path) == [{'code': 'bharatlas-a-2026.11'}]


def test_only_r2_prune_deletes_from_r2():
    """Rule: a published URL never breaks; r2_prune.py is the one script that deletes R2 objects."""
    here = Path(__file__).resolve().parent
    deleters = sorted(p.relative_to(here).as_posix() for p in here.rglob('*.py')
                      if not p.name.startswith('test_') and 'delete_object' in p.read_text())
    assert deleters == ['r2_prune.py']


def test_a_release_pinned_r2_dev_url_and_its_data_domain_url_are_the_same_key():
    # The catalog moved to data.bharatlas.com (Nov 2026); release manifests keep r2.dev.
    # A pinned object must stay pinned whichever address names it.
    import pipeline
    key = 'releases/bharatlas-cw-2026.11/cw_villages.parquet'
    assert rp.r2_key(f'{pipeline.R2_PUBLIC_LEGACY}/{key}') == key
    assert rp.r2_key(f'https://data.bharatlas.com/{key}') == key
