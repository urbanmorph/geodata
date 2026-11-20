"""core_mws_water_balance + core_mws_drought: CoRE Stack's own per-micro-watershed layers (annual water
balance with the change in depth to water; drought frequency), published per tehsil on CoRE's GeoServer and
named by its tehsil-wise STAC catalogue (CC-BY-4.0). Every tehsil's file as published, one row per feature,
with the state/district/tehsil its STAC path names; the catalog entry.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_core_mws.py -q
"""
from __future__ import annotations

import gzip
import hashlib
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_core_mws as m  # noqa: E402
import pipeline  # noqa: E402

WB, DR = m.LAYERS['core_mws_water_balance'], m.LAYERS['core_mws_drought']
TW = 'CorestackCatalogs_merged_collection/tehsil_wise'


def item_key(state, district, tehsil, kind):
    name = f'{state}_{district}_{tehsil}_{kind}'
    return f'{TW}/{state}/{district}/{tehsil}/{name}/{name}.json'


# ── the index: which tehsils publish each layer, read off the bucket listing ──

def test_the_listing_is_read_page_by_page():
    page = ('<ListBucketResult><Contents><Key>a/b.json</Key></Contents><Contents><Key>a/c.png</Key></Contents>'
            '<IsTruncated>true</IsTruncated><NextContinuationToken>tok/en=</NextContinuationToken></ListBucketResult>')
    assert m.parse_listing(page) == (['a/b.json', 'a/c.png'], 'tok/en=')
    last = '<ListBucketResult><Contents><Key>z</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>'
    assert m.parse_listing(last) == (['z'], None)


def test_the_index_keeps_each_layers_items_by_state_district_tehsil():
    keys = [item_key('jharkhand', 'dumka', 'masalia', WB.kind),
            item_key('jharkhand', 'dumka', 'masalia', DR.kind),
            item_key('jharkhand', 'dumka', 'masalia', 'water_balance_fortnightly_vector'),
            item_key('goa', 'north_goa', 'bardez', 'terrain_vector'),
            item_key('odisha', 'puri', 'puri', WB.kind),
            f'{TW}/jharkhand/collection.json']
    assert m.index_items(keys, WB.kind) == [
        {'state': 'jharkhand', 'district': 'dumka', 'tehsil': 'masalia', 'key': keys[0]},
        {'state': 'odisha', 'district': 'puri', 'tehsil': 'puri', 'key': keys[4]}]
    assert [x['tehsil'] for x in m.index_items(keys, DR.kind)] == ['masalia']


def test_states_licence_must_be_cc_by_from_core_stack():
    ok = {'license': 'CC-BY-4.0', 'providers': [{'name': 'CoRE Stack', 'roles': ['licensor']}]}
    m.check_licence('goa', ok)
    with pytest.raises(ValueError, match='goa'):
        m.check_licence('goa', {**ok, 'license': 'proprietary'})
    with pytest.raises(ValueError, match='CoRE Stack'):
        m.check_licence('goa', {**ok, 'providers': [{'name': 'Someone else'}]})


# ── pull: each tehsil's file once, kept gzipped with its sha256 ──

