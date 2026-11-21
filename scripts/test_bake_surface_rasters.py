"""The surface rasters (Copernicus DEM GLO-90, WorldPop 2020, ESA WorldCover sizing): which source tiles
touch India, the paged S3 listing, the 3 GB ceiling, and an idempotent register step.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_surface_rasters.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_surface_rasters as sr  # noqa: E402

SPEC = json.loads((HERE.parent / 'shared' / 'surface_rasters.json').read_text())


def test_a_dem_key_names_its_lower_left_corner():
    assert sr.dem_tile_lnglat('Copernicus_DSM_COG_30_N28_00_E077_00_DEM/Copernicus_DSM_COG_30_N28_00_E077_00_DEM.tif') == (77, 28)
    assert sr.dem_tile_lnglat('Copernicus_DSM_COG_30_N28_00_E077_00_DEM/AUXFILES/x_EDM.tif') is None


def test_a_worldcover_key_names_its_lower_left_corner():
    assert sr.worldcover_lnglat('v200/2021/map/ESA_WorldCover_10m_2021_v200_N27E075_Map.tif') == (75, 27)


def test_tiles_touching_india_box():
    assert sr.touches_india(77, 28, 1)
    assert sr.touches_india(66, 36, 3)      # 66-69E overlaps 68E
    assert not sr.touches_india(65, 36, 3)
    assert not sr.touches_india(98, 20, 1)


def test_the_s3_listing_follows_continuation_tokens():
    pages = {
        None: '<Key>a</Key><Size>1</Size><NextContinuationToken>t1</NextContinuationToken>',
        't1': '<Key>b</Key><Size>2</Size>',
    }

    def get(url):
        token = url.split('continuation-token=')[1] if 'continuation-token=' in url else None
        return pages[token]
    assert sr.s3_keys('https://bucket', 'p', get) == [('a', 1), ('b', 2)]


def test_a_raster_over_the_ceiling_is_not_uploaded(tmp_path, monkeypatch):
    out = tmp_path / 'out' / f'{sr.RASTERS["dem"]["basename"]}.tif'
    out.parent.mkdir(parents=True)
    out.write_bytes(b'x')
    monkeypatch.setattr(sr, 'MAX_BYTES', 0)
    with pytest.raises(RuntimeError, match='not uploaded'):
        sr.upload(tmp_path, 'dem')


def test_register_writes_once(tmp_path):
    spec = tmp_path / 's.json'
    spec.write_text(json.dumps(SPEC, indent=2) + '\n')
    file = {'key': 'surface/dem/x.abcd1234.tif', 'bytes': 1, 'md5': 'f' * 32}
    assert sr.register(spec, 'dem', file) is True
    first = spec.read_text()
    assert sr.register(spec, 'dem', file) is False
    assert spec.read_text() == first
    assert json.loads(first)['rasters']['dem']['file'] == file


def test_every_raster_carries_a_credit_licence_scale_and_vintage():
    for name, r in SPEC['rasters'].items():
        assert r['credit']['name'] and r['credit']['licence'] and r['credit']['url'], name
        assert r['about']['scale'] and r['about']['vintage'], name
    assert 'WorldDEM-90' in SPEC['rasters']['dem']['credit']['notice']
    assert 'do not incur any liability' in SPEC['rasters']['dem']['credit']['notice']


def test_worldcover_is_built_and_says_its_resolution():
    assert 'worldcover' in sr.RASTERS
    assert '30 m' in SPEC['rasters']['worldcover']['about']['scale']


def test_each_worldcover_tile_warps_to_30_m_on_its_own_3_degree_square():
    key = 'v200/2021/map/ESA_WorldCover_10m_2021_v200_N27E075_Map.tif'
    cmd = sr.worldcover_warp(key, 'in.tif', 'out.tif')
    assert cmd[:2] == ['gdalwarp', '-q']
    assert cmd[cmd.index('-r') + 1] == 'mode'
    assert cmd[cmd.index('-tr') + 1:cmd.index('-tr') + 3] == [str(1 / 3600)] * 2
    assert cmd[cmd.index('-te') + 1:cmd.index('-te') + 5] == ['75', '27', '78', '30']
    assert cmd[-2:] == ['in.tif', 'out.tif']
    assert sr.worldcover_part_name(key) == 'N27E075.tif'
