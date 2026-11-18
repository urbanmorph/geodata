#!/usr/bin/env python3
"""
Filter stats for every layer the Filter panel filters on the API.

A layer whose parquet is over LARGE_FILTER_BYTES (shared/large-load.mjs) is
never opened in the browser: the panel's columns and chips come from a static
file, web/public/api-data/filter-stats/<id>.json (fetched when the panel
opens; kept out of catalog.json, which every visitor downloads), and its
counts and exports from the API. This writes that file for each such layer
that has none, reading the parquet straight from its public R2 URL (DuckDB
range requests; nothing is downloaded to disk). Stats a large layer still has
in catalog.json are moved to its file. Each file is written as soon as it is
done, so a killed run keeps what it finished and a second run does no work.

Run:
    python3 -u scripts/bake_large_filter_stats.py            # every large layer without stats
    python3 -u scripts/bake_large_filter_stats.py --minutes 60
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_filter_stats as fs  # noqa: E402
from pipeline import atomic_output, write_json  # noqa: E402

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
STATS_DIR = ROOT / 'web' / 'public' / 'api-data' / 'filter-stats'
SHARED_RULE = ROOT / 'shared' / 'large-load.mjs'


def log(*msg: object) -> None:
    print(*msg, flush=True)


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


def write_stats(path: Path, stats: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with atomic_output(path) as part:
        part.write_text(json.dumps(stats, default=str, separators=(',', ':')) + '\n')


def bake(catalog_path: Path = CATALOG, stats_dir: Path = STATS_DIR, threshold: int | None = None,
         minutes: float = 600) -> list[str]:
    """A stats file for each large layer without one (moved from the catalog
    when it is there, else computed). Returns the ids computed."""
    threshold = large_filter_bytes() if threshold is None else threshold
    catalog = json.loads(catalog_path.read_text())
    large = large_layers(catalog, threshold)
    in_catalog = catalog.get('filter_stats') or {}
    moved = [layer['id'] for layer in large if layer['id'] in in_catalog]
    for lid in moved:
        if not (stats_dir / f'{lid}.json').exists():
            write_stats(stats_dir / f'{lid}.json', in_catalog[lid])
    if moved:
        catalog['filter_stats'] = {k: v for k, v in in_catalog.items() if k not in set(moved)}
        write_json(catalog_path, catalog)
        log(f'moved {len(moved)} layer(s) out of the catalog: {", ".join(moved)}')

    end = time.monotonic() + minutes * 60
    done = []
    todo = [layer for layer in large if not (stats_dir / f"{layer['id']}.json").exists()]
    for i, layer in enumerate(todo, 1):
        if time.monotonic() > end:
            log(f'STOPPED: time limit; {len(todo) - i + 1} layer(s) left, re-run to continue')
            break
        lid, url = layer['id'], layer['parquet']['url']
        log(f'[{i}/{len(todo)}] {lid} ({layer["parquet"]["bytes"] / 1e6:,.0f} MB)')
        t0 = time.monotonic()
        stats = fs.build_all([(lid, url)]).get(lid)
        if stats is None:
            log(f'  {lid}: no stats (parquet unreadable); skipped')
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
