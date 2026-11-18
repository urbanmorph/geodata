#!/usr/bin/env python3
"""
List the layers whose map tiles lack a column the Filter panel filters on.

When the filtered column isn't in the tiles the map can't draw the filter: it
shows every feature while the count says "112 of 369". For each catalog layer
with a parquet (the Filter panel needs one) and tiles:

  1. the tile fields, from the PMTiles header and metadata (two HTTP range
     reads of the public R2 file)
  2. the parquet's columns (DESCRIBE reads only its footer); a layer whose
     tiles carry every column the panel could offer has no gap
  3. otherwise the panel's columns: the catalog's baked filter_stats, else
     the stats the viewer's live probe computes (a scan of the parquet), then
     build_filter_stats.tile_filter_columns; missing = those not in the tiles

Each layer's answer is cached under WORK by its tile and parquet URLs, so a
re-run (or one after a kill) redoes nothing it finished; the cache is
written after every layer.

Run:
    python3 -u scripts/tile_filter_gaps.py                 # every layer
    python3 -u scripts/tile_filter_gaps.py wards_bengaluru_gba
Prints one line per layer with a gap, then the ids (feed them to rebake_tiles.py).
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import audit_tiles as at  # noqa: E402
from build_filter_stats import is_unoffered_name, normalise_type, stats_for_parquet, tile_filter_columns  # noqa: E402
from pipeline import make_con, write_json  # noqa: E402

ROOT = HERE.parent
WORK = Path(os.environ.get('TILES_WORK', '/tmp/bharatlas-tiles')) / 'filter-gaps'


def unseen_columns(schema: list[tuple[str, str]], tile_fields: list[str]) -> list[str]:
    """Parquet columns the panel could offer that the tiles don't carry."""
    have = set(tile_fields)
    return [c for c, t in schema if c not in have and not is_unoffered_name(c)
            and normalise_type(t) not in ('geometry', 'blob')]


def missing_columns(tile_fields: list[str], stats: dict) -> list[str]:
    """The panel's tile columns (tile_filter_columns) the tiles lack."""
    have = set(tile_fields)
    return [c for c in tile_filter_columns(stats) if c not in have]


def layer_gap(layer: dict, baked: dict | None, con) -> dict:
    pm, pq = layer['pmtiles']['url'], layer['parquet']['url']
    fields = at.archive_fields(at.http_reader(pm))
    schema = [(r[0], r[1]) for r in con.execute(f"DESCRIBE SELECT * FROM '{pq}' LIMIT 0").fetchall()]
    out = {'pmtiles': pm, 'parquet': pq, 'tile_fields': fields, 'missing': []}
    if baked or unseen_columns(schema, fields):
        stats = baked or stats_for_parquet(pq, con, probe=True)
        out['missing'] = missing_columns(fields, stats) if stats else []
        out['filter_columns'] = tile_filter_columns(stats) if stats else []
    return out


def main(argv: list[str]) -> int:
    ids = [a for a in argv[1:] if not a.startswith('--')]
    catalog = json.loads((ROOT / 'catalog.json').read_text())
    layers = [x for x in catalog['layers'] if (x.get('parquet') or {}).get('url')
              and (x.get('pmtiles') or {}).get('url') and (not ids or x['id'] in ids)]
    WORK.mkdir(parents=True, exist_ok=True)
    con = make_con()
    gaps = []
    for i, layer in enumerate(layers, 1):
        lid = layer['id']
        key = hashlib.md5(f"{layer['pmtiles']['url']} {layer['parquet']['url']}".encode()).hexdigest()[:12]
        cache = WORK / f'{lid}.{key}.json'
        if cache.exists():
            r = json.loads(cache.read_text())
        else:
            try:
                r = layer_gap(layer, catalog.get('filter_stats', {}).get(lid), con)
            except Exception as e:  # noqa: BLE001  one layer's failure never stops the sweep
                print(f'[{i}/{len(layers)}] ERR  {lid}: {type(e).__name__}: {e}', flush=True)
                continue
            part = cache.with_suffix('.part')
            write_json(part, r)
            part.replace(cache)  # atomic: a killed run never leaves half an answer
        mark = 'GAP ' if r['missing'] else 'ok  '
        print(f"[{i}/{len(layers)}] {mark}{lid}" + (f"  missing {r['missing']}" if r['missing'] else ''),
              flush=True)
        if r['missing']:
            gaps.append(lid)
    print(f'\n{len(gaps)} of {len(layers)} layers lack a filter column in their tiles:')
    print(' '.join(gaps))
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(line_buffering=True)
    sys.exit(main(sys.argv))
