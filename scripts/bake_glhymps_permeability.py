#!/usr/bin/env python3
"""
Bake glhymps_permeability: GLHYMPS 2.0, the global map of near-surface
permeability and porosity, for India.

Source: Huscroft, Gleeson, Hartmann and Börker 2018, "Compiling and mapping
global permeability of the unconsolidated and consolidated Earth: GLobal
HYdrogeology MaPS 2.0 (GLHYMPS 2.0)", Geophysical Research Letters 45
(doi:10.1002/2017GL075860); supporting data on Borealis, the Canadian
Dataverse (doi:10.5683/SP2/TTJNIU, version 1.0, file GLHYMPS.zip, a 2.6 GB
zipped shapefile). Licence: CC-BY 4.0, stated in the dataset API's `license`.

The layer: every polygon of the shapefile that touches India as bharatlas
publishes it (the india_boundary layer, claimed areas included), whole, not
cut at the border, with every column as published and in published order,
reprojected from the file's own projection to lon/lat (EPSG:4326).

Pull: the dataset version, licence and the zip's md5 are pinned; the zip is
fetched once (resumable, md5-checked) and cached under data/work with its
sha256, as is the india_boundary parquet. A second run fetches nothing.

Usage:
    python3 -u scripts/bake_glhymps_permeability.py pull
    python3 -u scripts/bake_glhymps_permeability.py bake
    python3 -u scripts/bake_glhymps_permeability.py upload      # md5-skip uploads to R2
    python3 -u scripts/bake_glhymps_permeability.py register    # patch catalog + manifest
"""
from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402
from pipeline import log, make_con  # noqa: E402

DOI = '10.5683/SP2/TTJNIU'
DOI_URL = f'https://doi.org/{DOI}'
PAPER_DOI = '10.1002/2017GL075860'
DATASET_API = f'https://borealisdata.ca/api/datasets/:persistentId/?persistentId=doi:{DOI}'
VERSION = '1.0'
LICENCE_STATED = 'CC-BY 4.0'
ZIP_FILE_ID = 71909
ZIP_MD5 = 'cf80bc7a21e3ee3191cec7f3cad621e4'
ZIP_URL = f'https://borealisdata.ca/api/access/datafile/{ZIP_FILE_ID}'
LAYER_ID = 'glhymps_permeability'
LEVEL = LAYER_ID
CATEGORY = 'water'
BASENAME = 'GLHYMPS_India'
R2_PREFIX = 'water/glhymps-permeability'
RAW = pipeline.work_dir(LAYER_ID, 'GLHYMPS_WORK')
CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
OUT_DIR = ROOT / 'data' / 'baked' / R2_PREFIX
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
SOURCE = 'GLHYMPS 2.0 (Huscroft et al. 2018)'
LICENCE = 'CC-BY-4.0'
ATTRIBUTION = {'name': 'Huscroft, Gleeson, Hartmann and Börker 2018, GLHYMPS 2.0 (Geophysical Research Letters)',
               'url': DOI_URL}
TILE_FIELDS = ('logK_Ferr_', 'logK_Ice_x', 'Porosity_x')
PAD_DEG = 1.0  # the bbox prefilter, in degrees around India; the exact intersection test follows
TAGS = ['groundwater', 'hydrogeology', 'permeability', 'porosity', 'hydraulic conductivity', 'aquifer',
        'subsurface', 'GLHYMPS', 'unconsolidated sediments', 'permafrost']


# ── pull ─────────────────────────────────────────────────────────────────────

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        while chunk := f.read(pipeline.CHUNK):
            h.update(chunk)
    return h.hexdigest()


def check_dataset(answer: dict) -> None:
    """The dataset must still be the pinned version, under CC-BY 4.0, with the pinned zip."""
    v = answer['data']['latestVersion']
    version = f'{v.get("versionNumber")}.{v.get("versionMinorNumber")}'
    licence = (v.get('license') or {}).get('name')
    md5 = next((f['dataFile']['checksum']['value'] for f in v.get('files', [])
                if f['dataFile']['id'] == ZIP_FILE_ID), None)
    if (version, licence, md5) != (VERSION, LICENCE_STATED, ZIP_MD5):
        raise ValueError(f'{DOI}: expected version {VERSION} under {LICENCE_STATED} with GLHYMPS.zip md5 {ZIP_MD5}, '
                         f'got version {version} under {licence} with md5 {md5}: review it first')


