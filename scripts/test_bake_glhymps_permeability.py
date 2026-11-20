"""glhymps_permeability: GLHYMPS 2.0 (Huscroft, Gleeson, Hartmann and Börker 2018), the global
permeability and porosity polygons on Borealis, kept where they touch India as bharatlas
publishes it (india_boundary). Pinned by md5 + sha256, CC-BY 4.0 checked on pull, every
column as published, whole polygons reprojected to lon/lat, and the catalog entry.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_glhymps_permeability.py -q
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_glhymps_permeability as g  # noqa: E402
import pipeline  # noqa: E402

BOUNDARY_URL = 'https://r2/reference/india_boundary.463f149c.parquet'


def dataset(licence='CC-BY 4.0', md5=g.ZIP_MD5, version=(1, 0)):
    """The Borealis dataset API answer, trimmed to what the pull reads."""
    return {'status': 'OK', 'data': {'latestVersion': {
        'versionNumber': version[0], 'versionMinorNumber': version[1],
        'license': {'name': licence, 'uri': 'http://creativecommons.org/licenses/by/4.0'},
        'files': [{'dataFile': {'id': 71773, 'filename': 'Readme_GLHYMPS2_0.txt', 'checksum': {'value': 'x'}}},
                  {'dataFile': {'id': g.ZIP_FILE_ID, 'filename': 'GLHYMPS.zip',
                                'checksum': {'type': 'MD5', 'value': md5}}}]}}}


def catalog(tmp_path: Path) -> Path:
    path = tmp_path / 'catalog.json'
    path.write_text(json.dumps({'layers': [{'id': 'india_boundary', 'parquet': {'url': BOUNDARY_URL}}]}))
    return path


# ── pull: the pinned Borealis zip under CC-BY 4.0, and the India boundary, each fetched once ──

def test_the_pull_fetches_the_zip_and_the_boundary_once_and_pins_them(tmp_path):
    got = []

    def download(url, dest, md5=None):
        got.append((url, md5))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(url.encode())
    raw, cat = tmp_path / 'raw', catalog(tmp_path)
    first = g.pull(raw, lambda url: dataset(), download, cat, now='2026-11-21T10:00:00+00:00')
    assert got == [(g.ZIP_URL, g.ZIP_MD5), (BOUNDARY_URL, None)]
    assert first['licence'] == 'CC-BY 4.0' and first['version'] == '1.0' and first['md5'] == g.ZIP_MD5
    assert first['sha256'] == hashlib.sha256(g.ZIP_URL.encode()).hexdigest()
    assert first['boundary'] == {'url': BOUNDARY_URL, 'path': str(raw / 'india_boundary.463f149c.parquet'),
                                 'sha256': hashlib.sha256(BOUNDARY_URL.encode()).hexdigest()}
    assert first['pulled_at'] == '2026-11-21T10:00:00+00:00'
    again = g.pull(raw, lambda url: dataset(), download, cat, now='2026-11-22T10:00:00+00:00')
    assert len(got) == 2 and again == first        # nothing fetched, nothing re-dated


@pytest.mark.parametrize('answer, why', [
    (dataset(licence='CC-BY-NC 4.0'), 'CC-BY-NC'),
    (dataset(md5='0' * 32), '0' * 32),
    (dataset(version=(2, 0)), '2.0'),
])
def test_a_changed_licence_file_or_version_stops_the_pull(tmp_path, answer, why):
    with pytest.raises(ValueError, match=why):
        g.pull(tmp_path, lambda url: answer, lambda *a, **k: None, catalog(tmp_path))


# ── bake: whole polygons that touch India, every column as published, in lon/lat ──

COLS = ['OBJECTID_1', 'IDENTITY_', 'logK_Ice_x', 'logK_Ferr_', 'Porosity_x', 'K_stdev_x1', 'Descriptio']


def square(x0, y0, x1, y1):
    return {'type': 'Polygon', 'coordinates': [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


def source_shapefile(tmp_path: Path) -> Path:
    """A shapefile in a projected CRS (Web Mercator), as GLHYMPS ships in its own projection."""
    polys = {'inside': square(75, 15, 76, 16), 'straddles': square(89, 20, 92, 21),
             'near but outside': square(91, 22, 92, 23), 'far away': square(0, 50, 1, 51)}
    feats = [{'type': 'Feature', 'geometry': geom,
              'properties': dict(zip(COLS, [i + 1, f'IND{i}', -1500 - i, -1300 - i, 5 + i, 150, name]))}
             for i, (name, geom) in enumerate(polys.items())]
    src = tmp_path / 'src.geojson'
    src.write_text(json.dumps({'type': 'FeatureCollection', 'features': feats}))
    shp = tmp_path / 'shp' / 'GLHYMPS.shp'
    shp.parent.mkdir()
    subprocess.run(['ogr2ogr', '-f', 'ESRI Shapefile', '-t_srs', 'EPSG:3857', str(shp), str(src)], check=True)
    return shp


def boundary(tmp_path: Path) -> Path:
    out = tmp_path / 'india.parquet'
    # typed EPSG:4326 like the published india_boundary (GDAL's output is OGC:CRS84: both lon/lat)
    pipeline.make_con().execute(f"""COPY (SELECT 'India' AS name, ST_SetCRS(ST_GeomFromText(
        'POLYGON((70 10, 90 10, 90 30, 70 30, 70 10))'), 'EPSG:4326') AS geometry) TO '{out}' (FORMAT PARQUET)""")
    return out


def test_the_table_keeps_whole_polygons_touching_india_with_every_published_column(tmp_path):
    out = tmp_path / 't.parquet'
    assert g.build_table(pipeline.make_con(), source_shapefile(tmp_path), boundary(tmp_path), out) == 2
    con = pipeline.make_con()
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM '{out}'").fetchall()]
    assert cols == [*COLS, 'geometry']
    rows = con.execute(f"""SELECT Descriptio, "logK_Ferr_", ST_XMin(geometry), ST_YMin(geometry),
                                  ST_XMax(geometry), ST_YMax(geometry) FROM '{out}'""").fetchall()
    assert [r[:2] for r in rows] == [('inside', -1300), ('straddles', -1301)]
    # lon, lat (not lat, lon), and the straddling polygon is whole, not cut at the border
    for got, want in zip(rows, [(75, 15, 76, 16), (89, 20, 92, 21)]):
        assert got[2:] == pytest.approx(want, abs=1e-6)


def test_the_zip_is_extracted_once(tmp_path):
    shp = source_shapefile(tmp_path)
    zf = tmp_path / 'GLHYMPS.zip'
    with zipfile.ZipFile(zf, 'w') as z:
        for f in shp.parent.iterdir():
            z.write(f, f.name)
    first = g.extract_once(zf, tmp_path / 'x', 'abc')
    assert first == tmp_path / 'x' / 'GLHYMPS.shp' and first.exists()
    first.write_bytes(b'mark')                       # a second run with the same md5 does not unzip again
    assert g.extract_once(zf, tmp_path / 'x', 'abc') == first and first.read_bytes() == b'mark'
    assert g.extract_once(zf, tmp_path / 'x', 'new') == first and first.read_bytes() != b'mark'


# ── register ─────────────────────────────────────────────────────────────────

PULL = {'doi': g.DOI, 'version': '1.0', 'licence': 'CC-BY 4.0', 'file_id': g.ZIP_FILE_ID, 'md5': g.ZIP_MD5,
        'sha256': 'f' * 64, 'path': 'x', 'boundary': {'url': BOUNDARY_URL, 'path': 'y', 'sha256': 'e' * 64},
        'pulled_at': '2026-11-21T10:00:00+00:00'}
NAMES = {f: f'GLHYMPS_India.0123abcd.{e}' for f, e in g.EXT.items()}


def summary():
    return {'rows': 40000, 'sizes': {f: 100 for f in g.EXT}, 'names': NAMES, 'pull': PULL}


def test_the_entry_is_cc_by_credited_to_the_paper_in_the_water_theme():
    e = pipeline.licence_labelled(g.catalog_entry(summary(), {}, 'https://r2'))
    assert e['id'] == 'glhymps_permeability' and e['rows'] == 40000 and e['licence'] == 'CC-BY-4.0'
    assert e['attribution']['primary']['url'] == g.DOI_URL and 'Huscroft' in e['attribution']['primary']['name']
    assert e['parquet'] == {'url': 'https://r2/water/glhymps-permeability/GLHYMPS_India.0123abcd.parquet',
                            'bytes': 100}
    assert e['category'] == 'water' and e['fetched_at'] == PULL['pulled_at']
    assert e['source_check']['fingerprint'] == f'sha256={"f" * 64}'
    assert e['refresh']['class'] == 'frozen'
    for text in (e['notes'], g.description()):
        assert '—' not in text and 'catalog' not in text.lower()
    assert 'log10' in e['notes'] and 'm²' in e['notes'] and '10.1002/2017GL075860' in e['notes']


def test_registering_twice_changes_nothing_and_keeps_the_reviewed_labels(tmp_path):
    cat, man, sm = tmp_path / 'catalog.json', tmp_path / 'manifest.json', tmp_path / 'summary.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': [], 'attribution': {}}))
    man.write_text('[]')
    sm.write_text(json.dumps(summary()))
    g.register(cat, man, sm, 'https://r2')
    once = cat.read_text(), man.read_text()
    g.register(cat, man, sm, 'https://r2')
    assert (cat.read_text(), man.read_text()) == once
    c = json.loads(once[0])
    assert [x['id'] for x in c['layers']] == ['glhymps_permeability']
    assert c['level_order'] == ['glhymps_permeability']
    import licence_watch
    assert licence_watch.labelled(c['layers'][0]) == c['layers'][0]


def test_populate_scripts_agree_with_the_bake():
    import populate_refresh
    import populate_source_check
    e = g.catalog_entry(summary(), {}, 'https://r2')
    assert populate_refresh.infer(e)[0]['class'] == e['refresh']['class']
    assert populate_source_check.merge(e['source_check'], populate_source_check.infer(e, None)) == e['source_check']
