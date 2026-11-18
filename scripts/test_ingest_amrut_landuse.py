"""Tests for scripts/ingest_amrut_landuse.py (no network).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_ingest_amrut_landuse.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest_amrut_landuse as a  # noqa: E402

RELEASE = 'https://github.com/ramSeraph/indian_land_features/releases/download/urban-land-use/'


def test_one_layer_per_state_release_file():
    ids = [d.id for d in a.DATASETS]
    assert len(ids) == len(set(ids)) == 19
    assert {d.r2_prefix for d in a.DATASETS} == {f'agriculture/amrut-landuse/{d.id[len("amrut_landuse_"):]}'
                                                 for d in a.DATASETS}


def test_bhuvan_states_point_at_their_release_assets():
    up = a.by_id('amrut_landuse_up')
    assert up.parquet_url == RELEASE + 'UP_AMRUT_ULU.parquet'
    assert up.pmtiles_url == RELEASE + 'UP_AMRUT_ULU.pmtiles'
    assert up.source == 'Bhuvan' and up.source_url == 'https://bhuvan.nrsc.gov.in/'
    kl = a.by_id('amrut_landuse_kl')
    assert kl.parquet_url == RELEASE + 'KR_AMRUT_ULU.parquet'  # ramSeraph codes Kerala KR


def test_west_bengal_credits_the_state_amrut_portal():
    wb = a.by_id('amrut_landuse_wb')
    assert wb.parquet_url == RELEASE + 'WB_AMRUT_ULU_polygons.parquet'
    assert wb.source == 'WBAMRUT' and 'nagargispariseva' in wb.source_url


def test_republished_under_policy_b_with_cc0_and_land_use_category():
    for d in a.DATASETS:
        assert d.license == 'CC0-1.0' and d.category == 'agriculture' and d.level == d.id
        assert 'ramSeraph' in d.notes and 'no open licence' in d.notes
        assert '—' not in d.name + d.description + d.notes
        assert d.kml_name_field == 'Sub_Class'


def test_whole_layer_downloads_follow_the_size_cap():
    # republished() bakes every format; AMRUT states run to 1.8 GB of parquet, so the
    # standard WHOLE_LAYER_MAX_MB cap decides (GeoJSON of a 1.8 GB parquet is ~8 GB).
    assert not any(d.bake_all_formats for d in a.DATASETS)


@pytest.mark.parametrize('cols,bad', [
    (['id', 'Class', 'Sub_Class', 'Name', 'city'], []),
    (['id', 'Owner_Name', 'Mobile_No', 'Class'], ['Owner_Name', 'Mobile_No']),
    (['email', 'Phone'], ['email', 'Phone']),
])
def test_personal_columns_are_caught(cols, bad):
    assert a.personal_columns(cols) == bad


def test_fetched_at_is_a_date():
    assert a.date_only('2026-11-17T10:11:12+00:00') == '2026-11-17'
    assert a.date_only('2026-11-17') == '2026-11-17'
