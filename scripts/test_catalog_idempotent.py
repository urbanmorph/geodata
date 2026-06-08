"""Tests that build_catalog.py preserves existing catalog.json fields
when local baked files are absent, AND that ingest_ramseraph.py's
catalog patch is idempotent under re-runs.

Run: python3 -m pytest scripts/test_catalog_idempotent.py -v"""
import copy
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

    def test_preserves_tags(self):
        """Per-layer search tags survive a rebuild even when the freshly-built
        layer dict omits them (e.g. patched directly into catalog.json)."""
        from build_catalog import carry_forward_from_prev
        prev = make_prev_layer(tags=['groundwater', 'aquifer', 'water table'])
        layer = {'id': 'lgd_states', 'parquet': {'url': 'x', 'bytes': None}, 'pmtiles': None, 'geojson': None, 'kml': None, 'shapefile': None, 'fetched_at': None}
        carry_forward_from_prev(layer, {prev['id']: prev})
        assert layer['tags'] == ['groundwater', 'aquifer', 'water table']

    def test_does_not_clobber_existing_tags(self):
        from build_catalog import carry_forward_from_prev
        prev = make_prev_layer(tags=['old'])
        layer = {'id': 'lgd_states', 'parquet': {'url': 'x', 'bytes': None}, 'pmtiles': None, 'geojson': None, 'kml': None, 'shapefile': None, 'fetched_at': None, 'tags': ['new']}
        carry_forward_from_prev(layer, {prev['id']: prev})
        assert layer['tags'] == ['new']

    def test_preserves_parquet_upstream_url(self):
        """ramSeraph-republished layers carry an upstream_url pointing at a
        ramSeraph release. A rebuild would otherwise template upstream_url to
        the yashveer base. Carry-forward keeps the original source-of-truth."""
        from build_catalog import carry_forward_from_prev
        prev = make_prev_layer(
            layer_id='vedas_power_plants',
            parquet={
                'url': 'https://r2.example/infra/vedas-power-plants/Vedas_Power_Plants.parquet',
                'upstream_url': 'https://github.com/ramSeraph/indian_power_infra/releases/download/power-sources/Vedas_Power_Plants.parquet',
                'bytes': 31_559,
            },
        )
        layer = {
            'id': 'vedas_power_plants',
            'parquet': {
                'url': 'https://r2.example/infra/vedas-power-plants/Vedas_Power_Plants.parquet',
                'upstream_url': 'https://github.com/yashveeeeeeer/india-geodata/releases/download/infra/vedas-power-plants/Vedas_Power_Plants.parquet',
                'bytes': 31_559,
            },
            'pmtiles': None, 'geojson': None, 'kml': None, 'shapefile': None, 'fetched_at': None,
        }
        carry_forward_from_prev(layer, {prev['id']: prev})
        assert layer['parquet']['upstream_url'].startswith('https://github.com/ramSeraph/'), \
            f"upstream_url not carried forward: {layer['parquet']['upstream_url']}"

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


# ─────────────────────────────────────────────────────────────────────
# ingest_ramseraph.py — round-trip stability of merge_layer_into_catalog.
# This is the seam that the Wave 1+2 deploys hit a bug on (level_order
# not appended). The tests below assert that the merge is stable when
# applied twice to the same input — the second call must be a no-op.
# ─────────────────────────────────────────────────────────────────────


def _ds(over=None):
    from ingest_ramseraph import Dataset
    base = dict(
        id='test_layer',
        name='Test Layer (2026)',
        level='test_layer',
        category='environment',
        source='CWC',
        description='A test layer for unit testing merge_layer_into_catalog.',
        unit='features',
        license='CC0-1.0',
        r2_prefix='environment/test-layer',
        parquet_url='https://github.com/ramSeraph/x/releases/download/y/Test.parquet',
        pmtiles_url='https://github.com/ramSeraph/x/releases/download/y/Test.pmtiles',
        source_url='https://example.gov.in/',
        source_org='Test Org',
        notes='compiled by ramSeraph from upstream',
    )
    base.update(over or {})
    return Dataset(**base)


