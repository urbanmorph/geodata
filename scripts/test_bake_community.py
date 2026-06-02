"""Tests for the pure decision + catalog-shaping helpers in bake_community.

The actual bake (ogr2ogr / DuckDB / tippecanoe / R2 upload) is exercised
end-to-end when the script runs against a real submission; here we pin the
bake-rule thresholds and the c_<id> catalog-entry shape that are easy to
get wrong silently and that drive whether /api/v1/nearby, the Filter &
export panel, and the full /view/ viewer light up for a community layer.

Run: python3 -m pytest scripts/test_bake_community.py -v"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))


# ---------- pmtiles threshold ------------------------------------------------

def test_pmtiles_skipped_for_small_layer() -> None:
    # The Goa submission: 779 features / 1.6 MB. geojson renders instantly;
    # tiling is pure overhead.
    from bake_community import should_bake_pmtiles
    assert should_bake_pmtiles(779, 1_687_231) is False


def test_pmtiles_baked_above_feature_threshold() -> None:
    from bake_community import should_bake_pmtiles, PMTILES_MIN_FEATURES
    assert should_bake_pmtiles(PMTILES_MIN_FEATURES, 1024) is True
    assert should_bake_pmtiles(PMTILES_MIN_FEATURES - 1, 1024) is False


def test_pmtiles_baked_above_byte_threshold() -> None:
    from bake_community import should_bake_pmtiles, PMTILES_MIN_BYTES
    # Few features but a heavy payload (dense geometry) still warrants tiles.
    assert should_bake_pmtiles(10, PMTILES_MIN_BYTES) is True
    assert should_bake_pmtiles(10, PMTILES_MIN_BYTES - 1) is False


def test_pmtiles_handles_missing_counts() -> None:
    from bake_community import should_bake_pmtiles
    assert should_bake_pmtiles(None, None) is False


# ---------- full bake plan ---------------------------------------------------

def test_plan_always_bakes_parquet_geojson_kml() -> None:
    from bake_community import plan_bakes
    plan = plan_bakes(779, 1_687_231)
    assert plan.parquet is True
    assert plan.geojson is True
    assert plan.kml is True
    assert plan.pmtiles is False
    # <10k features → single row group; bbox/Hilbert sort is a harmless no-op.
    assert plan.row_group_size is None


def test_plan_row_group_size_tiers_match_ramseraph() -> None:
    from bake_community import plan_bakes
    assert plan_bakes(9_999, 1024).row_group_size is None
    assert plan_bakes(50_000, 1024).row_group_size == 5_000
    assert plan_bakes(150_000, 1024).row_group_size == 20_000


def test_plan_bakes_pmtiles_for_large_layer() -> None:
    from bake_community import plan_bakes
    assert plan_bakes(200_000, 50_000_000).pmtiles is True


# ---------- R2 keys + catalog id --------------------------------------------

def test_catalog_layer_id_prefixes_submission() -> None:
    from bake_community import catalog_layer_id
    assert catalog_layer_id('nL7zNStsW3') == 'c_nL7zNStsW3'


def test_baked_key_lives_under_community_prefix() -> None:
    from bake_community import baked_key
    assert baked_key('nL7zNStsW3', 'parquet') == 'community/nL7zNStsW3/nL7zNStsW3.parquet'
    assert baked_key('nL7zNStsW3', 'pmtiles') == 'community/nL7zNStsW3/nL7zNStsW3.pmtiles'
    assert baked_key('nL7zNStsW3', 'geojson') == 'community/nL7zNStsW3/nL7zNStsW3.geojson'


# ---------- catalog entry shape ---------------------------------------------

def _meta() -> dict:
    return {
        'id': 'nL7zNStsW3',
        'name': 'Goa Landuse Zone Change Applications',
        'description': 'Parcels for landuse zone change under section 39A.',
        'category': 'environment',
        'license': 'CC0-1.0',
        'attribution': 'Goa Gazette, Goa Bhunaksha',
        'source_url': 'https://goaprintingpress.gov.in/search-by-date/',
        'is_original': 0,
        'feature_count': 779,
        'created_at': '2026-05-25T11:30:45.719Z',
    }


def _artifacts() -> dict:
    base = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/community/nL7zNStsW3'
    return {
        'parquet': {'url': f'{base}/nL7zNStsW3.parquet', 'bytes': 900_000},
        'geojson': {'url': f'{base}/nL7zNStsW3.geojson', 'bytes': 1_687_231},
        'kml': {'url': f'{base}/nL7zNStsW3.kml', 'bytes': 1_500_000},
    }


def test_entry_is_community_provenance_curated_shape() -> None:
    from bake_community import build_community_catalog_entry
    entry = build_community_catalog_entry(_meta(), _artifacts())
    assert entry['id'] == 'c_nL7zNStsW3'
    assert entry['provenance'] == 'community'
    assert entry['level'] is None
    assert entry['name'] == 'Goa Landuse Zone Change Applications'
    assert entry['rows'] == 779
    assert entry['licence'] == 'CC0-1.0'
    assert entry['category'] == 'environment'
    assert entry['fetched_at'] == '2026-05-25T11:30:45.719Z'
    # Attribution carries the submitter's credit + source so the card + viewer
    # surface provenance the same way curated cards do.
    assert entry['attribution']['primary']['name'] == 'Goa Gazette, Goa Bhunaksha'
    assert entry['attribution']['primary']['url'] == 'https://goaprintingpress.gov.in/search-by-date/'


def test_entry_drops_absent_format_blocks() -> None:
    from bake_community import build_community_catalog_entry
    entry = build_community_catalog_entry(_meta(), _artifacts())
    # No pmtiles was baked for the small layer → no dangling null block.
    assert 'pmtiles' not in entry
    assert entry['parquet']['bytes'] == 900_000
    assert entry['geojson']['url'].endswith('.geojson')


def test_entry_falls_back_to_id_when_name_missing() -> None:
    from bake_community import build_community_catalog_entry
    meta = _meta()
    meta['name'] = ''
    entry = build_community_catalog_entry(meta, _artifacts())
    assert entry['name'] == 'nL7zNStsW3'


# ---------- orphan cleanup (full idempotency) -------------------------------

def test_orphan_keys_targets_unbaked_pmtiles_for_small_layer() -> None:
    # A prior bake when the layer was large may have left a pmtiles behind.
    # After a shrinking edit, plan_bakes drops pmtiles → that stale key is an
    # orphan to clean so community/<id>/ matches the catalog entry exactly.
    from bake_community import orphan_keys, plan_bakes
    plan = plan_bakes(779, 1_687_231)  # small → no pmtiles
    assert orphan_keys('nL7zNStsW3', plan) == ['community/nL7zNStsW3/nL7zNStsW3.pmtiles']


def test_orphan_keys_empty_when_every_format_baked() -> None:
    from bake_community import orphan_keys, plan_bakes
    plan = plan_bakes(200_000, 50_000_000)  # large → pmtiles baked too
    assert orphan_keys('nL7zNStsW3', plan) == []


# ---------- catalog merge (idempotent) --------------------------------------

def test_merge_appends_new_community_entry() -> None:
    from bake_community import merge_community_entry
    catalog = {'layers': [{'id': 'lgd_states', 'level': 'state'}]}
    entry = {'id': 'c_x', 'provenance': 'community'}
    merge_community_entry(catalog, entry)
    assert len(catalog['layers']) == 2
    assert catalog['layers'][-1]['id'] == 'c_x'


def test_merge_replaces_existing_community_entry_in_place() -> None:
    from bake_community import merge_community_entry
    catalog = {
        'layers': [
            {'id': 'lgd_states', 'level': 'state'},
            {'id': 'c_x', 'provenance': 'community', 'rows': 1},
            {'id': 'lgd_districts', 'level': 'district'},
        ]
    }
    merge_community_entry(catalog, {'id': 'c_x', 'provenance': 'community', 'rows': 2})
    ids = [l['id'] for l in catalog['layers']]
    assert ids == ['lgd_states', 'c_x', 'lgd_districts']  # no dupes, order kept
    assert catalog['layers'][1]['rows'] == 2  # replaced
