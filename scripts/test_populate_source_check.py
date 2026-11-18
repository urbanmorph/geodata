"""Tests for scripts/populate_source_check.py (no network).

Every layer gets a `source_check` saying how its upstream is checked for a newer version: a method
(http, github_release, github_commit, ckan, gtfs or manual) and the URL to ask, or for manual the reason.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_populate_source_check.py -q
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import populate_source_check as ps  # noqa: E402

R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'
YASH = 'https://github.com/yashveeeeeeer/india-geodata/releases/download'
RS = 'https://github.com/ramSeraph/indian_admin_boundaries/releases/download'


def layer(lid='lgd_districts', source='LGD', upstream=None, provenance='curated', **kw):
    base = {'id': lid, 'source': source, 'provenance': provenance, 'fetched_at': '2026-05-19T07:56:49+00:00',
            'attribution': {'primary': {'name': 'Somebody', 'url': 'https://example.gov.in/'}},
            'parquet': {'url': f'{R2}/x/{lid}.parquet', 'bytes': 1}}
    if upstream:
        base['parquet']['upstream_url'] = upstream
    base.update(kw)
    return base


def test_a_layer_republished_from_the_india_geodata_release_is_checked_on_that_release():
    up = f'{YASH}/admin/districts/LGD_Districts.parquet'
    assert ps.infer(layer(upstream=up), None) == {'method': 'github_release', 'url': up}


def test_a_ramseraph_release_asset_is_checked_on_its_release_whatever_the_source_portal():
    up = f'{RS}/forests/FSI_Beats.parquet'
    ext = {'source_url': 'https://fsi.nic.in/'}
    assert ps.infer(layer('fsi_beats', 'FSI', up), ext) == {'method': 'github_release', 'url': up}


def test_a_city_layer_with_a_templated_india_geodata_link_uses_its_own_source_not_that_link():
    # build_catalog templated a yashveer link for OpenCity layers that the release never held
    up = f'{YASH}/admin/wards-pune/wards_pune.parquet'
    ext = {'source_url': 'https://data.opencity.in/dataset/pune-wards-info'}
    sc = ps.infer(layer('wards_pune', 'OpenCity', up), ext)
    assert sc['method'] == 'manual'
    assert 'Cloudflare' in sc['reason']
    assert sc['url'] == 'https://data.opencity.in/dataset/pune-wards-info'


def test_a_recorded_geojson_upstream_wins_because_that_is_the_file_bharatlas_converted():
    lyr = layer('india_flood_inventory', 'IndiaFloodInventory', f'{YASH}/environment/flood-inventory/F.parquet',
                geojson={'url': f'{R2}/f.geojson', 'upstream_url': f'{YASH}/environment/flood-inventory/F.geojson'})
    assert ps.infer(lyr, None) == {'method': 'github_release', 'url': f'{YASH}/environment/flood-inventory/F.geojson'}


def test_a_datameet_folder_on_github_is_checked_by_its_latest_commit():
    src = 'https://github.com/datameet/Municipal_Spatial_Data/tree/master/Delhi'
    sc = ps.infer(layer('wards_delhi', 'DataMeet', f'{YASH}/admin/wards-delhi/wards_delhi.parquet'),
                  {'source_url': src})
    assert sc == {'method': 'github_commit', 'url': src}


def test_overture_is_checked_on_its_release_catalogue():
    up = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-09-23.1/theme=places/type=place/'
    sc = ps.infer(layer('overture_places_india', 'Overture', up), {'source_url': 'https://docs.overturemaps.org/'})
    assert sc == {'method': 'http', 'url': 'https://stac.overturemaps.org/catalog.json'}


def test_a_google_drive_file_is_manual_because_drive_has_no_keyless_metadata():
    up = 'https://drive.google.com/file/d/abc/view'
    sc = ps.infer(layer('cgwb_aquifers', 'CGWB', up), {'source_url': 'https://cgwb.gov.in/'})
    assert sc['method'] == 'manual' and 'Google Drive' in sc['reason'] and sc['url'] == up


def test_geoboundaries_is_checked_on_its_metadata_api_for_the_same_admin_level():
    up = ('https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/IND/ADM2/'
          'geoBoundaries-IND-ADM2.geojson')
    lyr = layer('gb_adm2', 'geoBoundaries', parquet=None, geojson={'url': f'{R2}/gb.geojson', 'upstream_url': up})
    assert ps.infer(lyr, None) == {'method': 'http',
                                   'url': 'https://www.geoboundaries.org/api/current/gbOpen/IND/ADM2/'}


def test_a_community_submission_is_manual():
    sc = ps.infer(layer('c_abc', 'Community', provenance='community'), None)
    assert sc['method'] == 'manual' and 'community' in sc['reason'].lower()


def test_data_gov_in_layers_use_the_keyless_resource_metadata():
    sc = ps.infer(layer('mgnrega_districts', 'MoRD'), {'source_url': 'https://www.data.gov.in/'})
    assert sc['method'] == 'ckan'
    assert sc['url'].startswith('https://www.data.gov.in/backend/dmspublic/v1/resources?')
    assert 'ee03643a-ee4c-48c2-ac30-9f2ff26ab722' in sc['url']


def test_layers_bharatlas_derives_from_another_layer_are_manual_and_name_it():
    sc = ps.infer(layer('high_courts', 'LGD'), None)
    assert sc['method'] == 'manual' and 'lgd_states' in sc['reason']


def test_a_portal_home_page_is_manual_and_kept_as_the_link_to_look_at():
    sc = ps.infer(layer('cityfinance_ulbs', 'CityFinance'), {'source_url': 'https://cityfinance.in/'})
    assert sc['method'] == 'manual' and sc['url'] == 'https://cityfinance.in/'
    sc = ps.infer(layer('vedas_x', 'VEDAS'), {'source_url': 'https://vedas.sac.gov.in/energymap/'})
    assert sc['method'] == 'manual' and 'portal' in sc['reason']


def test_a_layer_with_no_link_at_all_is_manual_and_says_so():
    lyr = layer('airports_x', 'data.gov.in', attribution={})
    sc = ps.infer(lyr, None)
    assert sc['method'] == 'manual' and sc['reason']


def test_merge_keeps_a_recorded_fingerprint_while_the_method_and_url_stay_the_same():
    old = {'method': 'http', 'url': 'u', 'fingerprint': 'etag=1', 'checked_at': 'a', 'changed_at': 'b'}
    assert ps.merge(old, {'method': 'http', 'url': 'u'}) == old
    fresh = ps.merge(old, {'method': 'http', 'url': 'v'})
    assert fresh == {'method': 'http', 'url': 'v', 'fingerprint': None, 'checked_at': None, 'changed_at': None}


def test_merge_of_a_manual_check_records_its_reason():
    sc = ps.merge(None, {'method': 'manual', 'url': 'x', 'reason': 'why'})
    assert sc == {'method': 'manual', 'url': 'x', 'reason': 'why', 'fingerprint': None, 'checked_at': None,
                  'changed_at': None}


def test_populate_adds_source_check_last_touches_nothing_else_and_is_idempotent():
    cat = {'layers': [layer(upstream=f'{YASH}/admin/districts/LGD_Districts.parquet'),
                      layer('c_x', 'Community', provenance='community')]}
    before = copy.deepcopy(cat)
    once = ps.populate(cat, [])
    assert [list(lyr)[-1] for lyr in once['layers']] == ['source_check', 'source_check']
    for a, b in zip(before['layers'], once['layers']):
        assert {k: v for k, v in b.items() if k != 'source_check'} == a
    twice = ps.populate(copy.deepcopy(once), [])
    assert json.dumps(twice) == json.dumps(once)


def test_counts_group_manual_layers_by_reason():
    cat = {'layers': [{'id': 'a', 'source_check': {'method': 'manual', 'reason': 'r1'}},
                      {'id': 'b', 'source_check': {'method': 'manual', 'reason': 'r1'}},
                      {'id': 'c', 'source_check': {'method': 'http'}}]}
    methods, reasons = ps.counts(cat)
    assert methods == {'manual': 2, 'http': 1}
    assert reasons == {'r1': ['a', 'b']}