class TestMergeIdempotent:
    """ingest_ramseraph.merge_layer_into_catalog: applying it twice to the
    same input must produce the same output — no creeping arrays, no
    accumulating duplicates, no rewriting of preserved fields."""

    def test_first_call_populates_empty_catalog(self):
        from ingest_ramseraph import merge_layer_into_catalog
        c = {}
        merge_layer_into_catalog(c, _ds(), 100, 200, 50)
        assert len(c['layers']) == 1
        assert c['layers'][0]['id'] == 'test_layer'
        assert c['level_meta']['test_layer']['label'] == 'Test Layer (2026)'
        assert c['level_order'] == ['test_layer']

    def test_double_application_is_a_no_op(self):
        """Round trip: apply once, snapshot, apply again, assert equality."""
        from ingest_ramseraph import merge_layer_into_catalog
        c = {}
        merge_layer_into_catalog(c, _ds(), 100, 200, 50)
        first = copy.deepcopy(c)
        merge_layer_into_catalog(c, _ds(), 100, 200, 50)
        assert c == first, 'second merge mutated the catalog (not idempotent)'

    def test_layers_array_does_not_grow_on_re_run(self):
        """Re-running the same Dataset must not append a duplicate layer."""
        from ingest_ramseraph import merge_layer_into_catalog
        c = {}
        for _ in range(5):
            merge_layer_into_catalog(c, _ds(), 100, 200, 50)
        assert len(c['layers']) == 1
        assert sum(1 for l in c['layers'] if l['id'] == 'test_layer') == 1

    def test_level_order_does_not_grow_on_re_run(self):
        """The bug that caused Wave 1+2 to ship with 22 hidden layers."""
        from ingest_ramseraph import merge_layer_into_catalog
        c = {}
        for _ in range(5):
            merge_layer_into_catalog(c, _ds(), 100, 200, 50)
        assert c['level_order'] == ['test_layer'], \
            f'level_order accumulated duplicates: {c["level_order"]}'

    def test_preserved_bakes_survive_re_merge(self):
        """If bake_whole_layer.py has populated geojson/kml/shapefile,
        a fresh ingest without bakes_info should NOT clobber them."""
        from ingest_ramseraph import merge_layer_into_catalog
        baked = {
            'url': 'https://r2.example/environment/test-layer/Test.geojson',
            'bytes': 12345,
        }
        c = {'layers': [{
            'id': 'test_layer',
            'level': 'test_layer',
            'parquet': {'url': 'old', 'bytes': 100},
            'pmtiles': None,
            'geojson': baked,
            'kml': {'url': 'old-kml', 'bytes': 999},
            'shapefile': {'url': 'old-shp', 'bytes': 111},
            'fetched_at': '2026-05-26T00:00:00Z',
        }], 'level_meta': {}, 'level_order': ['test_layer']}
        merge_layer_into_catalog(c, _ds(), 100, 200, 50, bakes_info=None)
        layer = c['layers'][0]
        assert layer['geojson'] == baked, 'geojson bake was overwritten'
        assert layer['kml']['url'] == 'old-kml', 'kml bake was overwritten'
        assert layer['shapefile']['url'] == 'old-shp', 'shapefile bake was overwritten'
        assert layer['fetched_at'] == '2026-05-26T00:00:00Z', 'fetched_at was overwritten'

    def test_fresh_bakes_replace_old_bakes(self):
        """When the ingest re-bakes, fresh outputs win over prev catalog."""
        from ingest_ramseraph import merge_layer_into_catalog
        c = {'layers': [{
            'id': 'test_layer',
            'level': 'test_layer',
            'geojson': {'url': 'old', 'bytes': 1},
        }], 'level_meta': {}, 'level_order': ['test_layer']}
        bakes_info = {'geojson': {'name': 'Test.geojson', 'bytes': 99999}}
        merge_layer_into_catalog(c, _ds(), 100, 200, 50, bakes_info=bakes_info)
        gj = c['layers'][0]['geojson']
        assert gj['bytes'] == 99999, 'fresh bake bytes did not replace old'
        assert 'Test.geojson' in gj['url']

    def test_pmtiles_opt_out_round_trip(self):
        """Some layers (slusi_soil_health) opt out of pmtiles. Stable?"""
        from ingest_ramseraph import merge_layer_into_catalog
        d = _ds({'pmtiles_url': ''})
        c = {}
        merge_layer_into_catalog(c, d, 100, None, 50)
        first = copy.deepcopy(c)
        merge_layer_into_catalog(c, d, 100, None, 50)
        assert c == first
        assert c['layers'][0]['pmtiles'] is None

    def test_two_distinct_layers_do_not_interfere(self):
        """Layer A then layer B then layer A again — order and content stable."""
        from ingest_ramseraph import merge_layer_into_catalog
        a = _ds({'id': 'layer_a', 'level': 'layer_a'})
        b = _ds({'id': 'layer_b', 'level': 'layer_b'})
        c = {}
        merge_layer_into_catalog(c, a, 1, 2, 3)
        merge_layer_into_catalog(c, b, 4, 5, 6)
        snapshot = copy.deepcopy(c)
        merge_layer_into_catalog(c, a, 1, 2, 3)
        assert c['level_order'] == snapshot['level_order'], 'level_order changed'
        assert len(c['layers']) == 2
        assert {l['id'] for l in c['layers']} == {'layer_a', 'layer_b'}
