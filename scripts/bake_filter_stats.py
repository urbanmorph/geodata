#!/usr/bin/env python3
"""
Column stats for every curated layer with a parquet, one static file each:
web/public/api-data/filter-stats/<id>.json (kept out of catalog.json, which
every visitor downloads).

Two readers:
  - /api/v1/layers/{id}/schema answers from the file (columns, types, values)
    instead of sampling the parquet on R2 on every edge-cache miss, while the
    file's `parquet` (url and bytes) still matches the catalog's.
  - the viewer's Filter panel, for a layer over LARGE_FILTER_BYTES
    (shared/large-load.mjs): such a layer is never opened in the browser, so
    its columns and chips come from the file. Smaller layers keep the
    browser's probe.

Each file records the parquet it came from (url and bytes) and its top-level
columns with their parquet types. The parquet is read straight from its
public R2 URL (DuckDB range requests; nothing is downloaded to disk). Each
file is written as soon as it is done, so a killed run keeps what it
finished; a file whose parquet still matches the catalog is skipped, so a
second run does no work. web/tests/baked-schema.test.ts fails when a file is
missing or stale. Stats a large layer still has in catalog.json are dropped
from it (the file has them).

Run:
    python3 -u scripts/bake_filter_stats.py                 # every missing or stale layer
    python3 -u scripts/bake_filter_stats.py --minutes 60
"""
from __future__ import annotations

import json
import math
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from pipeline import log  # noqa: E402
import build_filter_stats as fs  # noqa: E402
from pipeline import atomic_output, write_json  # noqa: E402

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
STATS_DIR = ROOT / 'web' / 'public' / 'api-data' / 'filter-stats'
SHARED_RULE = ROOT / 'shared' / 'large-load.mjs'


def large_filter_bytes(src: Path = SHARED_RULE) -> int:
    """LARGE_FILTER_BYTES from shared/large-load.mjs (a product of integers),
    read from the one source so the panel and this script never drift."""
    m = re.search(r'LARGE_FILTER_BYTES\s*=\s*([\d\s*]+);', src.read_text())
    if not m:
        raise ValueError(f'LARGE_FILTER_BYTES not found in {src}')
    n = 1
    for factor in m[1].split('*'):
        n *= int(factor)
    return n


def large_layers(catalog: dict, threshold: int) -> list[dict]:
    """Layers with a parquet over the threshold, in catalog order."""
    return [layer for layer in catalog['layers']
            if (layer.get('parquet') or {}).get('url')
            and ((layer.get('parquet') or {}).get('bytes') or 0) > threshold]


def curated_layers(catalog: dict) -> list[dict]:
    """Layers with a parquet, community ones (c_*) left out: /schema reads those live."""
    return [layer for layer in catalog['layers']
            if (layer.get('parquet') or {}).get('url') and not layer['id'].startswith('c_')]


def source_of(layer: dict) -> dict:
    """The parquet a stats file is baked from, as the catalog names it."""
    return {'url': layer['parquet']['url'], 'bytes': layer['parquet'].get('bytes')}


def incomplete(stats: dict) -> list[str]:
    """What a stats file lacks: a column of the schema with no stats, or a
    column of 1 to FACET_THRESHOLD values without its top values. A read that
    failed (an R2 429, a dropped connection) is logged and left out by
    build_filter_stats, so this is how such a run is caught."""
    by = {c['name']: c for c in stats.get('columns', [])}
    out = []
    for s in stats.get('schema', []):
        c = by.get(s['name'])
        if c is None:
            out.append(f"{s['name']}: no stats")
        elif 1 <= c.get('distinct', -1) <= fs.FACET_THRESHOLD and not c.get('top_values'):
            out.append(f"{s['name']}: no top values")
    return out


def is_fresh(path: Path, layer: dict) -> bool:
    """The file exists, is strict JSON and complete, and was baked from the catalog's parquet."""
    def bare(c: str):
        raise ValueError(f'bare {c} is not JSON')
    try:
        baked = json.loads(path.read_text(), parse_constant=bare)
    except (OSError, ValueError):
        return False
    return 'schema' in baked and baked.get('parquet') == source_of(layer) and not incomplete(baked)


def _json_safe(v):
    """NaN and infinities as the text Python prints them ('NaN', 'Infinity'):
    bare, they are not JSON, and the API and the viewer could not read the file."""
    if isinstance(v, float) and not math.isfinite(v):
        return json.dumps(v)
    if isinstance(v, dict):
        return {k: _json_safe(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_json_safe(x) for x in v]
    return v


def write_stats(path: Path, stats: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with atomic_output(path) as part:
        part.write_text(json.dumps(_json_safe(stats), default=str, separators=(',', ':'), allow_nan=False) + '\n')


def bake(catalog_path: Path = CATALOG, stats_dir: Path = STATS_DIR, threshold: int | None = None,
         minutes: float = 600) -> list[str]:
    """A stats file for each curated parquet layer whose file is missing or
    stale. Returns the ids computed."""
    threshold = large_filter_bytes() if threshold is None else threshold
    catalog = json.loads(catalog_path.read_text())
    in_catalog = catalog.get('filter_stats') or {}
    moved = [layer['id'] for layer in large_layers(catalog, threshold) if layer['id'] in in_catalog]
    if moved:
        catalog['filter_stats'] = {k: v for k, v in in_catalog.items() if k not in set(moved)}
        write_json(catalog_path, catalog)
        log(f'dropped {len(moved)} large layer(s) from the catalog\'s filter_stats: {", ".join(moved)}')

    end = time.monotonic() + minutes * 60
    done = []
    todo = [layer for layer in curated_layers(catalog) if not is_fresh(stats_dir / f"{layer['id']}.json", layer)]
    log(f'{len(todo)} layer(s) to bake ({sum(layer["parquet"].get("bytes") or 0 for layer in todo) / 1e9:,.2f} GB of parquet)')
    for i, layer in enumerate(todo, 1):
        if time.monotonic() >= end:
            log(f'STOPPED: time limit; {len(todo) - i + 1} layer(s) left, re-run to continue')
            break
        lid, url = layer['id'], layer['parquet']['url']
        log(f'[{i}/{len(todo)}] {lid} ({(layer["parquet"].get("bytes") or 0) / 1e6:,.1f} MB)')
        t0 = time.monotonic()
        stats = fs.build_all([(lid, url)]).get(lid)
        if stats is None:
            log(f'  {lid}: no stats (parquet unreadable); skipped')
            continue
        stats['schema'] = fs.parquet_columns(fs.connect(url), url)
        stats['parquet'] = source_of(layer)
        missing = incomplete(stats)
        if missing:
            log(f'  {lid}: NOT saved, incomplete ({"; ".join(missing)}); re-run to retry')
            continue
        write_stats(stats_dir / f'{lid}.json', stats)
        done.append(lid)
        log(f'  {lid}: saved in {time.monotonic() - t0:,.0f} s')
    return done


def main(argv: list[str]) -> int:
    args = argv[1:]
    minutes = float(args[args.index('--minutes') + 1]) if '--minutes' in args else 600.0
    baked = bake(minutes=minutes)
    log(f'baked {len(baked)} layer(s): {", ".join(baked) or "none"}')
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(line_buffering=True)
    sys.exit(main(sys.argv))
