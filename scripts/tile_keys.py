"""Map tiles and parquet bharatlas rebaked itself, recognised by their key.

rebake_tiles.py publishes <stem>.<md5[:8]>.pmtiles, rebake_locate_tiles.py
<stem>.z<N>.pmtiles and rebake_layer.py <stem>.<md5[:8]>.parquet; the old
upstream-named keys are deleted after deploy. build_catalog.py and
ingest_ramseraph.py template these URLs from the upstream file name, so they
keep a rebaked block instead (pinned by test_tile_keys.py).
"""
from __future__ import annotations

import re

FORMATS = ('pmtiles', 'parquet')
REBAKED_KEY = {
    'pmtiles': re.compile(r'\.(?:[0-9a-f]{8}|z\d+)\.pmtiles$'),
    'parquet': re.compile(r'\.[0-9a-f]{8}\.parquet$'),
}
REBAKE_SUFFIX = re.compile(r'\.(?:[0-9a-f]{8}|z\d+)(?=\.(?:pmtiles|parquet)$)')


def is_rebaked(block: dict | None, fmt: str = 'pmtiles') -> bool:
    """True when a catalog `fmt` block points at a file bharatlas rebaked."""
    return bool(block and REBAKED_KEY[fmt].search(block.get('url') or ''))


def keep_rebaked(layer: dict, prev: dict | None, fmt: str) -> bool:
    """If the previous entry's `fmt` block was rebaked, put it back on `layer`
    (mutates it) and return True; otherwise leave `layer` alone."""
    prev_block = (prev or {}).get(fmt)
    if not is_rebaked(prev_block, fmt):
        return False
    layer[fmt] = dict(prev_block)
    return True


def keep_all_rebaked(layer: dict, prev: dict | None) -> list[str]:
    """keep_rebaked for every format; returns the formats kept."""
    return [fmt for fmt in FORMATS if keep_rebaked(layer, prev, fmt)]


def unversioned_name(url: str) -> str:
    """The file name a rebaked key was made from (LGD_States.0a1b2c3d.parquet
    -> LGD_States.parquet): local source copies keep the upstream name."""
    return REBAKE_SUFFIX.sub('', url.rsplit('/', 1)[-1])
