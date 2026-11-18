#!/usr/bin/env python3
"""
Filter stats for every layer the Filter panel filters on the API.

A layer whose parquet is over LARGE_FILTER_BYTES (shared/large-load.mjs) is
never opened in the browser: the panel's columns, chips and counts come from
catalog.json `filter_stats` and the API. This bakes those stats for each such
layer that has none, reading the parquet straight from its public R2 URL
(DuckDB range requests; nothing is downloaded to disk), and patches the
repo-root catalog.json in place after each layer, so a killed run keeps what
it finished and a second run does no work.

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
from pipeline import write_json  # noqa: E402

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
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


def targets(catalog: dict, threshold: int) -> list[dict]:
    """Layers over the threshold with a parquet and no baked stats, in catalog order."""
    have = catalog.get('filter_stats') or {}
    return [layer for layer in catalog['layers']
            if (layer.get('parquet') or {}).get('url')
            and ((layer.get('parquet') or {}).get('bytes') or 0) > threshold
            and layer['id'] not in have]


def bake(catalog_path: Path = CATALOG, threshold: int | None = None, minutes: float = 600) -> list[str]:
    """Stats for each target, saved to the catalog after each layer. Returns the ids baked."""
    threshold = large_filter_bytes() if threshold is None else threshold
    end = time.monotonic() + minutes * 60
    done = []
    todo = targets(json.loads(catalog_path.read_text()), threshold)
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
        c = json.loads(catalog_path.read_text())  # re-read: never overwrite a concurrent patch
        c.setdefault('filter_stats', {})[lid] = json.loads(json.dumps(stats, default=str))
        write_json(catalog_path, c)
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
