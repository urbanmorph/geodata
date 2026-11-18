"""Tests for scripts/audit_tiles.py: the PMTiles/MVT readers and the flag rule."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audit_tiles as at  # noqa: E402


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def field(num: int, payload: bytes) -> bytes:
    return varint(num << 3 | 2) + varint(len(payload)) + payload


def feature(geom_type: int) -> bytes:
    return varint(3 << 3 | 0) + varint(geom_type)


def test_read_varint_multibyte():
    assert at.read_varint(varint(300) + b'\x01', 0) == (300, 2)


def test_parse_directory_offsets_continue_from_previous_entry():
    # Two tiles (ids 0, 1), run lengths 1, lengths 10 and 20; the second
    # offset is 0, meaning "right after the previous tile".
    raw = varint(2) + varint(0) + varint(1) + varint(1) + varint(1) + varint(10) + varint(20) \
        + varint(5 + 1) + varint(0)
    entries = at.parse_directory(raw)
    assert [(e.tile_id, e.offset, e.length, e.run_length) for e in entries] == [(0, 5, 10, 1), (1, 15, 20, 1)]


@pytest.mark.parametrize('tile_id,zxy', [
    (0, (0, 0, 0)), (1, (1, 0, 0)), (2, (1, 0, 1)), (3, (1, 1, 1)), (4, (1, 1, 0)), (5, (2, 0, 0)),
])
def test_tileid_to_zxy(tile_id, zxy):
    assert at.tileid_to_zxy(tile_id) == zxy


def test_first_tile_id():
    assert [at.first_tile_id(z) for z in range(4)] == [0, 1, 5, 21]


def test_tile_stats_counts_features_by_type_and_keys():
    layer = field(1, b'lyr') + field(2, feature(3)) + field(2, feature(3)) + field(2, feature(1)) \
        + field(3, b'name') + field(3, b'code')
    assert at.tile_stats(field(3, layer)) == {'features': 3, 'by_type': {'polygon': 2, 'point': 1}, 'keys': 2}


def audit(max_bytes=1000, polygons=100, dropped=0, coalesced=0, max_zoom=10):
    strat = {'dropped_as_needed': dropped} if dropped else {}
    if coalesced:
        strat['coalesced_as_needed'] = coalesced
    return {'max_zoom': max_zoom, 'strategies': [{}] * 5 + [strat],
            'zooms': {'3': {'max_bytes': max_bytes, 'heaviest': '3/5/3', 'by_type': {}},
                      '5': {'max_bytes': 10, 'heaviest': '5/1/1', 'by_type': {'polygon': polygons}}}}


def test_flag_light_layer_passes():
    assert at.flag(audit(), rows=150) == []


def test_flag_heavy_low_zoom_tile():
    assert at.flag(audit(max_bytes=at.HEAVY_BYTES + 1), rows=150)[0].startswith('heavy: z3 tile 3/5/3')


def test_flag_dropped_polygons():
    reasons = at.flag(audit(polygons=10, dropped=500), rows=1000)
    assert reasons and reasons[0].startswith('dropping: z5 keeps 10 polygons of 1,000')


def test_flag_coalesced_polygons_still_cover_the_ground():
    assert at.flag(audit(polygons=10, coalesced=500), rows=1000) == []


@pytest.mark.parametrize('kind', ['point', 'line'])
def test_flag_points_and_lines_thin_by_design(kind):
    a = audit(polygons=0, dropped=500)
    a['zooms']['5']['by_type'] = {kind: 10}
    assert at.flag(a, rows=1000) == []


@pytest.mark.skipif(not shutil.which('tippecanoe'), reason='needs tippecanoe')
def test_audit_archive_reads_a_real_tileset(tmp_path):
    feats = [{'type': 'Feature', 'properties': {'n': i},
              'geometry': {'type': 'Point', 'coordinates': [70 + i * 0.5, 10 + i * 0.5]}} for i in range(40)]
    src = tmp_path / 'pts.geojson'
    src.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats}))
    out = tmp_path / 'pts.pmtiles'
    subprocess.run(['tippecanoe', '-o', str(out), '-Z0', '-z6', '-r1', '-l', 'pts', '--force',
                    '--no-progress-indicator', str(src)], check=True, capture_output=True)
    a = at.audit_archive(at.file_reader(out))
    assert (a['min_zoom'], a['max_zoom']) == (0, 6)
    assert a['fields'] == ['n']
    # -r1: no dot dropping; one tile holds all 40 points at z0, and tiles
    # sharing a buffer repeat a few at higher zooms.
    assert a['zooms']['0']['features'] == 40
    assert all(zs['features'] >= 40 for zs in a['zooms'].values())
    assert sorted(a['zooms']) == [str(z) for z in range(6)]
    # Tile names come from the Hilbert ids: the points (lon 70-90, lat 10-30)
    # sit in z2 tile x=2 (lon 0-90), y=1 (lat 0-66).
    assert a['zooms']['2']['heaviest'] == '2/2/1'
