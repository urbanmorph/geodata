"""Tests for scripts/populate_refresh.py (no network).

Every layer gets a `refresh` block: its class (frozen, slow, regular, fast), how often its upstream is checked,
when it is rebuilt and released, what each build is audited against, and when the next rebuild is due.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_populate_refresh.py -q
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import populate_refresh as pr  # noqa: E402


def layer(lid='lgd_districts', category='boundaries', level=None, provenance='curated',
          fetched_at='2026-05-19T07:56:49+00:00', **kw):
    return {'id': lid, 'category': category, 'level': level or lid, 'provenance': provenance,
            'fetched_at': fetched_at, **kw}


def cls(lyr) -> str:
    return pr.infer(lyr)[0]['class']


def test_admin_boundaries_are_slow():
    assert cls(layer('lgd_districts', 'boundaries', 'district')) == 'slow'
    assert cls(layer('soi_states', 'boundaries', 'state')) == 'slow'


def test_wards_and_pincodes_are_regular():
    assert cls(layer('wards_chennai', 'city-wards')) == 'regular'
    assert cls(layer('datagov_pincodes', 'infrastructure', 'pincode')) == 'regular'


def test_places_stations_transport_roads_pois_health_and_schools_are_fast():
    assert cls(layer('overture_places_india', 'infrastructure')) == 'fast'
    assert cls(layer('ir_stations', 'transport')) == 'fast'
    assert cls(layer('pmgsy_roads', 'transport')) == 'fast'
    assert cls(layer('jjm_facilities', 'infrastructure')) == 'fast'
    assert cls(layer('nhp_hospitals', 'health-edu')) == 'fast'
    assert cls(layer('udise_schools', 'health-edu')) == 'fast'
    # owner, 2026-11-18: state police portals rarely change; rebuild when the source does
    assert cls(layer('police_stations_tn', 'people')) == 'regular'


def test_one_off_censuses_historical_vintages_state_finance_and_mi6_are_frozen():
    for lid in ('state_finance', 'mi6_wells_districts', 'wbc1_water_bodies', 'wards_bengaluru_bbmp_2022',
                'electoral_wards_mumbai_2017', 'high_courts'):
        assert cls(layer(lid, 'economy')) == 'frozen', lid


def test_a_community_submission_is_frozen_until_its_contributor_sends_a_new_version():
    assert cls(layer('c_abc', 'environment', provenance='community')) == 'frozen'


def test_every_inference_names_its_reason():
    for lyr in (layer(), layer('wards_pune', 'city-wards'), layer('state_finance', 'economy'),
                layer('x', 'nothing-known')):
        _, reason = pr.infer(lyr)
        assert reason and isinstance(reason, str)


def test_each_class_sets_its_cadence_from_the_spec():
    assert pr.CLASSES['frozen'] == {'check': 'never', 'rebuild': 'never', 'release': 'once'}
    assert pr.CLASSES['slow'] == {'check': 'weekly', 'rebuild': 'on_change', 'release': 'on_rebuild'}
    assert pr.CLASSES['regular'] == {'check': 'weekly', 'rebuild': 'monthly_if_changed', 'release': 'on_rebuild'}
    assert pr.CLASSES['fast'] == {'check': 'weekly', 'rebuild': 'monthly', 'release': 'monthly'}


def test_the_audit_names_the_class_tolerance():
    assert '2%' in pr.infer(layer())[0]['audit']
    assert '25%' in pr.infer(layer('ir_stations', 'transport'))[0]['audit']


def test_a_layer_override_sets_its_own_tolerance_with_a_reason(monkeypatch):
    monkeypatch.setitem(pr.OVERRIDES, 'wards_pune', {'tolerance': 0.3, 'tolerance_reason': 'Pune redraws its wards'})
    block, _ = pr.infer(layer('wards_pune', 'city-wards'))
    assert block['class'] == 'regular'
    assert (block['tolerance'], block['tolerance_reason']) == (0.3, 'Pune redraws its wards')
    assert '30%' in block['audit']


def test_a_layer_override_names_what_its_class_audit_checks(monkeypatch):
    monkeypatch.setitem(pr.OVERRIDES, 'urban_rail_stations', {'audit': 'stations per city within 2 of Wikipedia'})
    block, _ = pr.infer(layer('urban_rail_stations', 'transport'))
    assert block['class'] == 'fast'
    assert block['audit'].endswith('; the class audit: stations per city within 2 of Wikipedia')
    assert 'counts against the reference' not in block['audit']


def test_populate_keeps_the_last_audit_result_and_adds_none_where_there_is_none():
    cat = {'layers': [layer('ir_stations', 'transport', fetched_at='2026-11-17T00:00:00+00:00'), layer()]}
    result = {'Delhi Metro': {'rows': 243, 'reference': 243}}
    cat['layers'][0]['refresh'] = {'class': 'fast', 'audited_at': '2026-11-18', 'audit_result': result}
    pr.populate(cat, None)
    assert cat['layers'][0]['refresh']['audit_result'] == result
    assert list(cat['layers'][0]['refresh'])[-1] == 'audit_result'
    assert 'audit_result' not in cat['layers'][1]['refresh']


def test_a_tolerance_without_a_reason_is_refused(monkeypatch):
    monkeypatch.setitem(pr.OVERRIDES, 'wards_pune', {'tolerance': 0.3})
    try:
        pr.infer(layer('wards_pune', 'city-wards'))
    except ValueError as e:
        assert 'tolerance_reason' in str(e)
    else:
        raise AssertionError('expected a refusal')


def test_next_due_is_a_month_after_the_last_build_for_monthly_rebuilds_and_none_otherwise():
    assert pr.next_due('monthly', '2026-05-19T07:56:49+00:00') == '2026-06-19'
    assert pr.next_due('monthly_if_changed', '2026-01-31') == '2026-02-28'
    assert pr.next_due('monthly', '2026-12-15') == '2027-01-15'
    assert pr.next_due('on_change', '2026-05-19') is None
    assert pr.next_due('never', '2026-05-19') is None
    assert pr.next_due('monthly', None) is None


def test_the_last_build_is_the_newer_of_fetched_at_and_the_layers_newest_release():
    releases = {'releases': [{'dataset': 'lgd_states', 'released': '2026-12-02'},
                             {'dataset': 'lgd_states', 'released': '2026-11-03'},
                             {'dataset': 'cw', 'released': '2027-01-01'}]}
    assert pr.last_build(layer('lgd_states', fetched_at='2026-05-19T07:56:35+00:00'), releases) == '2026-12-02'
    assert pr.last_build(layer('lgd_states', fetched_at='2027-02-01T00:00:00+00:00'), releases) == '2027-02-01'
    assert pr.last_build(layer('soi_states', fetched_at='2026-05-19T07:56:35+00:00'), releases) == '2026-05-19'
    assert pr.last_build(layer('x', fetched_at=None), None) is None


# ── how strong a layer's source check is ────────────────────────────────────

def checked(method, url, lid='x'):
    return layer(lid, source_check={'method': method, 'url': url})


def test_release_assets_commits_and_dataset_records_are_strong_checks():
    yash = 'https://github.com/yashveeeeeeer/india-geodata/releases/download/infra/national-highways/GS.parquet'
    assert pr.weak_check(checked('github_release', yash)) is None
    assert pr.weak_check(checked('github_release', 'https://github.com/owner/repo')) is None
    assert pr.weak_check(checked('github_commit', 'https://github.com/datameet/Municipal_Spatial_Data/tree/master/'
                                                  'Delhi')) is None
    assert pr.weak_check(checked('ckan', 'https://www.data.gov.in/backend/dmspublic/v1/resources?x=1')) is None


def test_an_http_check_is_strong_on_a_data_file_or_an_api_record_and_weak_on_a_page():
    assert pr.weak_check(checked('http', 'https://stac.overturemaps.org/catalog.json')) is None
    assert pr.weak_check(checked('http', 'https://example.org/data/wards.geojson')) is None
    assert pr.weak_check(checked('http', 'https://www.geoboundaries.org/api/current/gbOpen/IND/ADM1/')) is None
    assert 'page' in pr.weak_check(checked('http', 'https://example.gov.in/dataset/wards'))
    assert 'page' in pr.weak_check(checked('http', 'https://example.gov.in/maps.html'))


def test_osm_extracts_gtfs_feeds_and_hand_checks_are_weak():
    assert 'OpenStreetMap' in pr.weak_check(checked('http', 'https://download.geofabrik.de/asia/india-latest.osm.pbf'))
    assert 'GTFS' in pr.weak_check(checked('github_commit', 'https://github.com/Vonter/bmtc-gtfs/tree/main/gtfs'))
    assert 'GTFS' in pr.weak_check(checked('gtfs', 'https://example.org/feed.zip'))
    assert 'by hand' in pr.weak_check(checked('manual', 'https://data.gov.in/'))
    assert 'by hand' in pr.weak_check(layer('no_check'))


def test_a_layer_override_marks_its_check_weak_with_a_reason(monkeypatch):
    monkeypatch.setitem(pr.WEAK_CHECKS, 'x', 'the check follows one of several sources')
    assert pr.weak_check(checked('github_release', 'https://github.com/owner/repo')) == \
        'the check follows one of several sources'


def test_the_last_refresh_is_the_later_of_the_build_and_a_strong_check_confirming_the_source_identical():
    strong = checked('github_release', 'https://github.com/owner/repo', lid='vedas_wind_farms')
    strong['fetched_at'] = '2026-05-28T14:34:08+00:00'
    assert pr.last_refresh(strong, None, '2026-11-19') == '2026-11-19'
    assert pr.last_refresh(strong, None, '2026-05-01') == '2026-05-28'      # a check before the build
    assert pr.last_refresh(strong, None, None) == '2026-05-28'
    weak = checked('http', 'https://download.geofabrik.de/asia/india-latest.osm.pbf')
    weak['fetched_at'] = '2026-11-17'
    assert pr.last_refresh(weak, None, '2026-11-19') == '2026-11-17'       # a weak check never counts
    assert pr.last_refresh(checked('github_release', 'https://github.com/o/r') | {'fetched_at': None}, None,
                           '2026-11-19') == '2026-11-19'


def test_populate_writes_the_block_at_the_end_of_every_layer_and_keeps_audited_at():
    cat = {'layers': [layer('ir_stations', 'transport', fetched_at='2026-11-17T00:00:00+00:00'),
                      layer('state_finance', 'economy')]}
    cat['layers'][0]['refresh'] = {'class': 'slow', 'audited_at': '2026-11-20', 'next_due': None}
    cat['layers'][0]['notes'] = 'n'
    pr.populate(cat, None)
    a, b = cat['layers']
    assert list(a)[-1] == 'refresh'
    assert a['refresh'] == {'class': 'fast', 'check': 'weekly', 'rebuild': 'monthly', 'release': 'monthly',
                            'audit': a['refresh']['audit'], 'audited_at': '2026-11-20', 'next_due': '2026-12-17'}
    assert b['refresh']['class'] == 'frozen' and b['refresh']['next_due'] is None
    assert b['refresh']['audited_at'] is None


def test_populate_is_idempotent():
    cat = {'layers': [layer(), layer('wards_pune', 'city-wards'), layer('udise_schools', 'health-edu')]}
    once = copy.deepcopy(pr.populate(cat, None))
    assert pr.populate(cat, None) == once


def test_counts_group_layers_by_class_and_reason():
    cat = pr.populate({'layers': [layer(), layer('soi_states'), layer('udise_schools', 'health-edu')]}, None)
    classes, reasons = pr.counts(cat)
    assert classes == {'slow': 2, 'fast': 1}
    assert sorted(len(v) for v in reasons.values()) == [1, 2]


def test_every_layer_in_the_real_catalog_gets_a_class_and_the_overrides_name_real_layers():
    root = Path(__file__).resolve().parent.parent
    cat = json.loads((root / 'catalog.json').read_text())
    ids = {lyr['id'] for lyr in cat['layers']}
    for lyr in cat['layers']:
        assert pr.infer(lyr)[0]['class'] in pr.CLASSES
    unknown = set(pr.OVERRIDES) - ids
    assert not unknown, f'overrides for layers not in catalog.json: {unknown}'


def test_main_dry_run_writes_nothing(tmp_path):
    p = tmp_path / 'catalog.json'
    text = json.dumps({'layers': [layer()]}, indent=2) + '\n'
    p.write_text(text)
    assert pr.main(['--catalog', str(p), '--dry-run', '--releases', str(tmp_path / 'none.json')]) == 0
    assert p.read_text() == text
    assert pr.main(['--catalog', str(p), '--releases', str(tmp_path / 'none.json')]) == 0
    first = p.read_text()
    assert json.loads(first)['layers'][0]['refresh']['class'] == 'slow'
    assert pr.main(['--catalog', str(p), '--releases', str(tmp_path / 'none.json')]) == 0
    assert p.read_text() == first


def test_a_bake_s_refresh_block_keeps_the_audit_date_and_dates_the_next_rebuild_from_this_build():
    lyr = layer(lid='atal_bhujal_wells', category='water')
    block, _ = pr.infer(lyr)
    got = pr.refresh_block(lyr, {'refresh': {'audited_at': '2026-03-03'}}, '2026-11-22T00:00:00+00:00')
    assert got == {**block, 'audited_at': '2026-03-03', 'next_due': pr.next_due(block['rebuild'], '2026-11-22')}
    assert pr.refresh_block(lyr, {}, '2026-11-22')['audited_at'] is None   # a new layer
