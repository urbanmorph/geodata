"""Content-versioned R2 keys, and the tiles and parquet bharatlas rebaked itself.

Every published file goes to <stem>.<md5[:8]>.<ext> (versioned_key): R2 objects
are served immutable, so a key never gets new bytes; the same content keeps its
key, so a re-run uploads nothing. rebake_tiles.py publishes <stem>.<md5[:8]>.pmtiles,
oneoff/rebake_locate_tiles.py published <stem>.z12.pmtiles (still recognised)
and rebake_layer.py <stem>.<md5[:8]>.parquet.
Old keys stay on R2: a published URL never breaks, and only r2_prune.py prunes
(old tiles only). build_catalog.py, ingest_ramseraph.py and the bakes'
register steps keep a rebaked block while the data under it is unchanged
(keep_rebaked, pinned by test_tile_keys.py).
"""
from __future__ import annotations

import re

FORMATS = ('pmtiles', 'parquet')
REBAKED_KEY = {
    'pmtiles': re.compile(r'\.(?:[0-9a-f]{8}|z\d+)\.pmtiles$'),
    'parquet': re.compile(r'\.[0-9a-f]{8}\.parquet$'),
}
REBAKE_SUFFIX = re.compile(r'\.(?:[0-9a-f]{8}|z\d+)(?=\.(?:pmtiles|parquet)$)')
_VERSIONED = re.compile(
    r'^(.*?)(?:\.[0-9a-f]{8})?\.((?:shp|geojson|kml)\.zip|pmtiles|parquet|geojson|kml|kmz|csv|json|zip|tif)$')


def versioned_key(key: str, md5: str, ext: str | None = None) -> str:
    """<stem>.<md5[:8]>.<ext> for `key` (a key or a file name), replacing an
    earlier version's suffix; `ext` defaults to the key's own."""
    m = _VERSIONED.match(key)
    if not m:
        raise ValueError(f'no known extension: {key}')
    stem, own = m.groups()
    return f'{stem}.{md5[:8]}.{ext or own}'


def is_rebaked(block: dict | None, fmt: str = 'pmtiles') -> bool:
    """True when a catalog `fmt` block points at a file bharatlas rebaked."""
    return bool(block and REBAKED_KEY[fmt].search(block.get('url') or ''))


def data_changed(layer: dict, prev: dict | None) -> bool:
    """True only when both entries name content-versioned parquet keys and they
    differ: new data. An upstream-named or legacy fixed key can't tell, so it
    counts as unchanged (blocks rebaked from it are kept, as before)."""
    new, old = ((x or {}).get('parquet') for x in (layer, prev))
    return is_rebaked(new, 'parquet') and is_rebaked(old, 'parquet') and new['url'] != old['url']


def keep_rebaked(layer: dict, prev: dict | None, fmt: str, changed: bool | None = None) -> bool:
    """If the previous entry's `fmt` block was rebaked and the data under it is
    unchanged, put it back on `layer` (mutates it) and return True; otherwise
    leave `layer` alone (new data makes the bake's own fresh files current)."""
    prev_block = (prev or {}).get(fmt)
    if changed is None:
        changed = data_changed(layer, prev)
    if changed or not is_rebaked(prev_block, fmt):
        return False
    layer[fmt] = dict(prev_block)
    return True


def keep_all_rebaked(layer: dict, prev: dict | None) -> list[str]:
    """keep_rebaked for every format; returns the formats kept."""
    changed = data_changed(layer, prev)  # decided before any block is put back
    return [fmt for fmt in FORMATS if keep_rebaked(layer, prev, fmt, changed)]


def unversioned_name(url: str) -> str:
    """The file name a rebaked key was made from (LGD_States.0a1b2c3d.parquet
    -> LGD_States.parquet): local source copies keep the upstream name."""
    return REBAKE_SUFFIX.sub('', url.rsplit('/', 1)[-1])
