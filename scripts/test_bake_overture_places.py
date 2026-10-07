"""Tests for scripts/bake_overture_places.py (pure helpers only; no network).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_overture_places.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_overture_places as b  # noqa: E402

R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'


# ── which upstream files to fetch ─────────────────────────────────────────

def rg(file, xmin, ymin, xmax, ymax):
    return {'file': file, 'xmin': xmin, 'ymin': ymin, 'xmax': xmax, 'ymax': ymax}


def test_overlapping_files_keeps_only_files_with_a_row_group_touching_india():
    groups = [
        rg('s3://x/part-1.parquet', 70, 10, 80, 20),     # inside India
        rg('s3://x/part-1.parquet', -10, 40, 0, 50),     # Europe, same file
        rg('s3://x/part-2.parquet', -120, 30, -100, 45),  # USA only
        rg('s3://x/part-3.parquet', 95, 30, 110, 40),     # straddles the east edge
    ]
    assert b.overlapping_files(groups) == ['s3://x/part-1.parquet', 's3://x/part-3.parquet']


def test_overlapping_files_ignores_row_groups_without_stats():
    assert b.overlapping_files([rg('s3://x/p.parquet', None, None, None, None)]) == []


# ── R2 layout: versioned keys, never the old immutable paths ──────────────

def test_r2_keys_are_versioned_by_release():
    keys = b.r2_keys('2026-09-23.1')
    assert keys == {
        'parquet': 'pois/overture-places/2026-09-23.1/overture_places_india.parquet',
        'pmtiles': 'pois/overture-places/2026-09-23.1/overture_places_india.pmtiles',
        'geojson': 'pois/overture-places/2026-09-23.1/overture_places_india.geojson',
        'shapefile': 'pois/overture-places/2026-09-23.1/overture_places_india.shp.zip',
    }


OLD_LAYER = {
    'id': 'overture_places_india',
    'category': 'infrastructure',
    'licence': 'CDLA-Permissive-2.0',
    'rows': 2744948,
    'provenance': 'curated',
    'notes': 'old notes',
    'parquet': {'url': f'{R2}/pois/overture-places/overture_places_india.parquet',
                'upstream_url': 'https://github.com/ramSeraph/x.parquet', 'bytes': 1},
    'pmtiles': {'url': f'{R2}/pois/overture-places/overture_places_india.pmtiles',
                'upstream_url': 'https://github.com/ramSeraph/x.pmtiles', 'bytes': 2},
    'geojson': None, 'kml': None, 'shapefile': None,
}
SIZES = {'parquet': 10, 'pmtiles': 20, 'geojson': 30, 'shapefile': 40}


def patched():
    return b.patched_layer(OLD_LAYER, '2026-09-23.1', SIZES, 4_000_000,
                           '2026-10-07T12:00:00+00:00', R2)


def test_patched_layer_points_every_format_at_the_new_release():
    new = patched()
    for fmt, size in SIZES.items():
        assert new[fmt]['url'] == f'{R2}/{b.r2_keys("2026-09-23.1")[fmt]}'
        assert new[fmt]['bytes'] == size
        assert 'ramSeraph' not in new[fmt].get('upstream_url', '')
    assert new['kml'] is None  # KML comes from Filter & export, not a whole-India file


def test_patched_layer_updates_rows_date_and_notes_but_keeps_identity():
    new = patched()
    assert new['rows'] == 4_000_000
    assert new['fetched_at'] == '2026-10-07T12:00:00+00:00'
    assert '2026-09-23.1' in new['notes']
    assert '—' not in new['notes']  # no em-dashes in user copy
    assert 'LGD district' in new['notes']
    for k in ('id', 'category', 'provenance'):
        assert new[k] == OLD_LAYER[k]
    # Foursquare-sourced records are Apache-2.0; the rest CDLA (AllThePlaces CC0).
    assert new['licence'] == 'CDLA-Permissive-2.0 / Apache-2.0'
    assert 'Foursquare' in new['notes'] and 'Apache-2.0' in new['notes']
    assert OLD_LAYER['rows'] == 2744948  # input not mutated


def test_stale_keys_lists_only_old_objects_no_longer_referenced():
    assert b.stale_keys(OLD_LAYER, patched(), R2) == [
        'pois/overture-places/overture_places_india.parquet',
        'pois/overture-places/overture_places_india.pmtiles',
    ]


def test_stale_keys_is_empty_when_nothing_changed():
    assert b.stale_keys(patched(), patched(), R2) == []


# ── tiles: popup fields only (many attributes make tippecanoe drop points) ─

def test_tile_fields_are_the_popup_fields():
    assert b.TILE_FIELDS == ('id', 'name', 'basic_category', 'confidence', 'operating_status')


def test_pmtiles_args_keep_only_tile_fields_and_read_geojsonseq():
    args = b.pmtiles_args(Path('/w/tiles.geojsons'), Path('/w/out.pmtiles'))
    assert args[0] == 'tippecanoe'
    assert args[args.index('-l') + 1] == 'overture_places_india'
    kept = [args[i + 1] for i, a in enumerate(args) if a == '-y']
    assert kept == list(b.TILE_FIELDS)
    assert '-P' in args  # parallel read of line-delimited input
    assert args[-1] == '/w/tiles.geojsons'


def test_tile_features_sql_flattens_names_primary_and_keeps_geometry():
    sql = b.tile_features_sql('/w/in.parquet')
    assert 'names."primary"' in sql
    assert "ST_AsGeoJSON(geometry)" in sql
    for f in b.TILE_FIELDS:
        assert f in sql


# ── shapefile: flat, <=10-char names, documented in columns.txt ───────────

def test_shapefile_names_fit_dbf_limit_and_are_unique():
    names = list(b.SHP_FIELDS)
    assert all(len(n) <= 10 for n in names)
    assert len(set(names)) == len(names)


def test_shapefile_key_lists_every_short_name():
    key = b.shapefile_key()
    for short in b.SHP_FIELDS:
        assert any(line.startswith(short) for line in key)


# ── clip: inside India only ───────────────────────────────────────────────

def test_clip_sql_spatially_joins_lgd_districts_and_dedupes_border_points():
    sql = b.clip_sql(['/s/a.parquet', '/s/b.parquet'], '/w/lgd_districts.parquet')
    assert "'/s/a.parquet'" in sql and "'/s/b.parquet'" in sql
    assert "bbox.xmin" in sql  # cheap prefilter before the join
    # Join against 785 district polygons (indexable), not one huge India polygon.
    assert "ST_Intersects" in sql and "'/w/lgd_districts.parquet'" in sql
    # A point on a shared district border matches twice: keep one row per id.
    assert "QUALIFY row_number() OVER (PARTITION BY p.id" in sql
    # LGD geometry has no CRS label, Overture is OGC:CRS84 (both lon/lat):
    # relabel, never transform (a transform would swap axes).
    assert "ST_SetCRS(geometry, 'OGC:CRS84')" in sql
    assert 'ST_Transform' not in sql


@pytest.mark.parametrize('release', ['2026-09-23.1', '2027-01-21.0'])
def test_upstream_url_names_the_release(release):
    assert release in b.upstream_url(release)


# ── manifest + label: a later build_catalog must not revert to deleted keys ─

OLD_MANIFEST = {
    'id': 'overture_places_india', 'name': 'Places — Overture Maps (Dec 2023)',
    'level': 'overture_places_india', 'category': 'infrastructure', 'source': 'Overture',
    'description': 'old', 'unit': 'places', 'features': 2744948, 'license': 'CDLA-Permissive-2.0',
    'r2_prefix': 'pois/overture-places', 'parquet_file': 'overture_places_india.parquet',
    'parquet_bytes': 1, 'pmtiles_file': 'overture_places_india.pmtiles', 'pmtiles_bytes': 2,
    'source_url': 'https://overturemaps.org/overture-december-2023-release-notes/',
    'source_org': 'Overture Maps Foundation', 'notes': 'old',
}


def test_display_name_uses_release_month_without_em_dash():
    assert b.display_name('2026-09-23.1') == 'Places (Overture Maps, Sep 2026)'


def test_patched_manifest_entry_matches_the_new_r2_layout():
    new = b.patched_manifest_entry(OLD_MANIFEST, '2026-09-23.1', SIZES, 4_000_000)
    assert new['r2_prefix'] == 'pois/overture-places/2026-09-23.1'
    assert f"{new['r2_prefix']}/{new['parquet_file']}" == b.r2_keys('2026-09-23.1')['parquet']
    assert f"{new['r2_prefix']}/{new['pmtiles_file']}" == b.r2_keys('2026-09-23.1')['pmtiles']
    assert (new['parquet_bytes'], new['pmtiles_bytes'], new['features']) == (10, 20, 4_000_000)
    assert new['name'] == 'Places (Overture Maps, Sep 2026)'
    assert '2026-09-23.1' in new['description'] and '2026-09-23.1' in new['notes']
    assert 'december-2023' not in new['source_url']
    assert new['license'] == 'CDLA-Permissive-2.0 / Apache-2.0'
    assert OLD_MANIFEST['features'] == 2744948  # input not mutated


def test_level_meta_label_and_description_follow_the_release():
    meta = b.patched_level_meta({'label': 'old', 'unit': 'places', 'description': 'old'}, '2026-09-23.1')
    assert meta == {'label': 'Places (Overture Maps, Sep 2026)', 'unit': 'places',
                    'description': b.description_for('2026-09-23.1')}


# ── shapefile split per state: a DBF over 2 GB breaks most GIS tools ──────

def test_state_slug_is_filename_safe():
    assert b.state_slug('ANDAMAN & NICOBAR') == 'andaman_nicobar'
    assert b.state_slug('JAMMU & KASHMIR') == 'jammu_kashmir'
    assert b.state_slug('Dadra and Nagar Haveli and Daman and Diu') == 'dadra_and_nagar_haveli_and_daman_and_diu'


def test_check_dbf_sizes_rejects_any_part_over_2gb():
    b.check_dbf_sizes({'goa': 10_000_000, 'maharashtra': 1_900_000_000})
    with pytest.raises(ValueError, match='maharashtra'):
        b.check_dbf_sizes({'goa': 10, 'maharashtra': 2_200_000_000})


def test_shapefile_key_says_files_are_per_state():
    assert any('one shapefile per state' in line.lower() for line in b.shapefile_key())


def test_shapefile_rows_sql_tags_each_place_with_its_state():
    sql = b.shapefile_rows_sql('/w/p.parquet', '/w/lgd_districts.parquet')
    assert 'stname' in sql and 'ST_Intersects' in sql
    assert "QUALIFY row_number() OVER (PARTITION BY p.id" in sql
    for short in b.SHP_FIELDS:
        assert f'AS "{short}"' in sql
