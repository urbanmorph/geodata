"""Tests that build_catalog.py preserves existing catalog.json fields
when local baked files are absent. Run: python3 -m pytest scripts/test_catalog_idempotent.py -v"""
import json
import pytest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


def make_prev_layer(layer_id='lgd_states', **overrides):
    base = {
        'id': layer_id,
        'level': 'state',
        'source': 'LGD',
        'rows': 36,
        'parquet': {'url': 'https://r2.example/states/LGD_States.parquet', 'bytes': 7_000_000},
        'pmtiles': {'url': 'https://r2.example/states/LGD_States.pmtiles', 'bytes': 3_000_000},
        'geojson': {'url': 'https://r2.example/states/LGD_States.geojson', 'bytes': 25_000_000},
        'kml': {'url': 'https://r2.example/states/LGD_States.kml', 'bytes': 20_000_000},
        'shapefile': {'url': 'https://r2.example/states/LGD_States.shp.zip', 'bytes': 11_000_000},
        'fetched_at': '2026-05-01T00:00:00+00:00',
    }
    base.update(overrides)
    return base


class TestCarryForward:
    """When local files don't exist, the builder should carry forward
    bytes, baked downloads, and fetched_at from the previous catalog."""

    def test_import_carry_forward(self):
        """carry_forward_from_prev is importable."""
        from build_catalog import carry_forward_from_prev
        assert callable(carry_forward_from_prev)

    def test_preserves_parquet_bytes(self):
        from build_catalog import carry_forward_from_prev
        prev = make_prev_layer()
        layer = {'id': 'lgd_states', 'parquet': {'url': prev['parquet']['url'], 'bytes': None}, 'pmtiles': None, 'geojson': None, 'kml': None, 'shapefile': None, 'fetched_at': None}
        carry_forward_from_prev(layer, {prev['id']: prev})
        assert layer['parquet']['bytes'] == 7_000_000

    def test_preserves_pmtiles_bytes(self):
        from build_catalog import carry_forward_from_prev
        prev = make_prev_layer()
        layer = {'id': 'lgd_states', 'parquet': {'url': 'x', 'bytes': None}, 'pmtiles': {'url': prev['pmtiles']['url'], 'bytes': None}, 'geojson': None, 'kml': None, 'shapefile': None, 'fetched_at': None}
        carry_forward_from_prev(layer, {prev['id']: prev})
        assert layer['pmtiles']['bytes'] == 3_000_000

    def test_preserves_baked_geojson(self):
        from build_catalog import carry_forward_from_prev
        prev = make_prev_layer()
        layer = {'id': 'lgd_states', 'parquet': {'url': 'x', 'bytes': None}, 'pmtiles': None, 'geojson': None, 'kml': None, 'shapefile': None, 'fetched_at': None}
        carry_forward_from_prev(layer, {prev['id']: prev})
        assert layer['geojson'] == prev['geojson']
        assert layer['kml'] == prev['kml']
        assert layer['shapefile'] == prev['shapefile']

    def test_preserves_fetched_at(self):
        from build_catalog import carry_forward_from_prev
        prev = make_prev_layer()
        layer = {'id': 'lgd_states', 'parquet': {'url': 'x', 'bytes': None}, 'pmtiles': None, 'geojson': None, 'kml': None, 'shapefile': None, 'fetched_at': None}
        carry_forward_from_prev(layer, {prev['id']: prev})
        assert layer['fetched_at'] == '2026-05-01T00:00:00+00:00'

    def test_local_file_wins_over_prev(self):
        """When local file has bytes, don't overwrite with prev."""
        from build_catalog import carry_forward_from_prev
        prev = make_prev_layer()
        layer = {'id': 'lgd_states', 'parquet': {'url': 'x', 'bytes': 9_999_999}, 'pmtiles': None, 'geojson': {'url': 'x', 'bytes': 30_000_000}, 'kml': None, 'shapefile': None, 'fetched_at': '2026-05-26T00:00:00+00:00'}
        carry_forward_from_prev(layer, {prev['id']: prev})
        assert layer['parquet']['bytes'] == 9_999_999
        assert layer['geojson']['bytes'] == 30_000_000
        assert layer['fetched_at'] == '2026-05-26T00:00:00+00:00'

    def test_preserves_all_baked_formats_when_none_locally(self):
        """Full scenario: prev had all formats, local has none."""
        from build_catalog import carry_forward_from_prev
        prev = make_prev_layer()
        layer = {'id': 'lgd_states', 'parquet': {'url': 'x', 'bytes': None}, 'pmtiles': {'url': 'x', 'bytes': None}, 'geojson': None, 'kml': None, 'shapefile': None, 'fetched_at': None}
        carry_forward_from_prev(layer, {prev['id']: prev})
        assert layer['parquet']['bytes'] == 7_000_000
        assert layer['pmtiles']['bytes'] == 3_000_000
        assert layer['geojson']['bytes'] == 25_000_000
        assert layer['kml']['bytes'] == 20_000_000
        assert layer['shapefile']['bytes'] == 11_000_000
        assert layer['fetched_at'] is not None

    def test_no_prev_is_noop(self):
        """When no previous catalog entry exists, nothing crashes."""
        from build_catalog import carry_forward_from_prev
        layer = {'id': 'new_layer', 'parquet': {'url': 'x', 'bytes': None}, 'pmtiles': None, 'geojson': None, 'kml': None, 'shapefile': None, 'fetched_at': None}
        carry_forward_from_prev(layer, {})
        assert layer['parquet']['bytes'] is None
        assert layer['geojson'] is None
