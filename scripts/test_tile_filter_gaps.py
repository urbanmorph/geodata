"""Tests for scripts/tile_filter_gaps.py (the pure parts)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tile_filter_gaps as g  # noqa: E402


def test_unseen_columns_are_offerable_columns_the_tiles_lack():
    schema = [('name', 'VARCHAR'), ('corporation', 'VARCHAR'), ('ward_id', 'INTEGER'), ('xmin', 'DOUBLE'),
              ('geometry', 'GEOMETRY'), ('names', 'STRUCT(a VARCHAR)'), ('_x', 'VARCHAR')]
    assert g.unseen_columns(schema, ['name']) == ['corporation']
    assert g.unseen_columns(schema, ['name', 'corporation']) == []


def test_missing_columns_are_filter_columns_not_in_the_tiles():
    stats = {'row_count': 369, 'columns': [
        {'name': 'corporation', 'type': 'string', 'distinct': 5, 'null_frac': 0},
        {'name': 'zone', 'type': 'string', 'distinct': 20, 'null_frac': 0},
        {'name': 'ward_name', 'type': 'string', 'distinct': 369, 'null_frac': 0}]}
    assert g.missing_columns(['zone', 'ward_name'], stats) == ['corporation']
    assert g.missing_columns(['zone', 'corporation'], stats) == []
