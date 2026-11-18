"""Map tiles bharatlas rebaked itself, recognised by their key.

rebake_tiles.py publishes <stem>.<md5[:8]>.pmtiles and rebake_locate_tiles.py
<stem>.z<N>.pmtiles; the old upstream-named keys are deleted after deploy.
build_catalog.py and ingest_ramseraph.py template the tile URL from the upstream
file name, so they keep a rebaked block instead (pinned by test_tile_keys.py).
"""
from __future__ import annotations

import re

REBAKED_KEY = re.compile(r'\.(?:[0-9a-f]{8}|z\d+)\.pmtiles$')


def is_rebaked(block: dict | None) -> bool:
    """True when a catalog pmtiles block points at tiles bharatlas rebaked."""
    return bool(block and REBAKED_KEY.search(block.get('url') or ''))


def keep_rebaked_pmtiles(layer: dict, prev: dict | None) -> bool:
    """If the previous entry's tiles were rebaked, put that block back on
    `layer` (mutates it) and return True; otherwise leave `layer` alone."""
    prev_block = (prev or {}).get('pmtiles')
    if not is_rebaked(prev_block):
        return False
    layer['pmtiles'] = dict(prev_block)
    return True