def fc(*features, crs=True) -> bytes:
    body = {'type': 'FeatureCollection', 'features': list(features), 'totalFeatures': len(features)}
    if crs:
        body['crs'] = {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::4326'}}
    return json.dumps(body).encode()


def poly(x=87.0, y=24.0, **props):
    ring = [[x, y], [x + 0.01, y], [x + 0.01, y + 0.01], [x, y + 0.01], [x, y]]
    return {'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [ring]}, 'properties': props}


HREF = ('https://geoserver.core-stack.org:8443/geoserver/mws_layers/ows?service=WFS&version=1.0.0&request=GetFeature'
        '&typeName=mws_layers:deltaG_well_depth_dumka_masalia&outputFormat=application/json')
ROW = {'state': 'jharkhand', 'district': 'dumka', 'tehsil': 'masalia', 'key': item_key('jharkhand', 'dumka', 'masalia', WB.kind)}


def test_a_tehsil_is_fetched_once_and_kept_with_its_sha256(tmp_path):
    body = fc(poly(uid='12_1'))
    calls = []

    def get(url):
        calls.append(url)
        return json.dumps({'assets': {'data': {'href': HREF}}}).encode() if url.endswith('.json') else body
    first = m.pull_one(tmp_path, ROW, get)
    assert calls == [m.S3 + ROW['key'], HREF]
    assert first == {**{k: ROW[k] for k in ('state', 'district', 'tehsil')}, 'href': HREF,
                     'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body), 'features': 1}
    assert gzip.decompress(m.file_of(tmp_path, ROW).read_bytes()) == body
    assert m.pull_one(tmp_path, ROW, get) == first and len(calls) == 2      # second run: nothing fetched


def test_a_geoserver_error_answer_is_recorded_as_unavailable_not_kept_as_data(tmp_path):
    def get(url):
        if url.endswith('.json'):
            return json.dumps({'assets': {'data': {'href': HREF}}}).encode()
        return b'<?xml version="1.0" ?><ServiceExceptionReport><ServiceException>Feature type unknown'
    got = m.pull_one(tmp_path, ROW, get)
    assert got['unavailable'].startswith('<?xml') and 'sha256' not in got
    assert not m.file_of(tmp_path, ROW).exists()


def test_an_item_whose_data_is_not_on_core_geoserver_stops_the_pull(tmp_path):
    def get(url):
        return json.dumps({'assets': {'data': {'href': 'https://elsewhere.example/x.json'}}}).encode()
    with pytest.raises(ValueError, match='elsewhere'):
        m.pull_one(tmp_path, ROW, get)


def test_the_whole_pull_lists_checks_the_licence_fetches_and_is_idempotent(tmp_path):
    raw = tmp_path / 'fresh' / 'core_mws'          # does not exist yet
    keys = [ROW['key'], item_key('jharkhand', 'dumka', 'jama', WB.kind)]
    listing = ''.join(f'<Contents><Key>{k}</Key></Contents>' for k in keys) + '<IsTruncated>false</IsTruncated>'
    calls = []

    def get(url):
        calls.append(url)
        if '?list-type=2' in url:
            return listing.encode()
        if url.endswith('collection.json'):
            return json.dumps({'license': 'CC-BY-4.0', 'providers': [{'name': 'CoRE Stack'}]}).encode()
        if url.endswith('.json'):
            return json.dumps({'assets': {'data': {'href': HREF + '&n=' + url.split('/')[-1][:30]}}}).encode()
        return fc(poly(uid='12_1'))
    first = m.pull(WB, raw, get, now='2026-11-21T10:00:00+00:00')
    assert first['tehsils'] == 2 and first['unavailable'] == 0 and first['features'] == 2
    n = len(calls)
    assert m.pull(WB, raw, get, now='2026-11-22T10:00:00+00:00') == first and len(calls) == n


# ── bake: every feature, every column as published, plus where it came from ──

def write_tehsil(raw, row, body):
    p = m.file_of(raw, row)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(gzip.compress(body, mtime=0))


def test_the_table_stacks_tehsils_keeps_published_columns_and_casts_only_number_columns(tmp_path):
    a = {**ROW}
    b = {'state': 'odisha', 'district': 'puri', 'tehsil': 'puri', 'key': item_key('odisha', 'puri', 'puri', WB.kind)}
    year = '{"Precipitation":1200.5,"ET":945.2,"DeltaG":112.0}'
    write_tehsil(tmp_path, a, fc(poly(uid='12_1', area_in_ha=1606.8, id=818523, **{'2017_2018': year},
                                      Net2017_22='NA')))
    write_tehsil(tmp_path, b, fc(poly(85.8, 19.8, uid='12_2', area_in_ha=10, id=2, **{'2017_2018': year},
                                      Net2017_22=-1.5, extra='x')))
    out = tmp_path / 't.parquet'
    assert m.build_table(pipeline.make_con(), tmp_path, [a, b], out) == 2
    con = pipeline.make_con()
    cols = {r[0]: r[1] for r in con.execute(f"DESCRIBE SELECT * FROM '{out}'").fetchall()}
    assert list(cols) == ['stac_state', 'stac_district', 'stac_tehsil', 'uid', 'area_in_ha', 'id', '2017_2018', 'Net2017_22',
                          'extra', 'geometry']
    assert (cols['area_in_ha'], cols['id'], cols['Net2017_22'], cols['2017_2018']) == \
        ('DOUBLE', 'BIGINT', 'DOUBLE', 'VARCHAR')
    rows = con.execute(f"""SELECT stac_tehsil, uid, "2017_2018", Net2017_22, extra, round(ST_X(ST_Centroid(geometry)), 3)
                           FROM '{out}' ORDER BY uid""").fetchall()
    assert rows == [('masalia', '12_1', year, None, None, 87.005), ('puri', '12_2', year, -1.5, 'x', 85.805)]


def test_a_files_own_state_column_stays_beside_the_stac_place_columns(tmp_path):
    write_tehsil(tmp_path, ROW, fc(poly(uid='1', STATE='JHARKHAND', TEHSIL='Masalia')))
    out = tmp_path / 't.parquet'
    m.build_table(pipeline.make_con(), tmp_path, [ROW], out)
    assert pipeline.make_con().execute(f"SELECT stac_state, STATE, TEHSIL FROM '{out}'").fetchall() == \
        [('jharkhand', 'JHARKHAND', 'Masalia')]


def test_a_published_column_named_like_the_stac_place_columns_is_refused(tmp_path):
    write_tehsil(tmp_path, ROW, fc(poly(uid='1', STAC_State='X')))
    with pytest.raises(ValueError, match='STAC_State'):
        m.build_table(pipeline.make_con(), tmp_path, [ROW], tmp_path / 't.parquet')


def test_a_file_in_another_crs_is_refused(tmp_path):
    body = json.loads(fc(poly(uid='1')))
    body['crs']['properties']['name'] = 'urn:ogc:def:crs:EPSG::32644'
    write_tehsil(tmp_path, ROW, json.dumps(body).encode())
    with pytest.raises(ValueError, match='32644'):
        m.build_table(pipeline.make_con(), tmp_path, [ROW], tmp_path / 't.parquet')


def test_tile_fields_are_few_and_flat():
    for spec in m.LAYERS.values():
        assert {'stac_tehsil', 'uid'} <= set(spec.tile_fields) and len(spec.tile_fields) <= 12


def test_tiles_use_the_house_polygon_settings_with_only_the_tile_fields():
    # coalesce, not drop: with dropping the water balance kept 23% of its polygons at z5 (holes)
    args = m.tile_args(WB, Path('in.geojson'), Path('out.pmtiles'))
    assert '--coalesce-densest-as-needed' in args and '--drop-densest-as-needed' not in args
    assert '--detect-shared-borders' in args and '-P' not in args
    assert [args[i + 1] for i, a in enumerate(args) if a == '-y'] == list(WB.tile_fields)
    assert args[-1] == 'in.geojson'


def test_formats_follow_the_whole_layer_cap_and_the_dbf_limits():
    cap = pipeline.WHOLE_LAYER_MAX_MB * 1024 * 1024
    assert m.published_formats(cap, shapefile_ok=True) == list(m.EXT)
    assert m.published_formats(cap + 1, shapefile_ok=True) == ['parquet', 'pmtiles', 'shapefile']
    assert m.published_formats(cap + 1, shapefile_ok=False) == ['parquet', 'pmtiles']


# ── register ─────────────────────────────────────────────────────────────────

PULL = {'sha256': 'f' * 64, 'pulled_at': '2026-11-21T10:00:00+00:00', 'tehsils': 714, 'unavailable': 0}


def summary(spec):
    return {'rows': 50000, 'states': {'jharkhand': 1000}, 'sizes': {f: 100 for f in m.EXT},
            'names': {f: f'{spec.basename}.0123abcd.{e}' for f, e in m.EXT.items()}, 'pull': PULL}


@pytest.mark.parametrize('spec', [WB, DR], ids=lambda s: s.id)
def test_the_entry_is_cc_by_credited_to_core_stack(spec):
    e = m.catalog_entry(spec, summary(spec), {}, 'https://r2')
    assert e['id'] == spec.id and e['rows'] == 50000 and e['licence'] == 'CC-BY-4.0'
    assert e['attribution']['primary'] == {'name': 'CoRE Stack', 'url': 'https://core-stack.org/'}
    assert e['parquet'] == {'url': f'https://r2/{spec.r2_prefix}/{spec.basename}.0123abcd.parquet', 'bytes': 100}
    assert e['category'] == spec.category and e['fetched_at'] == PULL['pulled_at']
    assert e['source_check']['fingerprint'] == f'sha256={"f" * 64}'
    for text in (e['notes'], spec.description):
        assert '—' not in text and 'catalog' not in text.lower() and 'micro-watershed' in text


def test_registering_twice_changes_nothing_and_keeps_the_reviewed_labels(tmp_path):
    cat, man = tmp_path / 'catalog.json', tmp_path / 'manifest.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': [], 'attribution': {}}))
    man.write_text('[]')
    sums = {}
    for spec in (WB, DR):
        sums[spec.id] = tmp_path / f'{spec.id}.summary.json'
        sums[spec.id].write_text(json.dumps(summary(spec)))

    def both():
        for spec in (WB, DR):
            m.register(spec, cat, man, sums[spec.id], 'https://r2')
    both()
    once = cat.read_text(), man.read_text()
    both()
    assert (cat.read_text(), man.read_text()) == once
    c = json.loads(once[0])
    assert [x['id'] for x in c['layers']] == [WB.id, DR.id] and c['level_order'] == [WB.id, DR.id]
    import licence_watch
    assert all(licence_watch.labelled(x) == x for x in c['layers'])


def test_populate_scripts_agree_with_the_bake():
    import populate_refresh
    import populate_source_check
    for spec in (WB, DR):
        e = m.catalog_entry(spec, summary(spec), {}, 'https://r2')
        assert populate_refresh.infer(e)[0]['class'] == e['refresh']['class']
        assert populate_source_check.merge(e['source_check'], populate_source_check.infer(e, None)) == e['source_check']
