#!/usr/bin/env python3
"""
Bake gem_active_faults: the active fault traces of the GEM Global Active Faults
Database (GEM GAF-DB) that touch India.

Source: GEM Foundation, GEMScienceTools/gem-global-active-faults on GitHub,
geojson/gem_active_faults.geojson (the README calls the GeoJSON the version of
record), pinned at the commit that last changed it and by its sha256. Licence:
CC BY-SA 4.0, stated in the repository's LICENSE.txt and README ("a Creative
Commons attribution sharealike license") and read from the GitHub licence API
on every pull. GEM asks to be cited as Styron and Pagani 2020, Earthquake
Spectra (doi:10.1177/8755293020944182).

The layer: every fault trace (LineString) that intersects India as bharatlas
publishes it (the india_boundary layer, claimed areas included), whole, not cut
at the border, with every published column in the order the file first names
it. Columns whose every value is a number become numbers; the (most likely,
min, max) tuples stay text as published.

Pull: the newest commit touching the file must still be the pinned one, the
licence must still be CC-BY-SA-4.0, and the file must match the pinned sha256.
The file and the boundary parquet are cached under data/work, so a second run
fetches nothing.

Usage:
    python3 -u scripts/bake_gem_active_faults.py pull
    python3 -u scripts/bake_gem_active_faults.py bake
    python3 -u scripts/bake_gem_active_faults.py upload      # md5-skip uploads to R2
    python3 -u scripts/bake_gem_active_faults.py register    # patch catalog + manifest
"""
from __future__ import annotations

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

REPO = 'GEMScienceTools/gem-global-active-faults'
FILE = 'geojson/gem_active_faults.geojson'
FILE_NAME = Path(FILE).name
COMMIT = '850fd05b48841eb806d61a37043b5567f5bb99dd'   # "added Malawi faults", 2021-06-24: the file's newest
SHA256 = '603513086b4693de6008e3444959995c34683b30dac291856340522a76d8505e'
RAW_URL = f'https://raw.githubusercontent.com/{REPO}/{COMMIT}/{FILE}'
COMMITS_URL = f'https://api.github.com/repos/{REPO}/commits?path={FILE}&per_page=1'
LICENCE_URL = f'https://api.github.com/repos/{REPO}/license'
CHECK_URL = f'https://github.com/{REPO}/tree/master/{FILE}'
REPO_URL = f'https://github.com/{REPO}'
PAPER_DOI = '10.1177/8755293020944182'
LAYER_ID = 'gem_active_faults'
LEVEL = 'active_fault'
CATEGORY = 'environment'   # with seismic_zones
BASENAME = 'GEM_Active_Faults'
R2_PREFIX = 'environment/gem-active-faults'
RAW = pipeline.work_dir(LAYER_ID, 'GEM_FAULTS_WORK')
CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
OUT_DIR = ROOT / 'data' / 'baked' / R2_PREFIX
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
SOURCE = 'GEM Global Active Faults'
LICENCE = 'CC-BY-SA-4.0'
ATTRIBUTION = {'name': 'GEM Foundation, GEM Global Active Faults Database (Styron and Pagani 2020)', 'url': REPO_URL}
TILE_FIELDS = ('catalog_id', 'fs_name', 'slip_type', 'net_slip_rate', 'catalog_name')   # `name` is empty in India
TILE_MAXZOOM = 12
TAGS = ['active faults', 'faults', 'fault lines', 'earthquakes', 'seismic hazard', 'tectonics', 'Himalaya',
        'Main Frontal Thrust', 'GEM', 'Global Earthquake Model']


# ── pull ─────────────────────────────────────────────────────────────────────

