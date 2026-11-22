#!/usr/bin/env python3
"""
Bake atal_bhujal_wells: groundwater levels in the monitoring wells of the Atal
Bhujal Yojana (Atal Jal), pre- and post-monsoon 2015 to 2022, in metres below
ground level, for the scheme's seven States.

Source: data.gov.in, "Disclosed Ground Water Level Data under Atal Bhujal Yojana
from 2015 to 2022" (Ministry of Jal Shakti, Department of Water Resources, RD &
GR; resource f8b33b29-887e-45a3-a33d-6849d26038e1), GODL-India. data.gov.in
serves the file only after a login and its API has no record for it, so the
rows come from CoRE Stack's public copy: the GeoJSON its STAC item
borewells_vector (collection groundwater_layers) links on Google Drive, which
keeps the published columns. CoRE Stack is credited as the publisher.

The layer: every row and column as published (Sr No, Well_ID, the LGD-coded
State/District/Block/GP names, Village, Site_Name, TYPE, SOURCE, Aquifer,
Well_Depth (meters), Latitude, Longitude and the 16 seasonal levels). Columns
whose every value is a number become numbers ("NA" -> null). The file's own
geometry is empty, so the point is the published (Longitude, Latitude); a row
without them keeps a null geometry.

Pull: the STAC item must still name the pinned Drive file; the file is cached
under data/work with its sha256, so a second run fetches nothing.

Usage:
    python3 -u scripts/bake_atal_bhujal_wells.py pull
    python3 -u scripts/bake_atal_bhujal_wells.py bake
    python3 -u scripts/bake_atal_bhujal_wells.py upload      # md5-skip uploads to R2
    python3 -u scripts/bake_atal_bhujal_wells.py register    # patch catalog + manifest
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402
from bake_wbc1_water_bodies import NumericTracker, cast_sql  # noqa: E402
from pipeline import log, make_con  # noqa: E402

STAC_ITEM = ('https://spatio-temporal-asset-catalog.s3.ap-south-1.amazonaws.com/CorestackCatalogs_merged_collection/'
             'PanIndiaCatalogs/groundwater_layers/borewells_vector/borewells_vector.json')
DRIVE_ID = '1rps2DNzHqre7-5GGZ2Xj76iJ-n0Krkh_'
DOWNLOAD_URL = f'https://drive.usercontent.google.com/download?id={DRIVE_ID}&export=download&confirm=t'
DATAGOV_URL = 'https://www.data.gov.in/catalog/ground-water-level-data-under-atal-bhujal-yojana'
LAYER_ID = 'atal_bhujal_wells'
LEVEL = LAYER_ID
CATEGORY = 'water'
BASENAME = 'Atal_Bhujal_Wells'
R2_PREFIX = 'water/atal-bhujal-wells'
RAW = pipeline.work_dir(LAYER_ID, 'ATAL_BHUJAL_WORK')
CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
OUT_DIR = ROOT / 'data' / 'baked' / R2_PREFIX
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
SOURCE = 'Atal Bhujal Yojana (data.gov.in)'
LICENCE = 'GODL-India'
ATTRIBUTION = {'name': 'Atal Bhujal Yojana, Ministry of Jal Shakti (data.gov.in)', 'url': DATAGOV_URL}
VIA = {'name': 'CoRE Stack', 'url': 'https://core-stack.org/'}
TILE_FIELDS = ('Well_ID', 'Site_Name', 'TYPE', 'Well_Depth (meters)',
               'Pre-monsoon_2022 (meters below ground level)', 'Post-monsoon_2022 (meters below ground level)')
TAGS = ['groundwater', 'groundwater level', 'water table', 'wells', 'borewells', 'piezometers',
        'Atal Bhujal Yojana', 'Atal Jal', 'CGWB', 'depth to water']


# ── pull ─────────────────────────────────────────────────────────────────────

def pull(raw: Path, get_json: Callable[[str], dict], download: Callable[[str, Path], None],
         now: str | None = None) -> dict:
    """The file CoRE Stack's STAC item links, fetched once. The record keeps its
    pulled_at while the file's sha256 is the same."""
    href = get_json(STAC_ITEM)['assets']['drive-link']['href']
    if f'/d/{DRIVE_ID}/' not in href:
        raise ValueError(f'the STAC item now links {href}, not the pinned file {DRIVE_ID}: review it first')
    path = raw / 'borewells.geojson'
    if not path.exists():
        download(DOWNLOAD_URL, path)
    got = {'drive_id': DRIVE_ID, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'path': str(path)}
    record = raw / 'pull.json'
    prev = json.loads(record.read_text()) if record.exists() else {}
    if {k: v for k, v in prev.items() if k != 'pulled_at'} == got:
        return prev
    got['pulled_at'] = now or pipeline.now_iso()
    raw.mkdir(parents=True, exist_ok=True)
    pipeline.write_json(record, got)
    return got


