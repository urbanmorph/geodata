#!/usr/bin/env python3
"""
Bake subsidence_megacities: InSAR vertical land motion points for five Indian
megacities (New Delhi, Mumbai, Bengaluru, Chennai, Kolkata).

Source: Sadhasivam, Ohenhen, Khorrami, Werth and Shirzaei, "Data for Vertical
Land Motion and Building Damage Risk for the Indian Megacities", Virginia Tech
data repository (figshare article 25856260, version 3, doi:10.7294/25856260.v3),
the data of Ohenhen et al. 2025, "Building damage risk in sinking Indian
megacities", Nature Sustainability (doi:10.1038/s41893-025-01663-0). Licence:
CC0 1.0, stated in the figshare API's `license` field for the article and in
the dataset's README.rtf ("License: CC0 1.0 Universal").

The layer: the five <City>_VLM_data.csv files, every row and column as
published (Longitude, Latitude, VLM_cm_per_yr: vertical land motion in cm per
year in the IGS14 frame, negative where the land sinks), plus `city` and a
point geometry from Longitude/Latitude. The building damage risk shapefiles of
the same article (130-415 MB zips of building footprints) are not in this layer.

Pull: the article version is pinned (VERSION); the API's file list gives each
CSV's md5, checked on download. Files are cached under data/work, so a second
run on the same version fetches nothing.

Usage:
    python3 -u scripts/bake_subsidence_megacities.py pull
    python3 -u scripts/bake_subsidence_megacities.py bake
    python3 -u scripts/bake_subsidence_megacities.py upload      # md5-skip uploads to R2
    python3 -u scripts/bake_subsidence_megacities.py register    # patch catalog + manifest
"""
from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402
from pipeline import log, make_con  # noqa: E402

ARTICLE = 25856260
VERSION = 3
API_URL = f'https://api.figshare.com/v2/articles/{ARTICLE}/versions/{VERSION}'
DOI_URL = f'https://doi.org/10.7294/{ARTICLE}.v{VERSION}'
PAPER_URL = 'https://doi.org/10.1038/s41893-025-01663-0'
# India's cities, in the order the article lists them; any other city's file is left out.
CITIES = {'New Delhi': 'New_Delhi_VLM_data.csv', 'Mumbai': 'Mumbai_VLM_data.csv',
          'Bengaluru': 'Bengaluru_VLM_data.csv', 'Chennai': 'Chennai_VLM_data.csv',
          'Kolkata': 'Kolkata_VLM_data.csv'}
COLUMNS = ['Longitude', 'Latitude', 'VLM_cm_per_yr']
LAYER_ID = 'subsidence_megacities'
LEVEL = 'subsidence_point'
CATEGORY = 'environment'
BASENAME = 'Subsidence_Megacities'
R2_PREFIX = f'environment/{LAYER_ID}'
RAW = pipeline.work_dir(LAYER_ID, 'SUBSIDENCE_WORK')
CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
OUT_DIR = ROOT / 'data' / 'baked' / R2_PREFIX
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
SOURCE = 'Ohenhen et al. 2025 (Virginia Tech)'
LICENCE = 'CC0-1.0'
ATTRIBUTION = {'name': 'Sadhasivam, Ohenhen, Khorrami, Werth and Shirzaei (Virginia Tech), data for Ohenhen et al. '
                       '2025, Nature Sustainability', 'url': DOI_URL}
TILE_FIELDS = ('city', 'VLM_cm_per_yr')
TILE_MAXZOOM = 14   # InSAR points tens of metres apart: z14 tiles are ~10 m steps
TAGS = ['subsidence', 'land subsidence', 'vertical land motion', 'InSAR', 'sinking cities',
        'Delhi', 'Mumbai', 'Bengaluru', 'Chennai', 'Kolkata', 'Nature Sustainability']


# ── pull ─────────────────────────────────────────────────────────────────────

