"""Locate tests a point against PMTiles geometry at the tileset's max zoom.
bharatviz_pincodes stopped at z4 (tippecanoe -zg), so MG Road fell inside a
coarse Bettahalsur (562157) blob instead of 560001 (Nov 2026).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_rebake_locate_tiles.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rebake_locate_tiles as rt  # noqa: E402

URL = 'https://pub-x.r2.dev/postal/boundaries/bharatviz_pincodes.pmtiles'


def test_tiles_go_to_zoom_12_and_keep_every_feature_there():
    cmd = rt.tippecanoe_cmd(Path('in.geojson'), Path('out.pmtiles'), 'bharatviz_pincodes')
    assert cmd[0] == 'tippecanoe' and '-z12' in cmd and '-zg' not in cmd
    assert '--extend-zooms-if-still-dropping' in cmd  # never drop at max zoom
    assert ['-l', 'bharatviz_pincodes'] == cmd[cmd.index('-l'):cmd.index('-l') + 2]


def test_new_tiles_go_to_a_versioned_key_not_the_cached_one():
    # The old object is served immutable for 7 days; overwriting it would keep
    # serving the coarse tiles from caches.
    assert rt.versioned_key(URL) == 'postal/boundaries/bharatviz_pincodes.z12.pmtiles'
    assert rt.versioned_key(URL.replace('.pmtiles', '.z12.pmtiles')) == 'postal/boundaries/bharatviz_pincodes.z12.pmtiles'


def test_patch_points_the_layer_at_the_new_tiles_and_keeps_the_rest():
    layer = {'id': 'bharatviz_pincodes', 'rows': 3, 'pmtiles': {'url': URL, 'bytes': 1, 'upstream_url': 'u'}}
    out = rt.patched_layer(layer, 'https://pub-x.r2.dev', 'postal/boundaries/bharatviz_pincodes.z12.pmtiles', 99)
    assert out['pmtiles'] == {'url': 'https://pub-x.r2.dev/postal/boundaries/bharatviz_pincodes.z12.pmtiles',
                              'bytes': 99, 'upstream_url': 'u'}
    assert out['rows'] == 3 and layer['pmtiles']['url'] == URL  # input untouched