def stac_json(url: str) -> dict:
    import urllib.request
    req = urllib.request.Request(url, headers={'User-Agent': pipeline.USER_AGENT})
    return pipeline.with_retries(lambda: json.loads(urllib.request.urlopen(req, timeout=60).read()))


# ── bake ─────────────────────────────────────────────────────────────────────

def build_table(con, src: Path, out: Path) -> int:
    """Every row, every published column in published order, all-number columns
    as numbers, and a point from Longitude/Latitude. Returns the row count."""
    features = json.loads(src.read_text())['features']
    if any((f.get('geometry') or {}).get('coordinates') for f in features):
        raise ValueError('the file now carries its own geometry: check it against Latitude/Longitude first')
    rows = [f['properties'] for f in features]
    cols = list(dict.fromkeys(c for r in rows for c in r))
    nums = NumericTracker(cols)
    for r in rows:
        nums.add(r)
    types = nums.types()
    ndjson = out.with_suffix('.ndjson')
    ndjson.write_text(''.join(json.dumps({c: None if r.get(c) is None else str(r[c]) for c in cols}) + '\n'
                              for r in rows))
    con.execute('INSTALL spatial; LOAD spatial;')
    schema = '{' + ', '.join(f"'{c}': 'VARCHAR'" for c in cols) + '}'
    sel = ', '.join(cast_sql(c, types.get(c)) for c in cols)
    point = ('CASE WHEN TRY_CAST("Longitude" AS DOUBLE) IS NULL OR TRY_CAST("Latitude" AS DOUBLE) IS NULL THEN NULL '
             'ELSE ST_Point(CAST("Longitude" AS DOUBLE), CAST("Latitude" AS DOUBLE)) END AS geometry')
    con.execute(f"""COPY (SELECT {sel}, {point} FROM read_json('{ndjson}', format = 'newline_delimited',
                                                               columns = {schema}))
                    TO '{out}' (FORMAT PARQUET)""")
    ndjson.unlink()
    return con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]


def bake(out_dir: Path = OUT_DIR) -> dict:
    import tempfile

    import bake_formats

    got = json.loads((RAW / 'pull.json').read_text())
    out_dir.mkdir(parents=True, exist_ok=True)
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    with tempfile.TemporaryDirectory(prefix='atal_bhujal_') as tmp:
        table = Path(tmp) / 'wells.parquet'
        log('reading the wells')
        build_table(make_con(), Path(got['path']), table)
        rows, prop_cols = pipeline.rebake_flatten_bbox(table, path['parquet'])
    con = make_con()
    states = dict(con.execute(f"""SELECT "State_Name_With_LGD_Code", count(*) FROM '{path['parquet']}'
                                  GROUP BY 1 ORDER BY 2 DESC""").fetchall())
    log(f'{rows} wells: {states}')
    files = bake_formats.write_all_formats(con, path, LAYER_ID, prop_cols, TILE_FIELDS)
    summary = {'rows': rows, 'states': states, 'pull': got, **files}
    pipeline.write_json(SUMMARY, summary)
    log(json.dumps(summary, indent=2))
    return summary