def pull(raw: Path, get_json: Callable[[str], dict], download: Callable[[str, Path, str], None],
         now: str | None = None) -> dict:
    """Fetch India's VLM CSVs of the pinned article version once, each checked
    against the md5 figshare states. The record (raw/pull.json) keeps its
    pulled_at while the version and files are the same."""
    art = get_json(API_URL)
    licence = (art.get('license') or {}).get('name') or ''
    if art.get('version') != VERSION or 'CC0' not in licence:
        raise ValueError(f'figshare {ARTICLE}: expected version {VERSION} under CC0, got version '
                         f'{art.get("version")} under licence {licence!r}')
    by_name = {f['name']: f for f in art.get('files', [])}
    missing = [name for name in CITIES.values() if name not in by_name]
    if missing:
        raise ValueError(f'figshare {ARTICLE} v{VERSION} has no {", ".join(missing)}')
    files = {}
    for city, name in CITIES.items():
        f = by_name[name]
        csv = raw / f'v{VERSION}' / name
        if not csv.exists():
            download(f['download_url'], csv, f['computed_md5'])
        files[city] = {'name': name, 'id': f['id'], 'md5': f['computed_md5'], 'csv': str(csv)}
    got = {'article': ARTICLE, 'version': VERSION, 'doi': art.get('doi'), 'licence': licence,
           'modified_date': art.get('modified_date'), 'files': files}
    record = raw / 'pull.json'
    prev = json.loads(record.read_text()) if record.exists() else {}
    if {k: v for k, v in prev.items() if k != 'pulled_at'} == got:
        return prev
    got['pulled_at'] = now or pipeline.now_iso()
    raw.mkdir(parents=True, exist_ok=True)
    pipeline.write_json(record, got)
    return got


def figshare_json(url: str) -> dict:
    import urllib.request
    req = urllib.request.Request(url, headers={'User-Agent': pipeline.USER_AGENT})
    return pipeline.with_retries(lambda: json.loads(urllib.request.urlopen(req, timeout=60).read()))


def download_md5(url: str, dest: Path, md5: str) -> None:
    pipeline.download(url, dest, md5=md5)


# ── bake ─────────────────────────────────────────────────────────────────────

def build_table(con, csvs: dict[str, Path], out: Path) -> dict[str, int]:
    """Every city's rows in file order, each column as published (all numbers),
    then the city and a point geometry. Returns the rows per city."""
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute('CREATE OR REPLACE TEMP TABLE vlm ({}, city VARCHAR)'.format(', '.join(f'"{c}" DOUBLE' for c in COLUMNS)))
    sel = ', '.join(f'CAST("{c}" AS DOUBLE)' for c in COLUMNS)
    for city, csv in csvs.items():   # one insert per city in turn: the table keeps file order (insertion order)
        cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_csv('{csv}', all_varchar = true)").fetchall()]
        if cols != COLUMNS:
            raise ValueError(f'{city}: columns {cols}, expected {COLUMNS}')
        con.execute(f"INSERT INTO vlm SELECT {sel}, ? FROM read_csv('{csv}', all_varchar = true)", [city])
    con.execute(f"COPY (SELECT *, ST_Point(Longitude, Latitude) AS geometry FROM vlm) TO '{out}' (FORMAT PARQUET)")
    rows = con.execute(f"SELECT city, count(*) FROM '{out}' GROUP BY city").fetchall()
    n = dict(rows)
    return {city: n[city] for city in csvs if city in n}


def bake(out_dir: Path = OUT_DIR) -> dict:
    import tempfile

    import bake_formats

    got = json.loads((RAW / 'pull.json').read_text())
    out_dir.mkdir(parents=True, exist_ok=True)
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    with tempfile.TemporaryDirectory(prefix='subsidence_') as tmp:
        table = Path(tmp) / 'vlm.parquet'
        log('reading the five city CSVs')
        cities = build_table(make_con(), {c: Path(f['csv']) for c, f in got['files'].items()}, table)
        log(f'rows per city: {cities}')
        rows, prop_cols = pipeline.rebake_flatten_bbox(table, path['parquet'])
    con = make_con()
    files = bake_formats.write_all_formats(con, path, LAYER_ID, prop_cols, TILE_FIELDS, max_zoom=TILE_MAXZOOM)
    summary = {'rows': rows, 'cities': cities,
               'pull': {k: got[k] for k in ('article', 'version', 'doi', 'licence', 'modified_date', 'pulled_at')}, **files}
    pipeline.write_json(SUMMARY, summary)
    log(json.dumps(summary, indent=2))
    return summary


