"""Tests for the pure parts of bake_corestack_lulc.py: derived columns per block
and the shapefile short-name mapping.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_corestack_lulc.py -q
"""
import pytest

from bake_corestack_lulc import (
    CLASS_COLS,
    OUTPUT_COLUMNS,
    SHP_NAMES,
    check_class5_share,
    derive_row,
)

HA = 10_000  # m² per hectare


def classes(**ha):
    """Build an EE result dict {cN: m²} from hectares keyed like c8=12.5."""
    return {k: v * HA for k, v in ha.items()}


class TestDeriveRow:
    def test_class_hectares_rounded_to_2dp(self):
        r = derive_row(classes(c1=1.23456, c6=10), block_area_ha=20)
        assert r['built_up_ha'] == 1.23
        assert r['trees_ha'] == 10.0

    def test_mapped_area_sums_all_classes_except_background(self):
        r = derive_row(classes(c0=5, c1=2, c6=3, c10=5), block_area_ha=10)
        assert r['mapped_area_ha'] == 10.0          # c0 background is not mapped land cover

    def test_cropland_is_intensity_classes_8_to_11(self):
        r = derive_row(classes(c8=1, c9=2, c10=3, c11=4, c6=90), block_area_ha=100)
        assert r['cropland_ha'] == 10.0
        assert r['cropland_pct'] == 10.0

    def test_cropping_intensity_index(self):
        # (1*(single_kharif + single_nonkharif) + 2*double + 3*triple) / cropland
        r = derive_row(classes(c8=10, c9=10, c10=20, c11=10), block_area_ha=50)
        assert r['cropping_intensity_index'] == pytest.approx((1 * 20 + 2 * 20 + 3 * 10) / 50, abs=1e-3)

    def test_intensity_is_null_without_cropland(self):
        r = derive_row(classes(c6=10), block_area_ha=10)
        assert r['cropland_ha'] == 0.0
        assert r['cropping_intensity_index'] is None

    def test_class_shares_are_of_mapped_area(self):
        r = derive_row(classes(c1=25, c6=75), block_area_ha=200)
        assert r['built_up_pct'] == 25.0
        assert r['trees_pct'] == 75.0
        assert r['mapped_pct'] == 50.0             # mapped_pct is of the whole block

    def test_no_coverage_block_has_null_shares_not_divide_by_zero(self):
        # Islands: IndiaSAT has no data, so nothing is mapped.
        r = derive_row({}, block_area_ha=1234.5)
        assert r['mapped_area_ha'] == 0.0
        assert r['mapped_pct'] == 0.0
        assert r['trees_ha'] == 0.0
        assert r['trees_pct'] is None
        assert r['cropping_intensity_index'] is None

    def test_mapped_pct_capped_at_100(self):
        # Zonation used ~11 m simplified boundaries: tiny overshoots (<0.2%) happen.
        r = derive_row(classes(c6=100.16), block_area_ha=100)
        assert r['mapped_pct'] == 100.0

    def test_zero_block_area_gives_null_mapped_pct(self):
        assert derive_row(classes(c6=1), block_area_ha=0)['mapped_pct'] is None

    def test_class_5_counts_as_cropland_but_not_intensity(self):
        # Class 5 = "Crops" with no intensity assigned (0.73 ha nationally in
        # v4 2023-24). It is cropland and mapped land, so its area is kept, but it
        # has no single/double/triple label, so the index ignores it.
        r = derive_row(classes(c5=1, c8=1), block_area_ha=2)
        assert r['cropland_ha'] == 2.0
        assert r['mapped_area_ha'] == 2.0
        assert r['cropping_intensity_index'] == 1.0

    def test_only_class_5_cropland_gives_null_intensity(self):
        r = derive_row(classes(c5=1), block_area_ha=1)
        assert r['cropland_ha'] == 1.0
        assert r['cropping_intensity_index'] is None

    def test_unknown_class_fails_loudly(self):
        with pytest.raises(ValueError, match='c14'):
            derive_row(classes(c14=1), block_area_ha=1)

    def test_row_has_exactly_the_output_columns(self):
        r = derive_row(classes(c6=1), block_area_ha=1)
        assert list(r) == [c for c in OUTPUT_COLUMNS if c in r]
        assert set(r) <= set(OUTPUT_COLUMNS)


class TestClass5Tripwire:
    def test_trace_class_5_passes(self):
        check_class5_share(class5_ha=0.73, cropland_ha=149_260_500)  # v4 2023-24 actuals

    def test_material_class_5_fails_loudly(self):
        # A future year where unassigned-intensity cropland is material needs its
        # own column rather than being folded quietly into cropland_ha.
        with pytest.raises(ValueError, match='class 5'):
            check_class5_share(class5_ha=2_000, cropland_ha=100_000)

    def test_no_cropland_is_fine(self):
        check_class5_share(class5_ha=0, cropland_ha=0)


class TestSchema:
    def test_class_5_and_background_have_no_column(self):
        assert 0 not in CLASS_COLS and 5 not in CLASS_COLS

    def test_every_derived_column_is_in_output_columns(self):
        r = derive_row(classes(c1=1, c8=1), block_area_ha=10)
        assert set(r) <= set(OUTPUT_COLUMNS)


class TestMapTiles:
    """Tiles carry only popup fields. With all 37 attributes, tippecanoe's
    size-based dropping kept ~47% of blocks at national zoom (z4), leaving
    holes; the full table stays in Parquet / downloads / API."""

    def test_tile_fields_are_real_output_columns(self):
        from bake_corestack_lulc import TILE_FIELDS
        assert set(TILE_FIELDS) <= set(OUTPUT_COLUMNS)

    def test_tile_fields_identify_the_block_and_stay_small(self):
        from bake_corestack_lulc import TILE_FIELDS
        assert {'block_name', 'district', 'state'} <= set(TILE_FIELDS)
        assert len(TILE_FIELDS) <= 13

    def test_tippecanoe_includes_only_tile_fields(self):
        from pathlib import Path
        from bake_corestack_lulc import TILE_FIELDS, pmtiles_args
        args = pmtiles_args(Path('in.geojson'), Path('out.pmtiles'))
        included = [args[i + 1] for i, a in enumerate(args) if a == '-y']
        assert included == list(TILE_FIELDS)
        assert '-x' not in args
        assert args[-1] == 'in.geojson'


class TestShapefileNames:
    def test_every_output_column_has_a_short_name(self):
        assert set(SHP_NAMES) == set(OUTPUT_COLUMNS)

    def test_short_names_fit_dbf_10_char_limit(self):
        too_long = {k: v for k, v in SHP_NAMES.items() if len(v) > 10}
        assert not too_long

    def test_short_names_are_unique_case_insensitively(self):
        lowered = [v.lower() for v in SHP_NAMES.values()]
        assert len(lowered) == len(set(lowered))
