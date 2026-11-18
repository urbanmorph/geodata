#!/usr/bin/env python3
"""
Audit the low-zoom map tiles of every catalog layer that has PMTiles.

For each layer, read the PMTiles header, directories and every tile at
z0..z5 by HTTP range from R2 (or a local file), decode each tile's features,
and flag the layer when:

  heavy     a low-zoom tile is over HEAVY_BYTES (the browser downloads it
            whole before anything draws at country zoom), or
  dropping  the polygons at LOW_ZOOM add up to under KEEP_SHARE of the
            layer's rows, and tippecanoe recorded that it dropped
            features to fit (not coalesced them: merged polygons still
            cover the ground). A dropped polygon is a hole in the map;
            points and lines thin out at low zoom by design.

One rule for every layer, never a per-layer list. Results are cached per
pmtiles URL (and its size), so a re-run only reads layers whose tiles
changed; a killed run keeps every layer it finished.

Run:
    python3 -u scripts/audit_tiles.py                  # all layers, table + JSON
    python3 -u scripts/audit_tiles.py fsi_beats gb_adm1
    python3 -u scripts/audit_tiles.py --flagged        # print flagged ids only
    python3 -u scripts/audit_tiles.py --file x.pmtiles # one local file
"""
from __future__ import annotations

import gzip
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = Path(os.environ.get('TILES_WORK', '/tmp/ramseraph/tiles')) / 'audit'

# About 500 KB: tippecanoe's default budget is 500,000 bytes a tile, and a
# low-zoom tile filled to within a few percent of it was cut down to fit.
HEAVY_BYTES = 480_000
LOW_ZOOMS = range(6)
LOW_ZOOM = 5          # the zoom the drop rule reads: India fills the screen
KEEP_SHARE = 0.5
WORKERS = 8           # layers read in parallel
UA = 'Mozilla/5.0 (compatible; bharatlas-tile-audit)'
GEOM = {1: 'point', 2: 'line', 3: 'polygon'}


# ── PMTiles v3 ───────────────────────────────────────────────────────────────

@dataclass
class Header:
    root_offset: int
    root_length: int
    metadata_offset: int
    metadata_length: int
    leaf_offset: int
    data_offset: int
    internal_compression: int
    tile_compression: int
    min_zoom: int
    max_zoom: int


def parse_header(b: bytes) -> Header:
    if b[:7] != b'PMTiles' or b[7] != 3:
        raise ValueError('not a PMTiles v3 archive')
    u = struct.unpack_from('<8Q', b, 8)
    return Header(root_offset=u[0], root_length=u[1], metadata_offset=u[2], metadata_length=u[3],
                  leaf_offset=u[4], data_offset=u[6], internal_compression=b[97],
                  tile_compression=b[98], min_zoom=b[100], max_zoom=b[101])