def india_boundary_url(catalog_path: Path = CATALOG) -> str:
    """India as bharatlas publishes it: the india_boundary layer's parquet."""
    layers = json.loads(catalog_path.read_text())['layers']
    return next(x for x in layers if x['id'] == 'india_boundary')['parquet']['url']


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pull(raw: Path, get_json: Callable[[str], object], download: Callable[[str, Path], None],
         boundary_url: str, now: str | None = None) -> dict:
    """The pinned file and India's boundary, each fetched once. Stops when the file
    has a newer commit, the licence is no longer CC BY-SA 4.0, or the bytes are not
    the pinned ones. The record keeps its pulled_at while nothing changed."""
    commits = get_json(COMMITS_URL)
    newest = commits[0]['sha'] if commits else None
    if newest != COMMIT:
        raise ValueError(f'{FILE} now has commit {newest}, not the pinned {COMMIT}: review it first')
    licence = (get_json(LICENCE_URL).get('license') or {}).get('spdx_id')
    if licence != LICENCE:
        raise ValueError(f'{REPO} now states licence {licence}, not {LICENCE}: review it first')
    path = raw / COMMIT / FILE_NAME
    if not path.exists():
        download(RAW_URL, path)
    if sha256_of(path) != SHA256:
        path.unlink()
        raise ValueError(f'{FILE_NAME} at {COMMIT} does not match the pinned sha256 {SHA256}; deleted')
    bpath = raw / boundary_url.rsplit('/', 1)[-1]
    if not bpath.exists():
        download(boundary_url, bpath)
    got = {'commit': COMMIT, 'committed_at': commits[0]['commit']['committer']['date'], 'sha256': SHA256,
           'licence': licence, 'path': str(path),
           'boundary': {'url': boundary_url, 'sha256': sha256_of(bpath), 'path': str(bpath)}}
    record = raw / 'pull.json'
    prev = json.loads(record.read_text()) if record.exists() else {}
    if {k: v for k, v in prev.items() if k != 'pulled_at'} == got:
        return prev
    got['pulled_at'] = now or pipeline.now_iso()
    raw.mkdir(parents=True, exist_ok=True)
    pipeline.write_json(record, got)
    return got


def github_json(url: str):
    import urllib.request
    req = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json',
                                               'User-Agent': pipeline.USER_AGENT})
    return pipeline.with_retries(lambda: json.loads(urllib.request.urlopen(req, timeout=60).read()))


# ── bake ─────────────────────────────────────────────────────────────────────

def build_table(con, src: Path, boundary: Path, out: Path) -> int:
    """The traces that intersect the boundary, whole and in file order, every
    published column in the order the file first names it, all-number columns
    as numbers. Returns the row count."""
    features = json.loads(src.read_text())['features']
    cols = list(dict.fromkeys(c for f in features for c in f['properties']))
    if {'geometry', '_ord', '_geom'} & set(cols):
        raise ValueError(f'{src.name}: a column name clashes with the bake\'s own: {cols}')
    ndjson = out.with_suffix('.ndjson')
    ndjson.write_text(''.join(
        json.dumps({'_ord': i, '_geom': json.dumps(f['geometry']),
                    **{c: None if f['properties'].get(c) is None else str(f['properties'][c]) for c in cols}}) + '\n'
        for i, f in enumerate(features)))
    con.execute('INSTALL spatial; LOAD spatial;')
    schema = "{'_ord': 'BIGINT', '_geom': 'VARCHAR', " + ', '.join(f"'{c}': 'VARCHAR'" for c in cols) + '}'
    con.execute(f"""CREATE OR REPLACE TEMP TABLE kept AS
        SELECT * FROM (SELECT * EXCLUDE (_geom), ST_GeomFromGeoJSON(_geom) AS geometry
                       FROM read_json('{ndjson}', format = 'newline_delimited', columns = {schema}))
        WHERE ST_Intersects(geometry, (SELECT ST_Union_Agg(geometry::GEOMETRY) FROM read_parquet('{boundary}')))""")
    ndjson.unlink()
    quoted = ', '.join(f'"{c}"' for c in cols)
    nums = NumericTracker(cols)
    for row in con.execute(f'SELECT {quoted} FROM kept').fetchall():
        nums.add(dict(zip(cols, row)))
    types = nums.types()
    sel = ', '.join(cast_sql(c, types.get(c)) for c in cols)
    con.execute(f"COPY (SELECT {sel}, geometry FROM kept ORDER BY _ord) TO '{out}' (FORMAT PARQUET)")
    return con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]


