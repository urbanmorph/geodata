"""Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_build_filter_stats.py -q"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_filter_stats import normalise_type  # noqa: E402


@pytest.mark.parametrize('t', ['STRUCT("primary" VARCHAR)', 'VARCHAR[]', 'MAP(VARCHAR, VARCHAR)',
                               'STRUCT(a INTEGER)[]', 'INTEGER[3]', 'UNION(a INTEGER, b VARCHAR)'])
def test_nested_types_are_blob_not_searchable_strings(t):
    # Mirrors web/src/filter-probe.ts: nested values can't be filtered.
    assert normalise_type(t) == 'blob'


@pytest.mark.parametrize('t,norm', [('VARCHAR', 'string'), ('DECIMAL(18,2)', 'float'),
                                    ('BIGINT', 'int'), ('GEOMETRY', 'geometry')])
def test_flat_types_unchanged(t, norm):
    assert normalise_type(t) == norm