def pull(raw: Path, get_json: Callable[[str], dict], download: Callable[..., object],
         catalog_path: Path = CATALOG, now: str | None = None) -> dict:
    """The pinned zip and the india_boundary parquet the catalog names, each
    fetched once. The record (raw/pull.json) keeps its pulled_at while both are the same."""
    check_dataset(get_json(DATASET_API))
    zip_path = raw / 'GLHYMPS.zip'
    if not zip_path.exists():
        download(ZIP_URL, zip_path, md5=ZIP_MD5)
    layers = json.loads(catalog_path.read_text())['layers']
    b_url = next(x for x in layers if x['id'] == 'india_boundary')['parquet']['url']
    b_path = raw / b_url.rsplit('/', 1)[1]
    if not b_path.exists():
        download(b_url, b_path)
    got = {'doi': DOI, 'version': VERSION, 'licence': LICENCE_STATED, 'file_id': ZIP_FILE_ID, 'md5': ZIP_MD5,
           'sha256': sha256(zip_path), 'path': str(zip_path),
           'boundary': {'url': b_url, 'path': str(b_path), 'sha256': sha256(b_path)}}
    record = raw / 'pull.json'
    prev = json.loads(record.read_text()) if record.exists() else {}
    if {k: v for k, v in prev.items() if k != 'pulled_at'} == got:
        return prev
    got['pulled_at'] = now or pipeline.now_iso()
    raw.mkdir(parents=True, exist_ok=True)
    pipeline.write_json(record, got)
    return got


# ── bake ─────────────────────────────────────────────────────────────────────

def extract_once(zip_path: Path, dest: Path, md5: str) -> Path:
    """Unzip into `dest` unless the zip with this md5 was unzipped there already; the one .shp inside."""
    done = dest / '.extracted'
    if not (done.exists() and done.read_text() == md5):
        log(f'unzipping {zip_path.name}')
        dest.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(dest)
        done.write_text(md5)
    shps = sorted(dest.rglob('*.shp'))
    if len(shps) != 1:
        raise ValueError(f'{zip_path.name}: expected one shapefile, found {[s.name for s in shps]}')
    return shps[0]


def build_table(con, shp: Path, boundary: Path, out: Path) -> int:
    """Every polygon touching the boundary, whole, every column in published order,
    reprojected to lon/lat. Returns the row count."""
    con.execute('INSTALL spatial; LOAD spatial;')
    x0, y0, x1, y1 = con.execute(f"""SELECT min(ST_XMin(geometry)), min(ST_YMin(geometry)), max(ST_XMax(geometry)),
                                            max(ST_YMax(geometry)) FROM '{boundary}'""").fetchone()
    near = out.with_name(f'{out.stem}.near.parquet')
    # GDAL prefilters on India's bbox (padded) and reprojects; lon/lat order is ogr2ogr's default.
    pipeline.run(['ogr2ogr', '-f', 'Parquet', '-t_srs', 'EPSG:4326', '-spat_srs', 'EPSG:4326',
                  '-spat', *(str(v) for v in (x0 - PAD_DEG, y0 - PAD_DEG, x1 + PAD_DEG, y1 + PAD_DEG)),
                  '-lco', 'GEOMETRY_NAME=geometry', '-lco', 'FID=', '-lco', 'WRITE_COVERING_BBOX=NO', str(near), str(shp)],
                 timeout=pipeline.TOOL_TIMEOUT_S)
    # Both sides are lon/lat, but typed differently (OGC:CRS84 from GDAL, EPSG:4326 on the boundary): compare
    # them untyped (through WKB), which leaves the published geometry as it is.
    untyped = 'ST_GeomFromWKB(ST_AsWKB({}))'
    try:
        con.execute(f"""COPY (SELECT s.* EXCLUDE (file_row_number)
                              FROM read_parquet('{near}', file_row_number = true) s
                              WHERE ST_Intersects({untyped.format('s.geometry')}, (SELECT ST_Union_Agg(
                                  {untyped.format('geometry')}) FROM '{boundary}'))
                              ORDER BY file_row_number)
                        TO '{out}' (FORMAT PARQUET)""")
    finally:
        near.unlink(missing_ok=True)
    return con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]


def bake(out_dir: Path = OUT_DIR) -> dict:
    import tempfile

    import bake_formats

    got = json.loads((RAW / 'pull.json').read_text())
    shp = extract_once(Path(got['path']), RAW / 'extracted', got['md5'])
    out_dir.mkdir(parents=True, exist_ok=True)
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    with tempfile.TemporaryDirectory(prefix='glhymps_', dir=RAW) as tmp:
        table = Path(tmp) / 'glhymps.parquet'
        log('keeping the polygons that touch India')
        build_table(make_con(), shp, Path(got['boundary']['path']), table)
        rows, prop_cols = pipeline.rebake_flatten_bbox(table, path['parquet'])
    log(f'{rows} polygons')
    con = make_con()
    # Reprojected from metres, some polygons have vertices under 1 cm apart: 7 decimals would collapse 44 of
    # them into lines, so write_geojson_whole keeps full precision for the GeoJSON (and the KML, shapefile, tiles).
    files = bake_formats.write_all_formats(con, path, LAYER_ID, prop_cols, TILE_FIELDS)
    summary = {'rows': rows, 'pull': got, **files}
    pipeline.write_json(SUMMARY, summary)
    log(json.dumps(summary, indent=2))
    return summary


