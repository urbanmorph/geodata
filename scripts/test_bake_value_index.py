"""bake_value_index: for each low-cardinality text column of a large layer, the row groups
each value is in and how many rows (web/functions/lib/value-index.ts reads it)."""
from __future__ import annotations

import json
from pathlib import Path

import bake_value_index as bvi

FIXTURE = Path(__file__).resolve().parent.parent / 'web' / 'tests' / 'fixtures' / 'value-index.parquet'


def test_index_of_the_fixture_is_the_one_the_web_test_expects():
    # web/tests/value-index.test.ts holds the same index by hand: the two must agree.
    out = bvi.build_index(str(FIXTURE), ['cat', 'status'])
    assert out == {
        'row_groups': 3,
        'rows': 10,
        'columns': {
            'cat': {'values': {'Shop': '0:1,2:1,', 'shop': '0:1,', 'cafe': '0:1,1:3,2:1,', 'museum': '1:1,'}, 'nulls': '0:1,'},
            'status': {'values': {'open': '0:3,1:3,2:1,', 'closed': '0:1,1:1,'}, 'nulls': '2:1,'},
        },
    }


def test_counts_are_hex():
    assert bvi.encode([(0, 1), (10, 255), (300, 4096)]) == '0:1,a:ff,12c:1000,'


def test_indexable_columns_are_flat_text_with_few_values_on_large_layers():
    stats = {
        'row_count': 500_000,
        'columns': [
            {'name': 'cat', 'distinct': 263}, {'name': 'name', 'distinct': 400_000},
            {'name': 'status', 'distinct': 3}, {'name': 'n', 'distinct': 10}, {'name': 'empty', 'distinct': 0},
        ],
        'schema': [
            {'name': 'cat', 'type': 'BYTE_ARRAY', 'converted_type': 'UTF8'},
            {'name': 'name', 'type': 'BYTE_ARRAY', 'converted_type': 'UTF8'},
            {'name': 'status', 'type': 'BYTE_ARRAY', 'converted_type': 'UTF8'},
            {'name': 'n', 'type': 'INT32'},
            {'name': 'empty', 'type': 'BYTE_ARRAY', 'converted_type': 'UTF8'},
            {'name': 'names', 'nested': True},
        ],
    }
    assert bvi.indexable_columns(stats) == ['cat', 'status']
    assert bvi.indexable_columns({**stats, 'row_count': 1000}) == []


def test_fresh_only_while_baked_from_the_catalogs_parquet_with_the_same_columns(tmp_path):
    layer = {'id': 'x', 'parquet': {'url': 'https://r2/x.parquet', 'bytes': 10}}
    p = tmp_path / 'x.json'
    assert not bvi.is_fresh(p, layer, ['cat'])
    p.write_text(json.dumps({'parquet': {'url': 'https://r2/x.parquet', 'bytes': 10}, 'row_groups': 1, 'rows': 1,
                             'columns': {'cat': {'values': {}}}}))
    assert bvi.is_fresh(p, layer, ['cat'])
    assert not bvi.is_fresh(p, layer, ['cat', 'status'])  # a column now indexable is missing
    assert not bvi.is_fresh(p, {**layer, 'parquet': {'url': 'https://r2/x.parquet', 'bytes': 11}}, ['cat'])
