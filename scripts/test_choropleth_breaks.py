"""Choropleth breaks for value layers: equal-count classes, rounded, patched
into catalog.json in place.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_choropleth_breaks.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import choropleth_breaks as m  # noqa: E402


def test_nice_round_keeps_two_significant_figures():
    assert m.nice_round(3027.95) == 3000
    assert m.nice_round(6596.9) == 6600
    assert m.nice_round(1.868) == 1.9
    assert m.nice_round(238998617) == 240000000
    assert m.nice_round(0) == 0


def test_breaks_are_rounded_quantiles_strictly_above_the_minimum():
    assert m.breaks_from([21.0, 41.0, 60.4, 80.2], minimum=1) == [21, 41, 60, 80]
    # Ties and rounding collapse classes rather than repeat a break.
    assert m.breaks_from([1.0, 1.0, 1.0, 1.2], minimum=1) == [1.2]
    assert m.breaks_from([5.0, 5.0, 5.0], minimum=5) == []
    # Whole numbers stay ints, so the JSON reads 3000, not 3000.0.
    assert all(isinstance(b, int) for b in m.breaks_from([3027.9, 6596.8], minimum=0))


def test_every_value_layer_names_a_column_label_and_unit():
    for lid, cfg in m.CHOROPLETH_LAYERS.items():
        assert set(cfg) == {'column', 'label', 'unit'}, lid
        assert all(cfg.values()), lid


def _catalog():
    return {'layers': [
        {'id': 'mgnrega_districts', 'source': 'MoRD'},
        {'id': 'lgd_states', 'source': 'LGD'},
    ]}


def test_patch_sets_the_block_and_leaves_other_layers_alone():
    cat = _catalog()
    changed = m.patch_catalog(cat, {'mgnrega_districts': [3000, 6600]})
    assert changed == ['mgnrega_districts']
    block = cat['layers'][0]['choropleth']
    assert block == {**m.CHOROPLETH_LAYERS['mgnrega_districts'], 'breaks': [3000, 6600]}
    assert 'choropleth' not in cat['layers'][1]


def test_patch_twice_changes_nothing():
    cat = _catalog()
    m.patch_catalog(cat, {'mgnrega_districts': [3000, 6600]})
    before = json.dumps(cat)
    assert m.patch_catalog(cat, {'mgnrega_districts': [3000, 6600]}) == []
    assert json.dumps(cat) == before


def test_patch_skips_layers_missing_from_the_catalog():
    cat = {'layers': []}
    assert m.patch_catalog(cat, {'mgnrega_districts': [1, 2]}) == []
