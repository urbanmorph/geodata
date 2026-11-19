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


def test_baked_key_is_versioned_by_the_file_md5() -> None:
    # Spec rule 2: a changed file gets a new key <stem>.<md5[:8]>.<ext>; nothing is overwritten.
    from bake_community import baked_key
    md5 = '0a1b2c3d4e5f67890a1b2c3d4e5f6789'
    assert baked_key('nL7zNStsW3', 'parquet', md5) == 'community/nL7zNStsW3/nL7zNStsW3.0a1b2c3d.parquet'
    assert baked_key('nL7zNStsW3', 'pmtiles', md5) == 'community/nL7zNStsW3/nL7zNStsW3.0a1b2c3d.pmtiles'
    assert baked_key('nL7zNStsW3', 'geojson', md5) == 'community/nL7zNStsW3/nL7zNStsW3.0a1b2c3d.geojson'
    assert baked_key('nL7zNStsW3', 'shapefile', md5) == 'community/nL7zNStsW3/nL7zNStsW3.0a1b2c3d.shp.zip'


def test_versioned_tiles_join_their_family_for_r2_prune() -> None:
    # r2_prune keeps the current and previous tiles of a family; a community tile key must belong to one.
    from bake_community import baked_key
    from tile_keys import unversioned_name
    assert unversioned_name(baked_key('nL7zNStsW3', 'pmtiles', 'f' * 32)) == 'nL7zNStsW3.pmtiles'


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


# ---------- a re-bake never deletes an earlier R2 key ------------------------

class _FakeS3:
    """Records every call; a re-bake may read and upload, never delete."""

    def __init__(self):
        self.deleted: list[str] = []

    def download_file(self, bucket, key, dest):
        Path(dest).write_text('{}')

    def head_object(self, **kw):
        return {}

    def delete_object(self, Bucket, Key):  # noqa: N803
        self.deleted.append(Key)

    def delete_objects(self, Bucket, Delete):  # noqa: N803
        self.deleted += [o['Key'] for o in Delete['Objects']]


def test_a_rebake_that_no_longer_makes_tiles_keeps_the_earlier_tiles_on_r2(tmp_path, monkeypatch) -> None:
    # Spec rule 1 (a published URL never breaks) and the owner's decision of 18 Nov 2026: a community re-bake
    # follows the keep/prune rules like every other bake, so a pmtiles left by a larger earlier bake stays on R2.
    import bake_community as bc

    def touch(*paths):
        for p in paths:
            Path(p).write_text('x')

    meta = {'id': 'nL7zNStsW3', 'name': 'n', 'r2_key': 'submissions/nL7zNStsW3/raw.geojson', 'format': 'geojson',
            'licence': 'CC-BY-4.0', 'category': 'environment', 'source_url': 'https://example.org/'}
    monkeypatch.setattr(bc, 'fetch_submission', lambda sub_id, scope: dict(meta))
    monkeypatch.setattr(bc, 'normalize_to_geojson', lambda raw, fmt, gj: touch(gj))
    monkeypatch.setattr(bc, 'geojson_to_parquet', lambda gj, pq: touch(pq) or 779)     # small: no tiles this time
    monkeypatch.setattr(bc, 'geojson_to_kml', lambda gj, kml: touch(kml))
    monkeypatch.setattr(bc, 'geojson_to_pmtiles', lambda *a: (_ for _ in ()).throw(AssertionError('no tiles')))
    monkeypatch.setattr(bc, 'r2_upload', lambda s3, path, key: None)
    monkeypatch.setattr(bc, 'build_community_catalog_entry', lambda m, a: {'id': 'c_nL7zNStsW3', **a})
    catalog = tmp_path / 'catalog.json'
    catalog.write_text('{"layers": []}')
    monkeypatch.setattr(bc, 'CATALOG', catalog)
    s3 = _FakeS3()
    bc.bake('nL7zNStsW3', 'local', s3, tmp_path / 'work', dry_run=False)
    assert s3.deleted == []
    assert not hasattr(bc, 'orphan_keys')


def _fake_bake(tmp_path, monkeypatch, content: str):
    """Run bake() with the converters stubbed to write `content`; returns (uploaded keys, catalog entry)."""
    import bake_community as bc

    def write(*paths):
        for p in paths:
            Path(p).write_text(content)

    meta = {'id': 'nL7zNStsW3', 'name': 'n', 'r2_key': 'submissions/nL7zNStsW3/raw.geojson', 'format': 'geojson'}
    uploads: list[str] = []
    monkeypatch.setattr(bc, 'fetch_submission', lambda sub_id, scope: dict(meta))
    monkeypatch.setattr(bc, 'normalize_to_geojson', lambda raw, fmt, gj: write(gj))
    monkeypatch.setattr(bc, 'geojson_to_parquet', lambda gj, pq: write(pq) or 779)
    monkeypatch.setattr(bc, 'geojson_to_kml', lambda gj, kml: write(kml))
    monkeypatch.setattr(bc, 'r2_upload', lambda s3, path, key: uploads.append(key))
    catalog = tmp_path / 'catalog.json'
    if not catalog.exists():
        catalog.write_text('{"layers": []}')
    monkeypatch.setattr(bc, 'CATALOG', catalog)
    entry = bc.bake('nL7zNStsW3', 'local', _FakeS3(), tmp_path / 'work', dry_run=False)
    return uploads, entry


def test_a_bake_uploads_to_versioned_keys_and_the_catalog_points_at_them(tmp_path, monkeypatch) -> None:
    import hashlib
    from pipeline import R2_PUBLIC
    uploads, entry = _fake_bake(tmp_path, monkeypatch, 'v1')
    h = hashlib.md5(b'v1').hexdigest()[:8]
    assert sorted(uploads) == sorted(f'community/nL7zNStsW3/nL7zNStsW3.{h}.{ext}' for ext in ('parquet', 'geojson', 'kml'))
    assert entry['parquet']['url'] == f'{R2_PUBLIC}/community/nL7zNStsW3/nL7zNStsW3.{h}.parquet'


def test_a_rebake_of_changed_data_gets_new_keys_and_same_data_the_same_keys(tmp_path, monkeypatch) -> None:
    first, _ = _fake_bake(tmp_path, monkeypatch, 'v1')
    again, _ = _fake_bake(tmp_path, monkeypatch, 'v1')
    changed, entry = _fake_bake(tmp_path, monkeypatch, 'v2')
    assert again == first                      # idempotent: same bytes, same keys (r2_upload md5-skips)
    assert not set(changed) & set(first)       # a changed file never overwrites the published one
    assert {entry[f]['url'].rsplit('/', 1)[-1] for f in ('parquet', 'geojson', 'kml')} == {k.rsplit('/', 1)[-1] for k in changed}


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
    ids = [lyr['id'] for lyr in catalog['layers']]
    assert ids == ['lgd_states', 'c_x', 'lgd_districts']  # no dupes, order kept
    assert catalog['layers'][1]['rows'] == 2  # replaced
