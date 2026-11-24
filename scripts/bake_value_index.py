#!/usr/bin/env python3
"""
A value index for every large curated layer, one static file each:
web/public/api-data/value-index/<id>.json.

For each flat text column with 1 to MAX_VALUES values (from the layer's filter-stats
file), the row groups each value is in and how many rows ("group:count," in hex), nulls
apart. /api/v1/layers/{id}/query (web/functions/lib/value-index.ts) uses it while it was
baked from the catalog's parquet (same url and bytes): a filter must count every match
for `total`, so without it a query read the filter column of every row group
(overture_places_india, 388 groups: about 15 s for basic_category=hospital, Nov 2026);
with it a one-value filter takes its total from the index and reads only the groups it
needs, and a group_by on the column answers from it.

The parquet is read straight from its public R2 URL (DuckDB range requests, the indexed
columns only). Each file is written as soon as it is done (atomically); a file still
matching the catalog's parquet is skipped, so a second run does no work and a stopped run
continues. web/tests/value-index-fresh.test.ts fails when a file is missing or stale.

Run:
    python3 -u scripts/bake_value_index.py                  # every missing or stale layer
    python3 -u scripts/bake_value_index.py --minutes 60
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from pipeline import atomic_output, log  # noqa: E402
from bake_filter_stats import CATALOG, STATS_DIR, curated_layers, source_of  # noqa: E402

INDEX_DIR = HERE.parent / 'web' / 'public' / 'api-data' / 'value-index'
MIN_ROWS = 200_000   # smaller layers scan every row group in well under a second
MAX_VALUES = 1000    # past this a column's index outweighs the reads it saves


def encode(pairs: list[tuple[int, int]]) -> str:
    """(row group, rows) pairs as "group:rows," in hex."""
    return ''.join(f'{g:x}:{n:x},' for g, n in pairs)


def indexable_columns(stats: dict) -> list[str]:
    """Flat text columns with 1 to MAX_VALUES values, of a layer with MIN_ROWS rows or more."""
    if (stats.get('row_count') or 0) < MIN_ROWS:
        return []
    distinct = {c['name']: c.get('distinct', -1) for c in stats.get('columns', [])}
    out = []
    for s in stats.get('schema', []):
        text = s.get('type') == 'BYTE_ARRAY' and s.get('converted_type') in ('UTF8', 'STRING') and not s.get('nested')
        if text and 1 <= distinct.get(s['name'], -1) <= MAX_VALUES:
            out.append(s['name'])
    return out


def _q(col: str) -> str:
    return '"' + col.replace('"', '""') + '"'


def build_index(url: str, columns: list[str]) -> dict:
    """{'row_groups': n, 'rows': n, 'columns': {col: {'values': {value: pairs}, 'nulls': pairs}}}."""
    con = duckdb.connect()
    if url.startswith('http'):
        con.execute('INSTALL httpfs; LOAD httpfs; SET http_retries = 8; SET http_retry_wait_ms = 2000;')
    src = url.replace("'", "''")
    sizes = con.execute(f"SELECT row_group_id, max(row_group_num_rows) FROM parquet_metadata('{src}') "
                        'GROUP BY row_group_id ORDER BY row_group_id').fetchall()
    con.execute('CREATE TABLE bounds (rg INTEGER, start BIGINT)')
    start, bounds = 0, []
    for rg, n in sizes:
        bounds.append((rg, start))
        start += n
    con.executemany('INSERT INTO bounds VALUES (?, ?)', bounds)
    cols = ', '.join(_q(c) for c in columns)
    con.execute(f"CREATE TABLE t AS SELECT b.rg, {', '.join('r.' + _q(c) for c in columns)} "
                f"FROM (SELECT file_row_number, {cols} FROM read_parquet('{src}', file_row_number = true)) r "
                'ASOF JOIN bounds b ON r.file_row_number >= b.start')
    out: dict = {'row_groups': len(sizes), 'rows': start, 'columns': {}}
    for c in columns:
        log(f'    {c}')
        rows = con.execute(f'SELECT {_q(c)}, rg, count(*) FROM t GROUP BY ALL ORDER BY 1 NULLS FIRST, 2').fetchall()
        values: dict[str, list[tuple[int, int]]] = {}
        nulls: list[tuple[int, int]] = []
        for v, rg, n in rows:
            (nulls if v is None else values.setdefault(v, [])).append((rg, n))
        entry: dict = {'values': {v: encode(p) for v, p in values.items()}}
        if nulls:
            entry['nulls'] = encode(nulls)
        out['columns'][c] = entry
    return out


def is_fresh(path: Path, layer: dict, columns: list[str]) -> bool:
    """The file exists, was baked from the catalog's parquet, and indexes these columns."""
    try:
        baked = json.loads(path.read_text())
    except (OSError, ValueError):
        return False
    return baked.get('parquet') == source_of(layer) and 'rows' in baked and set(baked.get('columns', {})) == set(columns)


def bake(catalog_path: Path = CATALOG, stats_dir: Path = STATS_DIR, index_dir: Path = INDEX_DIR,
         minutes: float = 600) -> tuple[list[str], int]:
    """A value index for each large layer whose file is missing or stale. Returns the ids
    written and how many layers are still to do (failed, stopped or waiting on stats)."""
    catalog = json.loads(catalog_path.read_text())
    todo, left = [], 0
    for layer in curated_layers(catalog):
        try:
            stats = json.loads((stats_dir / f"{layer['id']}.json").read_text())
        except (OSError, ValueError):
            continue
        cols = indexable_columns(stats)
        if not cols or is_fresh(index_dir / f"{layer['id']}.json", layer, cols):
            continue
        if stats.get('parquet') != source_of(layer):
            log(f"{layer['id']}: its filter-stats file is stale; run scripts/bake_filter_stats.py first")
            left += 1
            continue
        todo.append((layer, cols))
    log(f'{len(todo)} layer(s) to index')
    end, done = time.monotonic() + minutes * 60, []
    for i, (layer, cols) in enumerate(todo, 1):
        if time.monotonic() >= end:
            log(f'STOPPED: time limit; {len(todo) - i + 1} layer(s) left, re-run to continue')
            left += len(todo) - i + 1
            break
        lid = layer['id']
        log(f'[{i}/{len(todo)}] {lid}: {", ".join(cols)}')
        t0 = time.monotonic()
        try:
            index = build_index(layer['parquet']['url'], cols)
        except duckdb.Error as e:
            log(f'  {lid}: NOT saved ({e}); re-run to retry')
            left += 1
            continue
        path = index_dir / f'{lid}.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        with atomic_output(path) as part:
            part.write_text(json.dumps({'parquet': source_of(layer), **index}, ensure_ascii=False, separators=(',', ':')) + '\n')
        done.append(lid)
        log(f'  {lid}: {path.stat().st_size / 1e3:,.0f} KB in {time.monotonic() - t0:,.0f} s')
    return done, left


def main(argv: list[str]) -> int:
    args = argv[1:]
    minutes = float(args[args.index('--minutes') + 1]) if '--minutes' in args else 600.0
    done, left = bake(minutes=minutes)
    log(f'indexed {len(done)} layer(s): {", ".join(done) or "none"}; {left} left')
    return 1 if left else 0


if __name__ == '__main__':
    sys.stdout.reconfigure(line_buffering=True)
    sys.exit(main(sys.argv))
