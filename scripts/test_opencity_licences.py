"""OpenCity layers carry the licence OpenCity states for each dataset.

OpenCity (data.opencity.in) is CKAN; each dataset's package_show gives a
license_id. Read on 2026-11-15 (behind a Cloudflare challenge, so the
verified values are a fixture here, not a network call). Policy
(/about#sources-and-licensing): a stated open licence is carried as is; where
none is stated the layer keeps the republisher's label and its card says so.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_opencity_licences.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import licence_watch  # noqa: E402

# layer id -> (OpenCity dataset slug, CKAN license_id; None = field empty)
CKAN = {
    'wards_bengaluru_gba': ('gba-wards-delimitation-2025', 'other-pd'),
    'corporation_bengaluru': ('greater-bengaluru-authority-corporations-delimitation-2025', 'other-pd'),
    'wards_bengaluru_bbmp_2022': ('bbmp-ward-information', None),
    'bda_jurisdiction': ('bda-jurisdiction-and-boundary', 'other-pd'),
    'bda_layouts': ('bda-layouts', 'other-pd'),
    'wards_chennai': ('gcc-ward-information', 'notspecified'),
    'wards_hyderabad': ('hyderabad-wards-info', 'other-pd'),
    'wards_hyderabad_osm': ('hyderabad-wards-info', 'other-pd'),
    'wards_mumbai': ('mumbai-wards-map', 'other-pd'),
    'electoral_wards_mumbai_2017': ('mumbai-wards-map', 'other-pd'),
    'wards_kolkata': ('kolkata-wards-information', 'other-pd'),
    'wards_pune': ('pune-wards-info', 'other-pd'),
    'wards_ahmedabad': ('amdavad-municipal-corporation-wards-map-2024', 'other-pd'),
    'wards_jaipur': ('jaipur-municipal-corporation-wards-map', 'other-pd'),
    'wards_gurugram': ('gurugram-wards-map', 'other-pd'),
    'wards_kochi': ('kochi-wards-map', 'other-pd'),
    'wards_bhubaneshwar': ('bhubaneswar-administrative-boundaries', 'cc-by-sa'),
    'wards_kalyan_dombivli': ('kalyan-dombivli-wards-map', 'other-pd'),
    'zones_bengaluru_gba': ('greater-bengaluru-authority-corporations-delimitation-2025', 'other-pd'),
    'wards_pune_2025': ('pune-wards-info', 'other-pd'),
    'zones_pune': ('pune-wards-info', 'other-pd'),
    'wards_vizag': ('visakhapatnam-wards-map-2024', 'other-pd'),
    'wards_thane': ('thane-wards-map', 'other-pd'),
    'wards_indore': ('indore-wards-map', 'other-pd'),
    'wards_madurai': ('madurai-wards-map', 'other-pd'),
    'wards_navi_mumbai': ('navi-mumbai-wards-map', 'other-pd'),
    'wards_guwahati': ('guwahati-wards-information', 'other-pd'),
    'wards_mysuru': ('mysuru-city-corporation-wards-info', None),
    'wards_bhopal': ('bhopal-wards-map', 'other-pd'),
}

# CKAN license_id -> catalog label. other-pd ("Other (Public Domain)") maps to
# CC0-1.0, the catalog's existing public-domain label; cc-by-sa carries no
# version, the allow-list's only CC BY-SA is 4.0. No stated licence keeps the
# republisher label (ODbL-1.0) and the description says so.
LABEL = {'other-pd': 'CC0-1.0', 'cc-by-sa': 'CC-BY-SA-4.0', 'notspecified': 'ODbL-1.0', None: 'ODbL-1.0'}
UNSTATED = {'notspecified', None}
# Historical layers kept on their published files and never rebuilt by ingest_external.
NOT_REBUILT = {'wards_hyderabad_osm'}


def _expected(layer_id: str) -> str:
    # the publisher's reviewed terms (licence-terms.json) override OpenCity's label: OSM-derived wards are ODbL
    return licence_watch.licence_of(layer_id, default=LABEL[CKAN[layer_id][1]])


def _opencity_url(slug: str) -> str:
    return f'https://data.opencity.in/dataset/{slug}'


@pytest.fixture(scope='module')
def catalog() -> dict:
    return json.loads((ROOT / 'catalog.json').read_text())


@pytest.fixture(scope='module')
def manifest() -> dict:
    rows = json.loads((HERE / 'external-ingested.json').read_text())
    return {r['id']: r for r in rows}


def test_every_opencity_dataset_layer_is_in_the_fixture(manifest):
    opencity = {i for i, r in manifest.items() if 'data.opencity.in' in (r.get('source_url') or '')}
    assert opencity == set(CKAN)


@pytest.mark.parametrize('layer_id', sorted(CKAN))
def test_catalog_licence_matches_ckan(catalog, layer_id):
    layer = next(x for x in catalog['layers'] if x['id'] == layer_id)
    assert layer['licence'] == _expected(layer_id)


@pytest.mark.parametrize('layer_id', sorted(CKAN))
def test_manifest_licence_and_slug_match_ckan(manifest, layer_id):
    row = manifest[layer_id]
    assert row['license'] == _expected(layer_id)
    assert row['source_url'] == _opencity_url(CKAN[layer_id][0])


@pytest.mark.parametrize('layer_id', sorted(i for i in CKAN if CKAN[i][1] in UNSTATED))
def test_unstated_licence_is_explained(catalog, manifest, layer_id):
    layer = next(x for x in catalog['layers'] if x['id'] == layer_id)
    for text in (layer['notes'], manifest[layer_id]['description'], catalog['level_meta'][layer_id]['description']):
        assert 'OpenCity states no licence' in text


def test_ingest_config_matches_ckan(manifest):
    ie = pytest.importorskip('ingest_external')
    by_id = {d.id: d for d in ie.DATASETS}
    for layer_id, (slug, _) in CKAN.items():
        if layer_id in NOT_REBUILT:
            continue
        d = by_id[layer_id]
        assert d.license == _expected(layer_id), layer_id
        assert d.source_url == _opencity_url(slug), layer_id
        assert d.description == manifest[layer_id]['description'], layer_id


# Five layers were labelled OpenCity but are DataMeet's Municipal_Spatial_Data
# files (feature counts match: 290, 100, 28, 112, 58). Folder readmes give
# CC BY-SA 2.5 India for Delhi, Coimbatore and Chandigarh; Lucknow and Kanpur
# state none, so the repository default CC BY 4.0 applies.
DATAMEET = {
    'wards_delhi': ('Delhi', 'CC-BY-SA-2.5-IN'),
    'wards_coimbatore': ('Coimbatore', 'CC-BY-SA-2.5-IN'),
    'wards_chandigarh': ('Chandigarh', 'CC-BY-SA-2.5-IN'),
    'wards_lucknow': ('Lucknow', 'CC-BY-4.0'),
    'wards_kanpur': ('Kanpur', 'CC-BY-4.0'),
    'zones_chennai': ('Chennai', 'CC-BY-SA-2.5-IN'),
}


@pytest.mark.parametrize('layer_id', sorted(DATAMEET))
def test_datameet_layers_credit_datameet_with_the_folder_licence(catalog, manifest, layer_id):
    folder, lic = DATAMEET[layer_id]
    layer = next(l for l in catalog['layers'] if l['id'] == layer_id)
    assert layer['source'] == 'DataMeet' and layer['licence'] == lic
    assert layer['attribution']['primary']['url'].endswith(f'/Municipal_Spatial_Data/tree/master/{folder}')
    entry = manifest[layer_id]
    assert entry['license'] == lic and entry.get('attr_key', entry.get('source')) == 'DataMeet'