def upload(out_dir: Path = OUT_DIR) -> dict[str, str]:
    """Every format to its content-versioned key: unchanged files keep theirs (md5-skipped)."""
    return pipeline.upload_layer(out_dir, BASENAME, EXT, R2_PREFIX)


# ── register ─────────────────────────────────────────────────────────────────

def description() -> str:
    return ('How easily water moves through the ground near the surface (permeability) and how much of it is '
            'open space (porosity), mapped as rock and sediment polygons across India, from GLHYMPS 2.0.')


def notes() -> str:
    return ('GLHYMPS 2.0, the global hydrogeology map of Huscroft, Gleeson, Hartmann and Börker 2018, "Compiling '
            'and mapping global permeability of the unconsolidated and consolidated Earth", Geophysical Research '
            f'Letters 45 (https://doi.org/{PAPER_DOI}), published on Borealis ({DOI_URL}, version {VERSION}) '
            'under CC-BY 4.0. Every polygon that touches India (its boundary as shown on bharatlas, claimed areas '
            'included) is kept whole, so some reach past the border; every column is as published, with the '
            'shapefile\'s short names. Permeability is log10 of permeability in m², times 100: logK_Ferr_ '
            '(without permafrost) and logK_Ice_x (with permafrost) of -1300 mean 10^-13 m². Higher (less '
            'negative) values let water through more easily. For hydraulic conductivity of water in m/s, '
            'K = 10^(value/100) x 10^7. Porosity_x is porosity in percent (porosity x 100), K_stdev_x1 the '
            'standard deviation of log10 permeability x 100. GUM_K says where the values come from (1 GLHYMPS, '
            '2 the Global Unconsolidated Sediments Map) and 0 marks a polygon with no permeability value, whose '
            'permeability columns read 0 as published. Prmfrst is 1 inside the permafrost '
            'boundary. The source readme describes every column. The map is global and coarse (half the '
            'polygons are under 15 km², the largest cover hundreds of thousands of km²): use it for regional '
            'patterns, not for a single site.')


def level_meta() -> dict:
    return {'label': 'Permeability and porosity (GLHYMPS 2.0)', 'unit': 'polygons', 'description': description()}


def catalog_entry(summ: dict, prev: dict, r2_public: str) -> dict:
    from populate_refresh import refresh_block
    from populate_source_check import override
    names, sizes, got = summ['names'], summ['sizes'], summ['pull']
    entry = {'id': LAYER_ID, 'level': LEVEL, 'source': SOURCE, 'rows': summ['rows'],
             **pipeline.format_blocks(EXT, names, sizes, f'{r2_public}/{R2_PREFIX}')}
    entry.update({'licence': LICENCE, 'attribution': {'primary': dict(ATTRIBUTION), 'publisher': None},
                  'category': CATEGORY, 'provenance': 'curated', 'notes': notes(), 'tags': TAGS,
                  'fetched_at': got['pulled_at'],
                  'source_check': {**override(LAYER_ID), 'fingerprint': f'sha256={got["sha256"]}',
                                   'checked_at': got['pulled_at'], 'changed_at': None}})
    entry['refresh'] = refresh_block(entry, prev, got['pulled_at'])
    return entry


def manifest_entry(summ: dict) -> dict:
    names, sizes = summ['names'], summ['sizes']
    return {'id': LAYER_ID, 'name': level_meta()['label'], 'level': LEVEL, 'category': CATEGORY,
            'source': SOURCE, 'description': description(), 'unit': 'polygons', 'features': summ['rows'],
            'license': LICENCE, 'r2_prefix': R2_PREFIX,
            **pipeline.manifest_files(names, sizes),
            'source_url': DOI_URL, 'source_org': 'Huscroft, Gleeson, Hartmann and Börker (Borealis)',
            'source_version': f'Borealis {DOI} v{summ["pull"]["version"]}', 'notes': notes(), 'tags': TAGS}


def register(catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST,
             summary_path: Path = SUMMARY, r2_public: str | None = None) -> None:
    """Patch catalog.json + the manifest in place (never rebuild). Idempotent."""
    summ = json.loads(summary_path.read_text())
    pipeline.summary_names(summ)
    pipeline.register_layer(catalog_path, manifest_path,
                            lambda prev: catalog_entry(summ, prev, r2_public or pipeline.R2_PUBLIC),
                            manifest_entry(summ), level_meta(), as_built=True, level=LEVEL,
                            attribution=(SOURCE, ATTRIBUTION))


def main() -> None:
    pipeline.step_cli(__doc__, {
        'pull': lambda a: log(json.dumps(pull(RAW, pipeline.get_json, pipeline.download), indent=2)),
        'bake': lambda a: bake(), 'upload': lambda a: upload(), 'register': lambda a: register()})


if __name__ == '__main__':
    main()
