"""SoilGrids 2.0 over India: the band table, the India window on ISRIC's grid,
which ISRIC tiles a run fetches, the local VRT over the fetched tiles, and the
skip-if-done steps.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_soilgrids.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_soilgrids as sg  # noqa: E402

SPEC = json.loads((HERE.parent / 'shared' / 'soilgrids.json').read_text())


def test_bands_run_depth_by_depth_then_the_wrb_class():
    bands = sg.bands(SPEC)
    assert len(bands) == 8 * 3 + 1
    assert bands[0] == 'clay_0-5cm_mean'
    assert bands[7] == 'nitrogen_0-5cm_mean'
    assert bands[8] == 'clay_5-15cm_mean'
    assert bands[-1] == 'wrb_MostProbable'


def test_each_band_has_its_isric_vrt_url():
    assert sg.vrt_url('clay_0-5cm_mean') == 'https://files.isric.org/soilgrids/latest/data/clay/clay_0-5cm_mean.vrt'
    assert sg.vrt_url('wrb_MostProbable') == 'https://files.isric.org/soilgrids/latest/data/wrb/MostProbable.vrt'


def test_the_india_window_sits_on_the_wrb_grid():
    w = sg.india_window(SPEC['grid'])
    res = SPEC['grid']['res_deg']
    assert w['cols'] == 14400 and w['rows'] == 15360
    # snapped to ISRIC's 4326 grid (origin -180, 83.999167206), so the WRB band is a crop, not a resample
    assert abs((w['xmin'] + 180) / res - round((w['xmin'] + 180) / res)) < 1e-6
    assert abs((83.999167206 - w['ymax']) / res - round((83.999167206 - w['ymax']) / res)) < 1e-6
    assert abs(w['xmin'] - 68) < res and abs(w['ymax'] - 38) < res


VRT = """<VRTDataset rasterXSize="1000" rasterYSize="1000">
  <SRS>X</SRS>
  <VRTRasterBand dataType="Int16" band="1">
    <NoDataValue>-32768</NoDataValue>
    <ComplexSource>
      <SourceFilename relativeToVRT="1">./clay_0-5cm_mean/tileSG-001-001/tileSG-001-001_1-1.tif</SourceFilename>
      <SourceBand>1</SourceBand>
      <DstRect xOff="0" yOff="0" xSize="450" ySize="450" />
    </ComplexSource>
    <ComplexSource>
      <SourceFilename relativeToVRT="1">./clay_0-5cm_mean/tileSG-001-002/tileSG-001-002_1-1.tif</SourceFilename>
      <SourceBand>1</SourceBand>
      <DstRect xOff="450" yOff="0" xSize="450" ySize="450" />
    </ComplexSource>
  </VRTRasterBand>
</VRTDataset>
"""


def test_sources_lists_each_tile_with_its_rect():
    got = sg.sources(VRT)
    assert got == [('./clay_0-5cm_mean/tileSG-001-001/tileSG-001-001_1-1.tif', (0, 0, 450, 450)),
                   ('./clay_0-5cm_mean/tileSG-001-002/tileSG-001-002_1-1.tif', (450, 0, 450, 450))]


def test_tiles_with_a_sample_pixel_inside_are_kept():
    keep = sg.tiles_touching(sg.sources(VRT), [(10.0, 10.0), (460.5, 449.0)], margin=0)
    assert keep == {'./clay_0-5cm_mean/tileSG-001-001/tileSG-001-001_1-1.tif',
                    './clay_0-5cm_mean/tileSG-001-002/tileSG-001-002_1-1.tif'}
    assert sg.tiles_touching(sg.sources(VRT), [(10.0, 10.0)], margin=0) == {
        './clay_0-5cm_mean/tileSG-001-001/tileSG-001-001_1-1.tif'}
    # a sample a pixel past the edge still keeps the tile (the warp reads a pixel beyond)
    assert sg.tiles_touching(sg.sources(VRT), [(451.0, 10.0)], margin=2) == {
        './clay_0-5cm_mean/tileSG-001-001/tileSG-001-001_1-1.tif',
        './clay_0-5cm_mean/tileSG-001-002/tileSG-001-002_1-1.tif'}


def test_the_local_vrt_keeps_only_fetched_tiles_and_points_at_them(tmp_path):
    keep = {'./clay_0-5cm_mean/tileSG-001-002/tileSG-001-002_1-1.tif'}
    out = sg.local_vrt(VRT, keep, tmp_path / 'raw')
    assert 'tileSG-001-001' not in out
    assert f'<SourceFilename relativeToVRT="0">{tmp_path / "raw"}/clay_0-5cm_mean/tileSG-001-002/' \
           'tileSG-001-002_1-1.tif</SourceFilename>' in out
    assert out.count('<ComplexSource>') == 1


def test_band_descriptions_are_written_into_the_stack_vrt():
    xml = ('<VRTDataset>\n  <VRTRasterBand dataType="Int16" band="1">\n  </VRTRasterBand>\n'
           '  <VRTRasterBand dataType="Int16" band="2">\n  </VRTRasterBand>\n</VRTDataset>')
    out = sg.describe_bands(xml, ['clay_0-5cm_mean', 'wrb_MostProbable'])
    assert '<VRTRasterBand dataType="Int16" band="1">\n    <Description>clay_0-5cm_mean</Description>' in out
    assert '<Description>wrb_MostProbable</Description>' in out


def test_describe_bands_refuses_a_count_mismatch():
    with pytest.raises(ValueError):
        sg.describe_bands('<VRTRasterBand band="1">', ['a', 'b'])


def test_register_writes_the_key_into_the_shared_spec_and_a_rerun_changes_nothing(tmp_path):
    spec_path = tmp_path / 'soilgrids.json'
    spec_path.write_text(json.dumps({**SPEC, 'file': None}, indent=2) + '\n')
    file = {'key': 'soil/soilgrids/SoilGrids_India_250m.abcd1234.tif', 'bytes': 10, 'md5': 'x' * 32}
    sg.register(spec_path, file)
    first = spec_path.read_text()
    assert json.loads(first)['file'] == file
    sg.register(spec_path, file)
    assert spec_path.read_text() == first


def test_the_cog_gets_a_content_versioned_key_and_a_tiff_type(tmp_path):
    import pipeline
    f = tmp_path / 'SoilGrids_India_250m.tif'
    f.write_bytes(b'II*\x00')
    name = pipeline.versioned_names({'tif': f})['tif']
    assert name == f'SoilGrids_India_250m.{pipeline.file_md5(f)[:8]}.tif'
    assert pipeline.CONTENT_TYPES['.tif'] == 'image/tiff'
