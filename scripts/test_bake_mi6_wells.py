"""Tests for scripts/bake_mi6_wells.py.

Pure helpers always run; the end-to-end check runs when the Land Ledger
aggregate is present locally.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_mi6_wells.py -q
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_mi6_wells as b  # noqa: E402

R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'
WELLS_COLS = ['dist_lgd', 'state_lgd', 'district', 'state', 'status', 'dugwell', 'total',
              'in_use_share', 'nsa_ha', 'nsa_years', 'wells_per_1000ha_nsa',
              'parent_dist_lgd', 'parent_wells_per_1000ha_nsa', 'note', 'census_ref_year', 'source']


# ── columns: census-derived only ─────────────────────────────────────────

def test_output_columns_drop_the_net_sown_area_columns():
    # NSA comes from IDP land-use statistics, whose licence is blank.
    cols = b.output_columns(WELLS_COLS)
    for c in ('nsa_ha', 'nsa_years', 'wells_per_1000ha_nsa', 'parent_wells_per_1000ha_nsa'):
        assert c not in cols


def test_output_columns_keep_order_and_keys_first():
    assert b.output_columns(WELLS_COLS) == [
        'dist_lgd', 'state_lgd', 'district', 'state', 'status', 'dugwell', 'total',
        'in_use_share', 'parent_dist_lgd', 'note', 'census_ref_year', 'source']


@pytest.mark.parametrize('col', ['owner_social_group', 'gender', 'village', 'Village_Name'])
def test_check_columns_rejects_personal_or_village_fields(col):
    with pytest.raises(ValueError, match=col):
        b.check_columns(WELLS_COLS + [col])


def test_check_columns_accepts_the_aggregate():
    b.check_columns(b.output_columns(WELLS_COLS))


# ── join: every LGD district polygon, census values where present ─────────

def test_join_sql_keeps_every_district_polygon():
    sql = b.join_sql('/w/wells.parquet', '/w/districts.parquet', ['dist_lgd', 'district', 'total'])
    assert 'LEFT JOIN' in sql
    assert 'g.dist_lgd' in sql and 'COALESCE(w.district, g.dtname)' in sql
    assert "'/w/wells.parquet'" in sql and "'/w/districts.parquet'" in sql
    assert 'g.geometry' in sql


def test_totals_check_passes_on_the_published_census_total():
    b.check_totals(rows=785, wells=21_931_924)


@pytest.mark.parametrize('rows,wells', [(783, 21_931_924), (785, 21_931_923)])
def test_totals_check_fails_loudly_on_drift(rows, wells):
    with pytest.raises(ValueError):
        b.check_totals(rows=rows, wells=wells)


# ── tiles + shapefile ─────────────────────────────────────────────────────

def test_tile_fields_are_popup_fields_present_in_the_output():
    assert b.TILE_FIELDS == ('district', 'state', 'status', 'total', 'dugwell', 'shallow_tw',
                             'medium_tw', 'deep_tw', 'in_use_share', 'electric_share')


def test_shapefile_names_cover_every_output_column():
    import bake_formats
    names = bake_formats.short_field_names(['dist_lgd', 'shallow_tw_in_use', 'shallow_tw', 'energy_electric_all'])
    assert set(names) == {'dist_lgd', 'shallow_tw_in_use', 'shallow_tw', 'energy_electric_all'}
    assert names['shallow_tw'] == 'shallow_tw'
    assert all(len(v) <= 10 for v in names.values())


# ── catalog registration ─────────────────────────────────────────────────

SIZES = {'parquet': 1, 'pmtiles': 2, 'geojson': 3, 'kml': 4, 'shapefile': 5}


def test_catalog_entry_is_complete_and_honest():
    e = b.catalog_entry(785, SIZES, '2026-10-07T12:00:00+00:00', R2)
    assert e['id'] == e['level'] == 'mi6_wells_districts'
    assert (e['licence'], e['provenance'], e['category']) == ('GODL-India', 'curated', 'water')
    assert e['rows'] == 785 and e['fetched_at'].startswith('2026-10-07')
    assert 'Minor Irrigation' in e['attribution']['primary']['name']
    from build_catalog import ATTR
    assert e['attribution']['primary'] == ATTR['MIWing']  # one source of truth for the credit
    for fmt, size in SIZES.items():
        assert e[fmt] == {'url': f'{R2}/{b.R2_PREFIX}/{b.BASENAME}.{b.EXT[fmt]}', 'bytes': size}
    notes = e['notes']
    for must in ('2017-18', 'data.gov.in', 'GODL-India', 'not split', 'gross', 'Land Ledger'):
        assert must in notes
    assert '—' not in notes and '—' not in b.description()


def test_manifest_entry_rebuilds_the_same_urls():
    m = b.manifest_entry(785, SIZES)
    assert f"{m['r2_prefix']}/{m['parquet_file']}" == f'{b.R2_PREFIX}/{b.BASENAME}.parquet'
    assert f"{m['r2_prefix']}/{m['pmtiles_file']}" == f'{b.R2_PREFIX}/{b.BASENAME}.pmtiles'
    assert (m['features'], m['license'], m['source']) == (785, 'GODL-India', 'MIWing')


def test_level_meta_label():
    meta = b.level_meta()
    assert meta['label'] == 'Wells by District (Minor Irrigation Census 2017-18)'
    assert meta['unit'] == 'districts'


# ── end to end against the real aggregate (local only) ───────────────────

LL = Path.home() / 'Projects/rural/shc/build/mi6_wells_district.parquet'


DISTRICTS = Path(os.environ.get('LGD_DISTRICTS_PARQUET', '/nonexistent'))


@pytest.mark.skipif(not (LL.exists() and DISTRICTS.exists()),
                    reason='needs the Land Ledger aggregate and LGD_DISTRICTS_PARQUET')
def test_bake_parquet_against_land_ledger(tmp_path):
    import duckdb
    districts = DISTRICTS
    out = tmp_path / 'w.parquet'
    rows, wells = b.write_joined_parquet(LL, districts, out)
    b.check_totals(rows=rows, wells=wells)
    con = duckdb.connect()
    cols = [c[0] for c in con.execute(f"DESCRIBE SELECT * FROM '{out}'").fetchall()]
    assert 'nsa_ha' not in cols and 'geometry' in cols


def test_register_patches_catalog_and_manifest_idempotently(tmp_path):
    import json
    cat, man, summ = tmp_path / 'catalog.json', tmp_path / 'm.json', tmp_path / 's.json'
    cat.write_text(json.dumps({'layers': [{'id': 'lgd_districts'}], 'level_meta': {},
                               'level_order': ['lgd_districts'], 'attribution': {}}))
    man.write_text('[]')
    summ.write_text(json.dumps({'rows': 785, 'wells': 21_931_924, 'sizes': SIZES}))
    for _ in range(2):  # re-running must not duplicate anything
        b.register(cat, man, summ, R2)
    c, m = json.loads(cat.read_text()), json.loads(man.read_text())
    assert [l['id'] for l in c['layers']] == ['lgd_districts', 'mi6_wells_districts']
    assert c['level_order'] == ['lgd_districts', 'mi6_wells_districts']
    assert c['level_meta']['mi6_wells_districts'] == b.level_meta()
    assert c['attribution']['MIWing'] == b.ATTRIBUTION
    assert [e['id'] for e in m] == ['mi6_wells_districts']
