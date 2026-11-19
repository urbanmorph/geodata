"""Tests for scripts/release.py (no network).

A release is a dataset's files under a code that never changes or gets reused: bharatlas-<dataset>-<year>.<month>.
The manifest, CHANGES.md and SHA256SUMS are committed under web/public/releases/<code>/; the data files are staged
in data/baked/releases/<code>/ for R2 and served at /releases/<code>/<file>.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_release.py -q
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release as rel  # noqa: E402


def staging(tmp_path: Path, name='cw', files=None, rows=2) -> Path:
    d = tmp_path / 'staging' / name
    d.mkdir(parents=True, exist_ok=True)
    files = files or {'cw_states.csv': 'lgd_code,census2011_code\n1,01\n2,02\n'}
    for f, text in files.items():
        (d / f).write_text(text)
    meta = {'dataset': name, 'title': 'Census 2011 <-> LGD crosswalk', 'description': 'd',
            'licence': 'each file keeps its source layer\'s licence',
            'sources': [{'name': 'Local Government Directory (LGD)', 'url': 'https://lgdirectory.gov.in/',
                         'version': 'admin/states', 'fetched': '2026-05-19'}],
            'files': {f: {'licence': 'CC0-1.0', 'rows': rows, 'source_layer': 'lgd_states'} for f in files}}
    (d / 'release-meta.json').write_text(json.dumps(meta))
    return d


def roots(tmp_path):
    return {'meta_root': tmp_path / 'web' / 'public' / 'releases', 'files_root': tmp_path / 'baked' / 'releases'}


def test_the_code_is_app_dataset_year_and_two_digit_month():
    assert rel.release_code('cw', '2026-11-15') == 'bharatlas-cw-2026.11'
    assert rel.release_code('catalog', '2027-01-02') == 'bharatlas-catalog-2027.01'
    with pytest.raises(ValueError):
        rel.release_code('bad name', '2026-11-15')


def test_cutting_a_release_writes_manifest_sums_changes_and_stages_the_files(tmp_path):
    code, made = rel.make_release(staging(tmp_path), '2026-11-15', **roots(tmp_path))
    assert (code, made) == ('bharatlas-cw-2026.11', True)
    meta_dir = tmp_path / 'web' / 'public' / 'releases' / code
    m = json.loads((meta_dir / 'manifest.json').read_text())
    data = (tmp_path / 'baked' / 'releases' / code / 'cw_states.csv').read_bytes()
    file_sha = hashlib.sha256(data).hexdigest()
    sums = (meta_dir / 'SHA256SUMS').read_text()
    assert sums == f'{file_sha}  cw_states.csv\n'
    assert m['sha256'] == hashlib.sha256(sums.encode()).hexdigest()   # the release digest is the digest of SHA256SUMS
    assert m['pin'] == f'{code}+sha256:{m["sha256"]}'
    assert m['files'] == [{'name': 'cw_states.csv', 'sha256': file_sha, 'bytes': len(data), 'rows': 2,
                           'licence': 'CC0-1.0', 'source_layer': 'lgd_states',
                           'url': f'https://bharatlas.com/releases/{code}/cw_states.csv'}]
    assert m['attribution']['sources'][0]['name'].startswith('Local Government Directory')   # the source first
    assert m['attribution']['compiled_by'].startswith('bharatlas')
    assert m['url'] == f'https://bharatlas.com/releases/{code}/'
    assert m['w3id_proposed'] == 'https://w3id.org/bharatlas/cw/2026.11'
    assert m['previous'] is None and m['released'] == '2026-11-15'
    assert m['citation'].index('Local Government Directory') < m['citation'].index('bharatlas')
    changes = (meta_dir / 'CHANGES.md').read_text()
    assert changes.startswith(f'# {code}\n') and 'first release' in changes and m['sha256'] in changes
    assert '- cw_states.csv: 2 rows' in changes
    assert not (meta_dir / 'cw_states.csv').exists()                    # data files are not committed


def test_release_files_are_hashed_and_copied_without_loading_them_whole(tmp_path, monkeypatch):
    """A layer release holds multi-GB parquet and GeoJSON: never read_bytes() them."""
    src = staging(tmp_path)
    real = Path.read_bytes

    def guarded(self):
        assert self.parent != src, f'{self.name} loaded whole'
        return real(self)
    monkeypatch.setattr(Path, 'read_bytes', guarded)
    code, made = rel.make_release(src, '2026-11-15', **roots(tmp_path))
    assert made
    staged = roots(tmp_path)['files_root'] / code
    for f in src.iterdir():
        if f.name != rel.META_FILE:
            assert real(staged / f.name) == real(f)


def test_a_second_run_with_the_same_files_changes_nothing(tmp_path):
    src = staging(tmp_path)
    rel.make_release(src, '2026-11-15', **roots(tmp_path))
    meta = tmp_path / 'web' / 'public' / 'releases' / 'bharatlas-cw-2026.11'
    before = {p.name: p.read_bytes() for p in meta.iterdir()}
    stamp = {p.name: p.stat().st_mtime_ns for p in meta.iterdir()}
    assert rel.make_release(src, '2026-11-28', **roots(tmp_path)) == ('bharatlas-cw-2026.11', False)
    assert {p.name: p.read_bytes() for p in meta.iterdir()} == before
    assert {p.name: p.stat().st_mtime_ns for p in meta.iterdir()} == stamp


def test_a_lost_staged_file_is_restored_from_the_same_bytes(tmp_path):
    src = staging(tmp_path)
    code, _ = rel.make_release(src, '2026-11-15', **roots(tmp_path))
    staged = tmp_path / 'baked' / 'releases' / code / 'cw_states.csv'
    staged.unlink()
    assert rel.make_release(src, '2026-11-15', **roots(tmp_path)) == (code, False)
    assert staged.exists()


def test_different_files_under_an_existing_code_are_refused(tmp_path):
    rel.make_release(staging(tmp_path), '2026-11-15', **roots(tmp_path))
    changed = staging(tmp_path, files={'cw_states.csv': 'lgd_code,census2011_code\n1,01\n'})
    with pytest.raises(rel.ReleaseChanged, match='bharatlas-cw-2026.11'):
        rel.make_release(changed, '2026-11-20', **roots(tmp_path))


def test_the_next_release_names_the_previous_one_and_says_what_changed(tmp_path):
    rel.make_release(staging(tmp_path), '2026-11-15', **roots(tmp_path))
    newer = staging(tmp_path, files={'cw_states.csv': 'a\n1\n2\n3\n'}, rows=3)
    code, _ = rel.make_release(newer, '2026-12-01', **roots(tmp_path))
    m = json.loads((tmp_path / 'web' / 'public' / 'releases' / code / 'manifest.json').read_text())
    assert m['previous'] == 'bharatlas-cw-2026.11'
    changes = (tmp_path / 'web' / 'public' / 'releases' / code / 'CHANGES.md').read_text()
    assert 'cw_states.csv: 2 rows to 3' in changes


def test_the_index_lists_every_release_newest_first_with_the_latest_per_dataset(tmp_path):
    r = roots(tmp_path)
    rel.make_release(staging(tmp_path), '2026-11-15', **r)
    rel.make_release(staging(tmp_path, 'catalog', files={'catalog-record.json': '{}'}), '2026-11-15', **r)
    rel.make_release(staging(tmp_path, files={'cw_states.csv': 'x\n'}), '2026-12-01', **r)
    assert rel.write_index(r['meta_root']) is True
    idx = json.loads((r['meta_root'] / 'index.json').read_text())
    assert [x['code'] for x in idx['releases']] == [
        'bharatlas-cw-2026.12', 'bharatlas-cw-2026.11', 'bharatlas-catalog-2026.11']
    assert idx['latest'] == {'catalog': 'bharatlas-catalog-2026.11', 'cw': 'bharatlas-cw-2026.12'}
    first = idx['releases'][0]
    assert first['manifest'] == 'https://bharatlas.com/releases/bharatlas-cw-2026.12/manifest.json'
    assert first['pin'].startswith('bharatlas-cw-2026.12+sha256:')
    assert first['files'][0]['url'].endswith('/bharatlas-cw-2026.12/cw_states.csv')
    assert rel.write_index(r['meta_root']) is False                     # unchanged: not rewritten


def test_upload_commands_name_each_staged_file_once(tmp_path):
    r = roots(tmp_path)
    code, _ = rel.make_release(staging(tmp_path), '2026-11-15', **r)
    cmds = rel.upload_commands(code, r['files_root'])
    assert cmds == [(f'npx wrangler r2 object put geodata-data/releases/{code}/cw_states.csv '
                     f'--file data/baked/releases/{code}/cw_states.csv --content-type "text/csv; charset=utf-8" '
                     f'--remote')]


# ── layer releases: the dataset is a layer id ───────────────────────────────

R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'


def write_parquet(path: Path, cols: dict) -> Path:
    """A small parquet with these columns ({name: values}), written by DuckDB."""
    import duckdb
    path.parent.mkdir(parents=True, exist_ok=True)
    types = {int: 'BIGINT', str: 'VARCHAR', bytes: 'BLOB'}
    con = duckdb.connect()
    con.execute('CREATE TABLE t (' + ', '.join(f'"{n}" {types[type(v[0])]}' for n, v in cols.items()) + ')')
    con.executemany(f'INSERT INTO t VALUES ({", ".join("?" * len(cols))})', list(zip(*cols.values())))
    con.execute(f"COPY t TO '{path}' (FORMAT parquet)")
    return path


def a_layer(**kw):
    base = {'id': 'ngt_zones', 'level': 'ngt_zone', 'source': 'LGD', 'rows': 3, 'licence': 'CC0-1.0',
            'fetched_at': '2026-05-25T00:00:00+00:00', 'notes': 'Five NGT zonal benches.',
            'attribution': {'primary': {'name': 'Local Government Directory', 'url': 'https://lgdirectory.gov.in/'},
                            'publisher': None},
            'source_check': {'method': 'manual', 'fingerprint': None},
            'parquet': {'url': f'{R2}/judiciary/ngt_zones.3cb9a176.parquet', 'bytes': 1},
            'pmtiles': {'url': f'{R2}/judiciary/ngt_zones.pmtiles', 'bytes': 1},
            'geojson': {'url': f'{R2}/judiciary/ngt_zones.geojson', 'bytes': 1},
            'shapefile': {'url': f'{R2}/judiciary/ngt_zones.shp.zip', 'bytes': 1}}
    base.update(kw)
    return base


CAT = {'level_meta': {}, 'levels': {}}


def layer_sources(tmp_path, name='v1', ids=(1, 2, 3), extra_col=True):
    d = tmp_path / 'src' / name
    cols = {'zone_id': list(ids), 'name': [f'z{i}' for i in ids], 'geometry': [b'\x00'] * len(ids)}
    if extra_col:
        cols['bench'] = ['b'] * len(ids)
    write_parquet(d / 'ngt_zones.parquet', cols)
    (d / 'ngt_zones.geojson').write_text('{"type":"FeatureCollection","features":[]}')
    (d / 'ngt_zones.shp.zip').write_bytes(b'PK' + name.encode())
    return d


def stage(tmp_path, r, src, name, day, lyr=None):
    return rel.stage_layer(lyr or a_layer(), CAT, src, tmp_path / name, day, r['meta_root'], r['files_root'])


def test_a_layers_release_files_are_its_parquet_and_downloads_named_by_id_never_its_tiles():
    assert rel.layer_files(a_layer()) == {'ngt_zones.parquet': f'{R2}/judiciary/ngt_zones.3cb9a176.parquet',
                                          'ngt_zones.geojson': f'{R2}/judiciary/ngt_zones.geojson',
                                          'ngt_zones.shp.zip': f'{R2}/judiciary/ngt_zones.shp.zip'}


def test_a_layer_release_names_its_source_licence_and_where_each_file_came_from(tmp_path):
    r = roots(tmp_path)
    code, made = rel.make_release(stage(tmp_path, r, layer_sources(tmp_path), 's1', '2026-11-20'), '2026-11-20', **r)
    assert (code, made) == ('bharatlas-ngt_zones-2026.11', True)
    m = json.loads((r['meta_root'] / code / 'manifest.json').read_text())
    assert m['dataset'] == 'ngt_zones' and m['licence'] == 'CC0-1.0'
    assert m['attribution']['sources'][0] == {'name': 'Local Government Directory',
                                              'url': 'https://lgdirectory.gov.in/',
                                              'fetched': '2026-05-25T00:00:00+00:00'}
    assert [f['name'] for f in m['files']] == ['ngt_zones.geojson', 'ngt_zones.parquet', 'ngt_zones.shp.zip']
    pq_file = next(f for f in m['files'] if f['name'] == 'ngt_zones.parquet')
    assert pq_file['rows'] == 3 and pq_file['source_url'] == f'{R2}/judiciary/ngt_zones.3cb9a176.parquet'
    assert pq_file['columns'][0] == {'name': 'zone_id', 'type': 'BIGINT'}
    assert m['w3id_proposed'] == 'https://w3id.org/bharatlas/ngt_zones/2026.11'
    assert m['layer'] == {'id': 'ngt_zones', 'view': 'https://bharatlas.com/view/ngt_zones'}
    assert not any(f['name'].endswith('.pmtiles') for f in m['files'])


def test_the_next_layer_release_diffs_rows_schema_and_ids_against_the_previous_one(tmp_path):
    r = roots(tmp_path)
    rel.make_release(stage(tmp_path, r, layer_sources(tmp_path, 'v1', ids=(1, 2, 3)), 's1', '2026-11-20'),
                     '2026-11-20', **r)
    v2 = layer_sources(tmp_path, 'v2', ids=(2, 3, 4, 5), extra_col=False)
    code, made = rel.make_release(stage(tmp_path, r, v2, 's2', '2026-12-03'), '2026-12-03', **r)
    assert made and code == 'bharatlas-ngt_zones-2026.12'
    changes = (r['meta_root'] / code / 'CHANGES.md').read_text()
    assert 'Changes since bharatlas-ngt_zones-2026.11' in changes
    assert 'Rows: 3 to 4 (+1)' in changes
    assert 'Columns removed: bench' in changes
    assert 'By zone_id: 2 added (4, 5), 1 removed (1)' in changes


def test_a_layer_without_a_stable_id_column_is_compared_by_row_count_only(tmp_path):
    r = roots(tmp_path)
    d1, d2 = tmp_path / 'a', tmp_path / 'b'
    for d, names in ((d1, ['x', 'x']), (d2, ['x'])):
        write_parquet(d / 'ngt_zones.parquet', {'name': names, 'geometry': [b'\x00'] * len(names)})
        (d / 'ngt_zones.geojson').write_text('{}')
        (d / 'ngt_zones.shp.zip').write_bytes(b'PK')
    rel.make_release(stage(tmp_path, r, d1, 's1', '2026-11-20'), '2026-11-20', **r)
    code, _ = rel.make_release(stage(tmp_path, r, d2, 's2', '2026-12-03'), '2026-12-03', **r)
    changes = (r['meta_root'] / code / 'CHANGES.md').read_text()
    assert 'Rows: 2 to 1 (-1)' in changes and 'no stable id column' in changes


def test_a_second_layer_release_in_the_same_month_with_other_bytes_is_refused(tmp_path):
    r = roots(tmp_path)
    rel.make_release(stage(tmp_path, r, layer_sources(tmp_path, 'v1'), 's1', '2026-11-20'), '2026-11-20', **r)
    other = stage(tmp_path, r, layer_sources(tmp_path, 'v2', ids=(9,)), 's2', '2026-11-28')
    with pytest.raises(rel.ReleaseChanged):
        rel.make_release(other, '2026-11-28', **r)


def test_a_layer_with_files_missing_locally_is_refused(tmp_path):
    d = tmp_path / 'src'
    write_parquet(d / 'ngt_zones.parquet', {'zone_id': [1]})
    with pytest.raises(FileNotFoundError, match='ngt_zones.geojson'):
        stage(tmp_path, roots(tmp_path), d, 's', '2026-11-20')


def test_a_community_layer_cannot_be_released_under_its_mixed_case_id():
    with pytest.raises(ValueError):
        rel.release_code('c_nL7zNStsW3', '2026-11-20')


def test_a_layer_dry_run_prints_the_release_and_writes_nothing_under_the_releases(tmp_path, monkeypatch, capsys):
    r = roots(tmp_path)
    r['meta_root'].mkdir(parents=True)
    (r['meta_root'] / 'index.json').write_text('{}')
    src = layer_sources(tmp_path)
    cat = {'layers': [a_layer()], 'level_meta': {}, 'levels': {}}
    (tmp_path / 'catalog.json').write_text(json.dumps(cat))
    monkeypatch.setattr(rel, 'CATALOG', tmp_path / 'catalog.json')
    monkeypatch.setattr(rel, 'META_ROOT', r['meta_root'])
    monkeypatch.setattr(rel, 'FILES_ROOT', r['files_root'])
    monkeypatch.setattr(rel, 'ROOT', tmp_path)
    monkeypatch.setattr(rel, 'fetch_layer', lambda layer, dest: src)
    before = sorted(p.name for p in r['meta_root'].iterdir())
    assert rel.main(['--layer', 'ngt_zones', '--dry-run', '--date', '2026-11-20']) == 0
    out = capsys.readouterr().out
    assert 'bharatlas-ngt_zones-2026.11: released' in out and '# bharatlas-ngt_zones-2026.11' in out
    assert 'npx wrangler r2 object put geodata-data/releases/bharatlas-ngt_zones-2026.11/ngt_zones.parquet' in out
    assert sorted(p.name for p in r['meta_root'].iterdir()) == before
    assert not r['files_root'].exists()


def test_fetch_layer_downloads_each_file_once_and_again_when_the_catalog_names_another_url(tmp_path, monkeypatch):
    import pipeline
    got = []

    def fake_download(url, dest):
        got.append(url)
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b'x')

    monkeypatch.setattr(pipeline, 'download', fake_download)
    lyr = a_layer(geojson=None, shapefile=None, parquet={'url': f'{R2}/j/ngt_zones.aaaaaaaa.parquet', 'bytes': 1})
    rel.fetch_layer(lyr, tmp_path)
    rel.fetch_layer(lyr, tmp_path)
    assert (tmp_path / 'ngt_zones.parquet').read_bytes() == b'x' and len(got) == 2   # the 2nd finds it in place
    (tmp_path / 'ngt_zones.parquet').write_bytes(b'old')
    lyr['parquet']['url'] = f'{R2}/j/ngt_zones.bbbbbbbb.parquet'
    rel.fetch_layer(lyr, tmp_path)
    assert (tmp_path / 'ngt_zones.parquet').read_bytes() == b'x'                      # fetched again
    assert (tmp_path / 'ngt_zones.parquet.url').read_text().endswith('bbbbbbbb.parquet')


def test_a_geometry_column_is_typed_geometry_without_its_crs_text():
    assert rel._type('GEOMETRY(\'{"type":"GeographicCRS","name":"WGS 84"}\')') == 'GEOMETRY'
    assert rel._type('BIGINT') == 'BIGINT'


def test_a_ward_number_is_a_stable_id_but_a_gdal_row_number_is_not(tmp_path):
    a, b = tmp_path / 'a.parquet', tmp_path / 'b.parquet'
    write_parquet(a, {'OGC_FID': [1, 2], 'ward_no': [10, 11]})
    write_parquet(b, {'OGC_FID': [1, 2], 'ward_no': [11, 12]})
    assert rel.stable_id_column(b, a) == 'ward_no'
