"""Tests for scripts/bake_ir_stations_merged.py.

Pure helpers and the merge itself; pull and bake need the network and the
cached sources under data/raw/ir_stations_merged/.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_ir_stations_merged.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_ir_stations_merged as b  # noqa: E402

GS, IR = b.GS, b.IRGIS
M_PER_DEG = 111_195  # metres per degree of latitude (haversine, mean radius)


def pt(src, row, code, x, y, name=None, detail=None):
    return b.Pt(src, row, code, x, y, name, detail)


def wd(row, code, x, y, label=None, item=None):
    return b.WD(row, code, x, y, label, item or f'http://www.wikidata.org/entity/Q{row + 1}')


def north(y, metres):
    return y + metres / M_PER_DEG


# ── helpers ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize('raw, code', [(' ndls ', 'NDLS'), ('', None), ('   ', None), (None, None)])
def test_norm_code_upper_trims_and_blanks_are_none(raw, code):
    assert b.norm_code(raw) == code


def test_haversine_one_degree_of_latitude():
    assert b.haversine_m(77, 28, 77, 29) == pytest.approx(M_PER_DEG, rel=1e-3)


def test_representative_is_the_medoid_and_reports_spread():
    pts = [pt(GS, 0, 'A', 77, 28), pt(GS, 1, 'A', 77, north(28, 100)), pt(GS, 2, 'A', 77, north(28, 300))]
    rep, spread = b.representative(pts)
    assert rep.row == 1
    assert spread == pytest.approx(200, abs=2)


def test_representative_of_a_scattered_code_follows_the_independent_anchor():
    # One code at two places 50 km apart (a data error): Wikidata's point decides.
    pts = [pt(GS, 0, 'A', 77, 28), pt(GS, 1, 'A', 77, 28.45)]
    rep, spread = b.representative(pts, anchor=(77, 28.449))
    assert rep.row == 1
    assert spread > 40_000


@pytest.mark.parametrize('code, label, texts, ok', [
    ('NYI', 'Nellayi railway station', ['[ Station (Halt) ] NYI  STATION ;'], True),
    ('KIUL', 'Kiul Junction railway station', ['KIUL JN'], True),
    ('ITL', 'Itlamvaripalle railway station', ['Itlamvaripalle Railway Station'], True),
    ('DAVM', 'Dhanuvachapuram railway station', ['PF END ;'], False),
    ('DAVM', None, [None], False),
])
def test_name_corroborates(code, label, texts, ok):
    assert b.name_corroborates(code, label, texts) is ok


# ── merge ────────────────────────────────────────────────────────────────

def by_code(stations):
    return {s['stn_code']: s for s in stations}


def test_platform_points_of_one_code_become_one_station_confirmed_by_wikidata():
    cris = [pt(GS, 0, 'BSR', 72.83, 19.38), pt(GS, 1, 'BSR', 72.83, north(19.38, 150)),
            pt(IR, 0, 'BSR', 72.83, 19.38)]
    out, stats = b.merge(cris, [wd(0, 'BSR', 72.83, north(19.38, 60), 'Vasai Road railway station')])
    s = by_code(out)['BSR']
    assert len(out) == 1
    assert (s['src'], s['code_source'], s['match_method'], s['match_confidence']) == (GS, GS, 'code', 'high')
    assert s['sources'] == 'GatiShakti;IRGIS;Wikidata'
    assert s['source_points'] == 2
    assert s['wd_row'] == 0
    assert s['wd_distance_m'] == pytest.approx(60, abs=80)


def test_code_only_in_the_ir_portal_comes_from_there():
    out, _ = b.merge([pt(IR, 5, 'XYZ', 80, 20)], [])
    s = by_code(out)['XYZ']
    assert (s['src'], s['row'], s['sources'], s['match_confidence'], s['wd_row']) == (IR, 5, 'IRGIS', 'medium', None)


def test_far_wikidata_lowers_confidence():
    out, _ = b.merge([pt(GS, 0, 'FAR', 80, 20)], [wd(0, 'FAR', 80, 20.1)])
    assert by_code(out)['FAR']['match_confidence'] == 'low'


def test_a_scattered_code_without_wikidata_keeps_one_place_and_the_other_goes_uncoded():
    out, _ = b.merge([pt(GS, 0, 'SCAT', 81, 20), pt(GS, 1, 'SCAT', 81, 20.2)], [])
    assert sorted((s['row'], s['stn_code'], s['match_confidence']) for s in out) == \
        [(0, 'SCAT', 'medium'), (1, None, 'low')]


def test_a_scattered_codes_far_points_split_off_as_another_station():
    # CRIS codes a Kalyan platform THK (Thakurli, 2.5 km away): Kalyan must not vanish into Thakurli.
    cris = [pt(GS, 0, 'THK', 73.10, 19.22, 'THAKURLI'), pt(GS, 1, 'THK', 73.10, north(19.22, 2500), 'THAKURLI', 'PF6')]
    w = [wd(0, 'THK', 73.10, north(19.22, 50), 'Thakurli railway station'),
         wd(1, 'KYN', 73.10, north(19.22, 2600), 'Kalyan railway station')]
    out, stats = b.merge(cris, w)
    codes = by_code(out)
    assert (codes['THK']['row'], codes['THK']['source_points']) == (0, 1)
    kyn = codes['KYN']
    assert (kyn['row'], kyn['code_source'], kyn['match_method']) == (1, 'Wikidata', 'distance')
    assert stats['scattered_points_split'] == 1


def test_wikidata_code_differing_from_the_cris_code_attaches_when_names_agree():
    cris = [pt(GS, 0, 'CSTM', 72.835, 18.940, 'CHHATRAPATI SHIVAJI MAHARAJ TERMINUS')]
    out, stats = b.merge(cris, [wd(0, 'CSMT', 72.835, north(18.940, 200), 'Chhatrapati Shivaji Maharaj Terminus')])
    assert len(out) == 1
    s = out[0]
    assert (s['stn_code'], s['code_source'], s['match_method'], s['match_confidence'], s['wd_row']) == \
        ('CSTM', GS, 'name+distance', 'medium', 0)
    assert s['sources'] == 'GatiShakti;Wikidata'
    assert stats['wikidata_codes_placed_on_other_cris_code'] == 1


def test_wikidata_code_near_a_differently_named_coded_station_is_not_attached():
    out, stats = b.merge([pt(GS, 0, 'VVH', 72.89, 19.07, 'VIDYAVIHAR')],
                         [wd(0, 'LTT', 72.89, north(19.07, 300), 'Lokmanya Tilak Terminus')])
    assert out[0]['wd_row'] is None
    assert [u['code'] for u in stats['wikidata_unplaced']] == ['LTT']


def test_uncoded_points_near_a_coded_station_fold_into_it():
    cris = [pt(GS, 0, 'A', 77, 28), pt(GS, 1, None, 77, north(28, 400), detail='PF END')]
    out, stats = b.merge(cris, [])
    assert len(out) == 1 and out[0]['source_points'] == 2
    assert stats['uncoded_points_folded'] == 1


def test_uncoded_cluster_takes_the_wikidata_code_when_the_name_agrees():
    cris = [pt(GS, 0, None, 76.27, 10.39, detail='[ Station (Halt) ] NYI  STATION ;'),
            pt(GS, 1, None, 76.27, north(10.39, 300), detail='PF END')]
    out, stats = b.merge(cris, [wd(0, 'NYI', 76.27, north(10.39, 900), 'Nellayi railway station')])
    s = by_code(out)['NYI']
    assert len(out) == 1
    assert (s['code_source'], s['match_method'], s['match_confidence']) == ('Wikidata', 'name+distance', 'medium')
    assert s['sources'] == 'GatiShakti;Wikidata'
    assert s['source_points'] == 2


def test_uncoded_cluster_matched_on_distance_alone_only_when_close():
    cris = [pt(GS, 0, None, 77.1257, 8.3783), pt(GS, 1, None, 78, 9)]
    w = [wd(0, 'DAVM', 77.1244, 8.3788, 'Dhanuvachapuram railway station'),
         wd(1, 'FARX', 78, north(9, 1200), 'Somewhere railway station')]
    out, stats = b.merge(cris, w)
    codes = by_code(out)
    assert (codes['DAVM']['match_method'], codes['DAVM']['match_confidence']) == ('distance', 'low')
    assert 'FARX' not in codes
    assert [u['code'] for u in stats['wikidata_unplaced']] == ['FARX']
    uncoded = [s for s in out if s['stn_code'] is None]
    assert len(uncoded) == 1 and uncoded[0]['match_method'] == 'none' and uncoded[0]['match_confidence'] == 'low'


def test_one_wikidata_code_claims_at_most_one_cluster_nearest_first():
    cris = [pt(GS, 0, None, 77, 28), pt(GS, 1, None, 77, north(28, 1300))]
    out, _ = b.merge(cris, [wd(0, 'Q', 77, north(28, 1250))])
    assert by_code(out)['Q']['row'] == 1
    assert sum(1 for s in out if s['stn_code'] is None) == 1


def test_ir_portal_uncoded_duplicates_of_gatishakti_points_are_dropped():
    cris = [pt(GS, 0, None, 77, 28), pt(IR, 0, None, 77, north(28, 10)), pt(IR, 1, None, 79, 21)]
    out, stats = b.merge(cris, [])
    assert sorted((s['src'], s['row']) for s in out) == [(GS, 0), (IR, 1)]
    assert stats['irgis_uncoded_duplicates'] == 1


def test_wikidata_duplicate_codes_keep_the_lowest_item():
    w = [wd(0, 'A', 77, 28, item='http://www.wikidata.org/entity/Q90'),
         wd(1, 'A', 77, 28, item='http://www.wikidata.org/entity/Q7')]
    out, _ = b.merge([pt(GS, 0, 'A', 77, 28)], w)
    assert out[0]['wd_row'] == 1


def test_merge_is_deterministic():
    cris = [pt(GS, i, None if i % 3 else f'C{i}', 77 + i * 0.004, 28) for i in range(30)]
    w = [wd(i, f'W{i}', 77 + i * 0.012, 28.002) for i in range(10)]
    assert b.merge(cris, w)[0] == b.merge(list(reversed(cris)), list(reversed(w)))[0]


# ── columns ──────────────────────────────────────────────────────────────

def test_excluded_columns_are_bbox_helpers_and_editor_usernames(tmp_path):
    import duckdb
    src = tmp_path / 's.parquet'
    con = duckdb.connect()
    con.execute(f"COPY (SELECT 1 AS gid, 2.0 AS xmin, 'nehasingh' AS created_us, 'SDE' AS last_edite, "
                f"'6/27/22' AS created_da) TO '{src}' (FORMAT PARQUET)")
    assert b.excluded_cols(con, f"read_parquet('{src}')") == 'xmin, created_us, last_edite'


# ── idempotent bake ──────────────────────────────────────────────────────

def test_bake_is_up_to_date_only_with_same_inputs_and_every_output(tmp_path):
    outs = [tmp_path / 'a.parquet', tmp_path / 'a.pmtiles']
    summary = tmp_path / 'summary.json'
    assert not b.up_to_date(summary, 'k1', outs)
    for p in outs:
        p.write_text('x')
    summary.write_text(json.dumps({'inputs': 'k1'}))
    assert b.up_to_date(summary, 'k1', outs)
    assert not b.up_to_date(summary, 'k2', outs)
    outs[1].unlink()
    assert not b.up_to_date(summary, 'k1', outs)


# ── catalog ──────────────────────────────────────────────────────────────

def test_catalog_entry_is_cc_by_bharatlas_and_credits_every_upstream():
    sizes = {f: 1 for f in b.EXT}
    e = b.catalog_entry(100, sizes, '2026-11-17', 'https://r2.example')
    assert e['licence'] == 'CC-BY-4.0'
    assert e['attribution']['publisher']['name'] == 'bharatlas'
    for credit in ('CRIS', 'GatiShakti', 'Wikidata', 'DataMeet', 'ramSeraph'):
        assert credit in e['notes'] + json.dumps(e['attribution'])
    assert 'OpenStreetMap' in e['notes']  # says why OSM is not merged
    assert 'created_us' in e['notes']  # says which columns are left out
    want = f'https://r2.example/transport/ir-stations-merged/{b.BAKE_REVISION}/IR_Stations_Merged.parquet'
    assert e['parquet']['url'] == want


def test_register_patches_in_place_and_is_idempotent(tmp_path):
    cat = tmp_path / 'catalog.json'
    man = tmp_path / 'manifest.json'
    summ = tmp_path / 'summary.json'
    # The merged set replaces the IRGIS-only ir_stations layer under the same id
    # (owner, 2026-11-18), in place, so API/MCP clients and links keep working;
    # the day-old ir_stations_merged id is retired (/view redirects it).
    cat.write_text(json.dumps({
        'layers': [{'id': 'lgd_states'}, {'id': 'ir_stations', 'source': 'IRGIS'}, {'id': 'ir_tracks'},
                   {'id': 'ir_stations_merged'}],
        'level_meta': {'ir_stations': {'label': 'old'}, 'ir_stations_merged': {'label': 'x'}},
        'level_order': ['ir_stations', 'ir_stations_merged'],
        'attribution': {}}))
    man.write_text(json.dumps([{'id': 'ir_stations'}, {'id': 'ir_tracks'}, {'id': 'ir_stations_merged'}]))
    summ.write_text(json.dumps({'rows': 9, 'sizes': {f: 2 for f in b.EXT}}))
    for _ in range(2):
        b.register(cat, man, summ, r2_public='https://r2.example', fetched_at='2026-11-17')
    c = json.loads(cat.read_text())
    assert b.LAYER_ID == 'ir_stations'
    assert [e['id'] for e in c['layers']] == ['lgd_states', 'ir_stations', 'ir_tracks']
    assert c['layers'][1]['source'] != 'IRGIS'
    assert c['layers'][1]['fetched_at'] == '2026-11-17'
    assert c['level_order'] == ['ir_stations']
    assert set(c['level_meta']) == {'ir_stations'}
    assert [m['id'] for m in json.loads(man.read_text())] == ['ir_stations', 'ir_tracks']


def test_the_only_stations_layer_has_a_plain_title():
    # It replaced the IRGIS-only layer, so "merged" no longer distinguishes it.
    assert b.level_meta()['label'] == 'Railway stations'


def test_register_keeps_rebaked_tiles(tmp_path):
    # rebake_tiles.py gave ir_stations versioned tiles; re-registering must not
    # put the unversioned key back (scripts/tile_keys.py).
    cat, man, summ = tmp_path / 'c.json', tmp_path / 'm.json', tmp_path / 's.json'
    rebaked = {'url': 'https://r2.example/x/IR_Stations_Merged.d8a75d7e.pmtiles', 'bytes': 6}
    cat.write_text(json.dumps({'layers': [{'id': 'ir_stations', 'pmtiles': rebaked}], 'level_meta': {},
                               'level_order': [], 'attribution': {}}))
    man.write_text('[]')
    summ.write_text(json.dumps({'rows': 9, 'sizes': {f: 2 for f in b.EXT}}))
    b.register(cat, man, summ, r2_public='https://r2.example', fetched_at='2026-11-17')
    assert json.loads(cat.read_text())['layers'][0]['pmtiles'] == rebaked