def read_varint(b: bytes, pos: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = b[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


@dataclass
class Entry:
    tile_id: int
    offset: int
    length: int
    run_length: int  # 0: a leaf directory


def parse_directory(b: bytes) -> list[Entry]:
    n, pos = read_varint(b, 0)
    cols: list[list[int]] = []
    for _ in range(4):  # tile id deltas, run lengths, lengths, offsets
        col = []
        for _ in range(n):
            v, pos = read_varint(b, pos)
            col.append(v)
        cols.append(col)
    entries, tile_id = [], 0
    for i in range(n):
        tile_id += cols[0][i]
        offset = cols[3][i] - 1
        if cols[3][i] == 0 and i > 0:
            offset = entries[i - 1].offset + entries[i - 1].length
        entries.append(Entry(tile_id, offset, cols[2][i], cols[1][i]))
    return entries


def _rotate(n: int, x: int, y: int, rx: int, ry: int) -> tuple[int, int]:
    if ry == 0:
        if rx == 1:
            x, y = n - 1 - x, n - 1 - y
        x, y = y, x
    return x, y


def tileid_to_zxy(tile_id: int) -> tuple[int, int, int]:
    acc = 0
    for z in range(32):
        count = 1 << (2 * z)
        if acc + count > tile_id:
            t, x, y, s = tile_id - acc, 0, 0, 1
            while s < (1 << z):
                rx = 1 & (t // 2)
                ry = 1 & (t ^ rx)
                x, y = _rotate(s, x, y, rx, ry)
                x, y, t, s = x + s * rx, y + s * ry, t // 4, s * 2
            return z, x, y
        acc += count
    raise ValueError(tile_id)


def first_tile_id(z: int) -> int:
    return ((1 << (2 * z)) - 1) // 3


def decompress(b: bytes, compression: int) -> bytes:
    if compression in (0, 1):  # unknown / none
        return b
    if compression == 2:
        return gzip.decompress(b)
    raise ValueError(f'unsupported compression {compression}')


# ── MVT ──────────────────────────────────────────────────────────────────────

def _fields(b: bytes) -> Iterator[tuple[int, int, bytes | int]]:
    """(field number, wire type, value) of one protobuf message."""
    pos = 0
    while pos < len(b):
        key, pos = read_varint(b, pos)
        field, wire = key >> 3, key & 7
        if wire == 0:
            v, pos = read_varint(b, pos)
            yield field, wire, v
        elif wire == 2:
            n, pos = read_varint(b, pos)
            yield field, wire, b[pos:pos + n]
            pos += n
        elif wire == 1:
            pos += 8
        elif wire == 5:
            pos += 4
        else:
            raise ValueError(f'protobuf wire type {wire}')


def tile_stats(mvt: bytes) -> dict:
    """Features per geometry type and attribute key count in one decoded tile."""
    by_type: dict[str, int] = {}
    keys = 0
    for field, _, layer in _fields(mvt):
        if field != 3:
            continue
        for lf, _, v in _fields(layer):
            if lf == 3:
                keys += 1
            elif lf == 2:
                kind = next((GEOM.get(fv, 'unknown') for ff, _, fv in _fields(v) if ff == 3), 'unknown')
                by_type[kind] = by_type.get(kind, 0) + 1
    return {'features': sum(by_type.values()), 'by_type': by_type, 'keys': keys}


# ── reading an archive ───────────────────────────────────────────────────────

def http_reader(url: str, tries: int = 5) -> Callable[[int, int], bytes]:
    def read(offset: int, length: int) -> bytes:
        for attempt in range(1, tries + 1):
            req = urllib.request.Request(url, headers={
                'User-Agent': UA, 'Range': f'bytes={offset}-{offset + length - 1}'})
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    body = r.read()
                if len(body) != length:
                    raise OSError(f'short read {len(body)} of {length}')
                return body
            except (OSError, urllib.error.URLError) as e:
                if isinstance(e, urllib.error.HTTPError) and 400 <= e.code < 500:
                    raise
                if attempt == tries:
                    raise
                time.sleep(3 * attempt)
        raise AssertionError('unreachable')
    return read


def file_reader(path: Path) -> Callable[[int, int], bytes]:
    def read(offset: int, length: int) -> bytes:
        with path.open('rb') as f:
            f.seek(offset)
            return f.read(length)
    return read


def low_zoom_entries(read: Callable[[int, int], bytes], h: Header, max_z: int) -> list[Entry]:
    """Tile entries (run lengths expanded) for z0..max_z, walking leaf
    directories only where they can hold such tiles."""
    limit = first_tile_id(max_z + 1)
    out: list[Entry] = []

    def walk(offset: int, length: int) -> None:
        entries = parse_directory(decompress(read(offset, length), h.internal_compression))
        for i, e in enumerate(entries):
            if e.tile_id >= limit:
                break
            if e.run_length == 0:
                walk(h.leaf_offset + e.offset, e.length)
            else:
                for k in range(e.run_length):
                    if e.tile_id + k < limit:
                        out.append(Entry(e.tile_id + k, e.offset, e.length, 1))
    walk(h.root_offset, h.root_length)
    return out


def audit_archive(read: Callable[[int, int], bytes], max_z: int = max(LOW_ZOOMS)) -> dict:
    """Per zoom: tile count, max and total stored bytes, decoded features
    (by geometry type), and the tippecanoe metadata's drop/coalesce counts."""
    h = parse_header(read(0, 127))
    meta = read_metadata(read, h)
    zooms: dict[int, dict] = {}
    for e in low_zoom_entries(read, h, max_z):
        z, x, y = tileid_to_zxy(e.tile_id)
        stats = tile_stats(decompress(read(h.data_offset + e.offset, e.length), h.tile_compression))
        zs = zooms.setdefault(z, {'tiles': 0, 'max_bytes': 0, 'total_bytes': 0, 'features': 0,
                                  'by_type': {}, 'max_keys': 0, 'heaviest': None})
        zs['tiles'] += 1
        zs['total_bytes'] += e.length
        if e.length > zs['max_bytes']:
            zs['max_bytes'], zs['heaviest'] = e.length, f'{z}/{x}/{y}'
        zs['features'] += stats['features']
        zs['max_keys'] = max(zs['max_keys'], stats['keys'])
        for k, v in stats['by_type'].items():
            zs['by_type'][k] = zs['by_type'].get(k, 0) + v
    strategies = meta.get('strategies')
    if isinstance(strategies, str):
        strategies = json.loads(strategies)
    return {'min_zoom': h.min_zoom, 'max_zoom': h.max_zoom,
            'zooms': {str(z): zooms[z] for z in sorted(zooms)},
            'strategies': strategies or [],
            'fields': vector_fields(meta)}


def read_metadata(read: Callable[[int, int], bytes], h: Header) -> dict:
    return json.loads(decompress(read(h.metadata_offset, h.metadata_length), h.internal_compression) or b'{}')


def vector_fields(meta: dict) -> list[str]:
    """The attribute names the tiles carry (the metadata's vector_layers)."""
    vlayers = meta.get('vector_layers')
    if isinstance(vlayers, str):
        vlayers = json.loads(vlayers)
    return sorted((vlayers or [{}])[0].get('fields', {}))


def archive_fields(read: Callable[[int, int], bytes]) -> list[str]:
    """vector_fields from the header and metadata alone (two range reads)."""
    return vector_fields(read_metadata(read, parse_header(read(0, 127))))


# ── the rule ─────────────────────────────────────────────────────────────────

def flag(audit: dict, rows: int | None) -> list[str]:
    """Reasons a layer's low-zoom tiles need a rebake ([] when fine)."""
    reasons = []
    for z, zs in audit['zooms'].items():
        if int(z) <= max(LOW_ZOOMS) and zs['max_bytes'] > HEAVY_BYTES:
            reasons.append(f"heavy: z{z} tile {zs['heaviest']} is {zs['max_bytes'] / 1024:,.0f} KB")
            break
    zs = audit['zooms'].get(str(LOW_ZOOM))
    if zs and rows and audit['max_zoom'] >= LOW_ZOOM:
        shapes = zs['by_type'].get('polygon', 0)
        strat = audit['strategies'][LOW_ZOOM] if len(audit['strategies']) > LOW_ZOOM else {}
        dropped = sum(v for k, v in (strat or {}).items() if k.startswith('dropped'))
        if shapes and shapes < KEEP_SHARE * rows and dropped:
            reasons.append(f'dropping: z{LOW_ZOOM} keeps {shapes:,} polygons of {rows:,} rows '
                           f'({dropped:,} dropped by tippecanoe)')
    return reasons


# ── CLI ──────────────────────────────────────────────────────────────────────

def cached_audit(url: str, size: int | None, cache: Path = CACHE) -> dict:
    """audit_archive, cached by URL and byte size (keys are versioned, so a
    rebake is a new URL)."""
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / (url.split('://', 1)[-1].replace('/', '__') + f'.{size}.json')
    if out.exists():
        return json.loads(out.read_text())
    result = audit_archive(http_reader(url))
    tmp = out.with_suffix('.part')
    tmp.write_text(json.dumps(result, indent=1))
    tmp.replace(out)
    return result


def summary_line(layer_id: str, a: dict, rows: int | None, reasons: list[str]) -> str:
    worst = max((zs['max_bytes'] for zs in a['zooms'].values()), default=0)
    feats = ' '.join(f"z{z}:{zs['features']}" for z, zs in a['zooms'].items())
    mark = 'FLAG' if reasons else 'ok  '
    return f"{mark} {layer_id:<40} rows {rows or 0:>9,}  max {worst / 1024:>7,.0f} KB  {feats}" + \
        (f"  <- {'; '.join(reasons)}" if reasons else '')


def main(argv: list[str]) -> int:
    args = argv[1:]
    if '--file' in args:
        a = audit_archive(file_reader(Path(args[args.index('--file') + 1])))
        print(json.dumps(a, indent=1))
        return 0
    only_flagged = '--flagged' in args
    ids = [x for x in args if not x.startswith('--')]
    catalog = json.loads((ROOT / 'catalog.json').read_text())
    layers = [x for x in catalog['layers'] if (x.get('pmtiles') or {}).get('url')
              and (not ids or x['id'] in ids)]
    results, flagged = {}, []

    def one(layer: dict) -> dict | Exception:
        try:
            return cached_audit(layer['pmtiles']['url'], layer['pmtiles'].get('bytes'))
        except (OSError, ValueError) as e:
            return e

    with ThreadPoolExecutor(WORKERS) as pool:
        audits = pool.map(one, layers)
    for i, (layer, a) in enumerate(zip(layers, audits), 1):
        if isinstance(a, Exception):
            print(f'ERR  {layer["id"]}: {type(a).__name__}: {a}', flush=True)
            continue
        reasons = flag(a, layer.get('rows'))
        results[layer['id']] = {'url': layer['pmtiles']['url'], 'rows': layer.get('rows'), 'reasons': reasons, **a}
        if reasons:
            flagged.append(layer['id'])
        if not only_flagged:
            print(f'[{i}/{len(layers)}] ' + summary_line(layer['id'], a, layer.get('rows'), reasons), flush=True)
    report = CACHE / 'report.json'
    report.write_text(json.dumps(results, indent=1))
    if only_flagged:
        print('\n'.join(flagged))
    else:
        print(f'\n{len(flagged)} of {len(results)} layers flagged; report: {report}', flush=True)
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(line_buffering=True)
    sys.exit(main(sys.argv))