def upload(out_dir: Path = OUT_DIR) -> dict[str, str]:
    """Every format to its content-versioned key: unchanged files keep theirs (md5-skipped)."""
    return pipeline.upload_layer(out_dir, BASENAME, EXT, R2_PREFIX)


# ── register ─────────────────────────────────────────────────────────────────

def description() -> str:
    return ('Groundwater levels in about 5,500 Atal Bhujal Yojana monitoring wells in seven States, before and '
            'after each monsoon from 2015 to 2022, in metres below ground level, with well depth and aquifer.')


def notes() -> str:
    return ('Published on data.gov.in by the Ministry of Jal Shakti under GODL-India ("Disclosed Ground Water '
            'Level Data under Atal Bhujal Yojana from 2015 to 2022"). data.gov.in serves the file only after a '
            'login, so bharatlas takes the copy CoRE Stack republishes (STAC item borewells_vector), which '
            'keeps the published columns. Levels are metres below ground level: a larger number is a deeper '
            'water table. "NA" in the source is empty here; the 2022 columns also hold "dry" for a well that '
            'held no water, so they stay text. Some Well_ID values repeat, as published. '
            'The point is the published Latitude and Longitude. '
            'The States are Gujarat, Haryana, Karnataka, Madhya Pradesh, Maharashtra, Rajasthan and Uttar Pradesh.')


def level_meta() -> dict:
    return {'label': 'Groundwater levels, Atal Bhujal wells (2015-2022)', 'unit': 'wells',
            'description': description()}


def refresh_block(entry: dict, prev: dict, built_at: str) -> dict:
    from populate_refresh import infer, next_due
    block, _ = infer(entry)
    return {**block, 'audited_at': (prev.get('refresh') or {}).get('audited_at'),
            'next_due': next_due(block['rebuild'], built_at)}


def source_check() -> dict:
    from populate_source_check import OVERRIDES
    return dict(OVERRIDES[LAYER_ID])


def catalog_entry(summ: dict, prev: dict, r2_public: str) -> dict:
    names, sizes, got = summ['names'], summ['sizes'], summ['pull']
    entry = {'id': LAYER_ID, 'level': LEVEL, 'source': SOURCE, 'rows': summ['rows'],
             **pipeline.format_blocks(EXT, names, sizes, f'{r2_public}/{R2_PREFIX}')}
    entry.update({'licence': LICENCE, 'attribution': {'primary': dict(ATTRIBUTION), 'publisher': dict(VIA)},
                  'category': CATEGORY, 'provenance': 'curated', 'notes': notes(), 'tags': TAGS,
                  'fetched_at': got['pulled_at'],
                  'source_check': {**source_check(), 'fingerprint': f'sha256={got["sha256"]}',
                                   'checked_at': got['pulled_at'], 'changed_at': None}})
    entry['refresh'] = refresh_block(entry, prev, got['pulled_at'])
    return entry


def manifest_entry(summ: dict) -> dict:
    names, sizes = summ['names'], summ['sizes']
    return {'id': LAYER_ID, 'name': level_meta()['label'], 'level': LEVEL, 'category': CATEGORY,
            'source': SOURCE, 'description': description(), 'unit': 'wells', 'features': summ['rows'],
            'license': LICENCE, 'r2_prefix': R2_PREFIX,
            **pipeline.manifest_files(names, sizes),
            'source_url': DATAGOV_URL,
            'source_org': 'Ministry of Jal Shakti (Atal Bhujal Yojana), via CoRE Stack',
            'source_version': f'sha256 {summ["pull"]["sha256"][:12]}', 'notes': notes(), 'tags': TAGS}


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
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['pull', 'bake', 'upload', 'register'])
    a = ap.parse_args()
    if a.step == 'pull':
        log(json.dumps(pull(RAW, stac_json, lambda url, dest: pipeline.download(url, dest)), indent=2))
    elif a.step == 'bake':
        bake()
    elif a.step == 'upload':
        upload()
    else:
        register()


if __name__ == '__main__':
    main()