def bake(out_dir: Path = OUT_DIR) -> dict:
    import tempfile

    import bake_formats

    got = json.loads((RAW / 'pull.json').read_text())
    out_dir.mkdir(parents=True, exist_ok=True)
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    with tempfile.TemporaryDirectory(prefix='gem_faults_') as tmp:
        table = Path(tmp) / 'faults.parquet'
        log('selecting the faults that touch India')
        build_table(make_con(), Path(got['path']), Path(got['boundary']['path']), table)
        rows, prop_cols = pipeline.rebake_flatten_bbox(table, path['parquet'])
    con = make_con()
    catalogs = dict(con.execute(f"""SELECT catalog_name, count(*) FROM '{path['parquet']}'
                                    GROUP BY 1 ORDER BY 2 DESC, 1""").fetchall())
    log(f'{rows} faults: {catalogs}')
    log('geojson, kml, shapefile, pmtiles')
    files = bake_formats.write_all_formats(con, path, LAYER_ID, prop_cols, TILE_FIELDS, max_zoom=TILE_MAXZOOM, keep_all=True)
    summary = {'rows': rows, 'catalogs': catalogs, 'pull': got, **files}
    pipeline.write_json(SUMMARY, summary)
    log(json.dumps(summary, indent=2))
    return summary


def upload(out_dir: Path = OUT_DIR) -> dict[str, str]:
    """Every format to its content-versioned key: unchanged files keep theirs (md5-skipped)."""
    return pipeline.upload_layer(out_dir, BASENAME, EXT, R2_PREFIX)


# ── register ─────────────────────────────────────────────────────────────────

def description() -> str:
    return ('Active fault traces that touch India, from the GEM Global Active Faults Database (Styron and Pagani '
            '2020): the Himalayan front, Ladakh and the Karakoram, Kashmir, Kutch and the North-East, with slip type '
            'and, for some, dip, rake and slip rate.')


def notes() -> str:
    return ('From the GEM Foundation\'s Global Active Faults Database (GEM GAF-DB), published on GitHub '
            f'({REPO}, file {FILE} at commit {COMMIT[:7]}, June 2021) under CC BY-SA 4.0. Cite it as GEM asks: '
            'Styron, Richard, and Marco Pagani. "The GEM Global Active Faults Database." Earthquake Spectra, '
            f'vol. 36, no. 1_suppl, Oct. 2020, pp. 160-180, doi:{PAPER_DOI}. '
            'bharatlas keeps every fault trace in the file that touches India as bharatlas shows it (the India '
            'boundary layer, claimed areas included), whole, not cut at the border, with every column as '
            'published. Dip, rake, slip rates and depths are (most likely, minimum, maximum) text, as published. '
            'In and around India the traces come from HimaTibetMap (Styron et al. 2010), the Earthquake Model of '
            'the Middle East (EMME) and a Southeast Asia compilation. The database maps no faults in peninsular '
            'India or the Andaman and Nicobar Islands. slip_type also names folds (Anticline), and some columns '
            '(name, accuracy and others) are empty for every trace here, as published. GEM also '
            'publishes a "harmonized" file with some of these traces left out; this layer is the full file. '
            'Share-alike: anything you make from this layer and share must carry the same licence (CC BY-SA 4.0) '
            'and credit GEM.')


def level_meta() -> dict:
    return {'label': 'Active faults (GEM)', 'unit': 'faults', 'description': description()}


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
    entry.update({'licence': LICENCE, 'attribution': {'primary': dict(ATTRIBUTION), 'publisher': None},
                  'category': CATEGORY, 'provenance': 'curated', 'notes': notes(), 'tags': TAGS,
                  'fetched_at': got['pulled_at'],
                  'source_check': {**source_check(), 'fingerprint': f'commit={got["commit"]}',
                                   'checked_at': got['pulled_at'], 'changed_at': got['committed_at']}})
    entry['refresh'] = refresh_block(entry, prev, got['pulled_at'])
    return entry


def manifest_entry(summ: dict) -> dict:
    names, sizes = summ['names'], summ['sizes']
    return {'id': LAYER_ID, 'name': level_meta()['label'], 'level': LEVEL, 'category': CATEGORY,
            'source': SOURCE, 'description': description(), 'unit': 'faults', 'features': summ['rows'],
            'license': LICENCE, 'r2_prefix': R2_PREFIX,
            **pipeline.manifest_files(names, sizes),
            'source_url': REPO_URL, 'source_org': 'GEM Foundation',
            'source_version': f'commit {summ["pull"]["commit"][:7]}, sha256 {summ["pull"]["sha256"][:12]}',
            'notes': notes(), 'tags': TAGS}


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
        'pull': lambda a: log(json.dumps(pull(RAW, github_json, lambda url, dest: pipeline.download(url, dest),
                                              india_boundary_url()), indent=2)),
        'bake': lambda a: bake(), 'upload': lambda a: upload(), 'register': lambda a: register()})


if __name__ == '__main__':
    main()
