"""Big forest / rural / cadastral layers via ingest_big_layers (Nov 2026).

- A layer whose columns name people (owners, occupants, phones) is refused
  before anything is baked or uploaded: cadastrals must never publish owners.
- Large release assets are fetched resumably: a killed download continues
  from the partial file, and a finished file is never fetched again.
- Every layer is republished government data with credit (policy B).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_ingest_big_layers.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ingest_big_layers as bl


@pytest.mark.parametrize('col', [
    'Name_Of_Owners', 'NAME_OF_OWNER', 'OWNERS_NAME', 'occupant_name',
    'father_name', 'mobile_no', 'Phone', 'email', 'aadhaar', 'beneficiary_name',
])
def test_personal_columns_are_flagged(col):
    assert bl.personal_data_columns(['Survey_No', col]) == [col]


def test_parcel_and_place_columns_pass():
    # Real columns from layers that pass: parcel numbers, record numbers and
    # place names are not personal data.
    cols = ['Survey_No', 'Village_Name', 'khatian', 'Dag_No', 'M_KHASRA_N', 'Plot_No',
            'PAT_STS', 'Mouja_Name', 'name_of_rf', 'ownership', 'beat_name', 'island']
    assert bl.personal_data_columns(cols) == []


def test_guard_refuses_a_layer_with_owner_names(monkeypatch):
    monkeypatch.setattr(bl, 'parquet_columns', lambda p: ['Survey_No', 'Name_Of_Owners'])
    with pytest.raises(SystemExit, match='Name_Of_Owners'):
        bl.assert_no_personal_data('x_layer', Path('x.parquet'))


def test_fetch_resumes_a_partial_download(tmp_path):
    src = tmp_path / 'src.bin'
    src.write_bytes(b'0123456789' * 1000)
    dest = tmp_path / 'out' / 'dest.bin'
    dest.parent.mkdir()
    # A killed run left the first 3,000 bytes behind.
    Path(f'{dest}.part').write_bytes(src.read_bytes()[:3000])
    bl.fetch_resumable(src.as_uri(), dest)
    assert dest.read_bytes() == src.read_bytes()
    assert not Path(f'{dest}.part').exists()


def test_fetch_skips_a_finished_file(tmp_path):
    dest = tmp_path / 'dest.bin'
    dest.write_bytes(b'done')
    bl.fetch_resumable((tmp_path / 'missing').as_uri(), dest)  # would fail if fetched
    assert dest.read_bytes() == b'done'


def test_prefetch_bakes_popup_tiles_where_ingest_reads_them(tmp_path, monkeypatch):
    # The upstream PMTiles carry every column, so tippecanoe drops parcels at
    # mid zooms; each layer gets its own tiles with popup fields only.
    monkeypatch.setattr(bl.ir, 'WORK', tmp_path)
    seen = []
    monkeypatch.setattr(bl, 'fetch_resumable', lambda url, dest: seen.append((url, dest)))
    monkeypatch.setattr(bl, 'bake_popup_pmtiles', lambda src, out, layer, fields: seen.append((src, out)))
    d = bl.DATASETS[0]
    bl.prefetch(d)
    raw = tmp_path / f'_raw_{d.id}.parquet'
    assert seen == [(d.parquet_url, raw), (raw, tmp_path / f'{d.id}.pmtiles')]


def test_every_layer_names_popup_fields_that_exist():
    for d in bl.DATASETS:
        assert 1 <= len(bl.TILE_FIELDS[d.id]) <= 8
        assert d.kml_name_field in bl.TILE_FIELDS[d.id]


def test_popup_pmtiles_keep_only_the_named_fields(tmp_path):
    import json
    import subprocess

    import duckdb
    src = tmp_path / 'p.parquet'
    duckdb.sql("INSTALL spatial; LOAD spatial;")
    duckdb.sql(
        "COPY (SELECT '12' AS Survey_No, 'Ariankuppam' AS Village_Name, 1.5 AS CRZ_II, "
        "ST_GeomFromText('POLYGON((79.0 11.0, 79.9 11.0, 79.9 11.9, 79.0 11.0))') AS geometry) "
        f"TO '{src}' (FORMAT PARQUET)")
    out = tmp_path / 'p.pmtiles'
    bl.bake_popup_pmtiles(src, out, 'x_layer', ['Survey_No', 'Village_Name'])
    decoded = json.loads(subprocess.run(['tippecanoe-decode', str(out)],
                                        capture_output=True, text=True, check=True).stdout)
    feats = [f for t in decoded['features'] for layer in t['features'] for f in layer['features']]
    assert feats and all(set(f['properties']) == {'Survey_No', 'Village_Name'} for f in feats)
    assert 78.9 < feats[0]['geometry']['coordinates'][0][0][0] < 80  # lon first
    assert not list(tmp_path.glob('*.part*'))


def test_layers_are_credited_and_unique():
    ids = [d.id for d in bl.DATASETS]
    assert len(ids) == len(set(ids))
    import ingest_ramseraph as ir
    assert not set(ids) & {d.id for d in ir.DATASETS}
    for d in bl.DATASETS:
        assert d.license == 'CC0-1.0'
        assert 'DataMeet' in d.notes and d.source_org in d.notes
        assert d.parquet_url.startswith('https://github.com/ramSeraph/')
        assert d.kml_name_field