def upload(out_dir: Path = OUT_DIR) -> dict[str, str]:
    """Every format to its content-versioned key: unchanged files keep theirs (md5-skipped)."""
    return pipeline.upload_layer(out_dir, BASENAME, EXT, R2_PREFIX)


# ── register ─────────────────────────────────────────────────────────────────

def description() -> str:
    return ('Land subsidence in Delhi, Mumbai, Bengaluru, Chennai and Kolkata: InSAR vertical land '
            'motion points in cm/yr (negative values mean the ground is sinking), from Ohenhen et al. 2025.')


def notes() -> str:
    return ('Data of Ohenhen et al. 2025, "Building damage risk in sinking Indian megacities", Nature '
            f'Sustainability ({PAPER_URL}), published on the Virginia Tech data repository (figshare article '
            f'{ARTICLE}, version {VERSION}) under CC0 1.0. Every point of the five <City>_VLM_data.csv files as '
            'published: Longitude, Latitude and VLM_cm_per_yr, the vertical land motion in cm/yr in the IGS14 '
            'reference frame, negative where the land sinks and positive where it rises. bharatlas adds the '
            'city column. Some points repeat a coordinate with different values, and a few Mumbai points have '
            'no value (NaN), as in the source. The same '
            'dataset also holds building damage risk shapefiles per city, not included here.')


def level_meta() -> dict:
    return {'label': 'Land subsidence, five megacities (InSAR)', 'unit': 'points', 'description': description()}


def refresh_block(entry: dict, prev: dict, built_at: str) -> dict:
    from populate_refresh import infer, next_due
    block, _ = infer(entry)
    return {**block, 'audited_at': (prev.get('refresh') or {}).get('audited_at'),
            'next_due': next_due(block['rebuild'], built_at)}


def catalog_entry(summ: dict, prev: dict, r2_public: str) -> dict:
    names, sizes, got = summ['names'], summ['sizes'], summ['pull']
    entry = {'id': LAYER_ID, 'level': LEVEL, 'source': SOURCE, 'rows': summ['rows'],
             **pipeline.format_blocks(EXT, names, sizes, f'{r2_public}/{R2_PREFIX}')}
    entry.update({'licence': LICENCE, 'attribution': {'primary': dict(ATTRIBUTION), 'publisher': None},
                  'category': CATEGORY, 'provenance': 'curated', 'notes': notes(), 'tags': TAGS,
                  'fetched_at': got['pulled_at'],
                  'source_check': {**source_check(), 'fingerprint': f'version={got["version"]}',
                                   'checked_at': got['pulled_at'], 'changed_at': got['modified_date']}})
    entry['refresh'] = refresh_block(entry, prev, got['pulled_at'])
    return entry


def source_check() -> dict:
    """{method, url, reason} as populate_source_check.py records it, so a re-run there keeps the fingerprint."""
    from populate_source_check import OVERRIDES
    return dict(OVERRIDES[LAYER_ID])


def manifest_entry(summ: dict) -> dict:
    names, sizes = summ['names'], summ['sizes']
    return {'id': LAYER_ID, 'name': level_meta()['label'], 'level': LEVEL, 'category': CATEGORY,
            'source': SOURCE, 'description': description(), 'unit': 'points', 'features': summ['rows'],
            'license': LICENCE, 'r2_prefix': R2_PREFIX,
            **pipeline.manifest_files(names, sizes),
            'source_url': DOI_URL, 'source_org': 'Virginia Tech (University Libraries)',
            'source_version': f'figshare {ARTICLE} v{summ["pull"]["version"]}', 'notes': notes(), 'tags': TAGS}


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
        log(json.dumps(pull(RAW, figshare_json, download_md5), indent=2))
    elif a.step == 'bake':
        bake()
    elif a.step == 'upload':
        upload()
    else:
        register()


if __name__ == '__main__':
    main()
