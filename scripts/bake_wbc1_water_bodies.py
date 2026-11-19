#!/usr/bin/env python3
"""
Bake wbc1_water_bodies: one point per water body, 1st Census of Water Bodies
(reference year 2017-18), Ministry of Jal Shakti.

Source: data.gov.in catalogue "First Census of Water Bodies Data"
(32f2ec95-ddca-4254-86c6-449d4471efe1), one resource per State/UT, GODL-India.
The files themselves need a login, so rows come from the OGD API (key
OGD_API_KEY, else ~/Projects/rural/shc/.env; never printed or logged).

Every published column is kept under its published name; columns whose every
value is a number are cast to numbers ("NA" -> null); unique_id and
khasra_number stay text. The point is (longitude_dec, latitude_dec) as
published: points at (0,0) or outside India's bounding box are kept and
counted in the notes; rows without coordinates keep a null geometry.

Pull: each page is saved (gzip) as it arrives under data/raw/wbc1/<uuid>/, so a
stopped run resumes; a rerun with a full cache makes no request (--refresh
refetches). The pull stops itself cleanly at --max-minutes.

Usage:
    python3 -u scripts/bake_wbc1_water_bodies.py pull [--refresh] [--max-minutes 50]
    python3 -u scripts/bake_wbc1_water_bodies.py bake [--force]
    python3 -u scripts/bake_wbc1_water_bodies.py upload      # md5-skip uploads to R2
    python3 -u scripts/bake_wbc1_water_bodies.py register    # patch catalog + manifest
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Iterator

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import log  # noqa: E402
import pipeline  # noqa: E402
from pipeline import with_retries  # noqa: E402
from pipeline import cache_backup  # noqa: E402

CATALOG_UUID = '32f2ec95-ddca-4254-86c6-449d4471efe1'
LISTING_URL = ('https://www.data.gov.in/backend/dmspublic/v1/resources?format=json&limit=200'
               f'&filters[catalog_uuid]={CATALOG_UUID}')
CATALOG_PAGE = 'https://www.data.gov.in/catalog/first-census-water-bodies-data'
RAW = ROOT / 'data' / 'raw' / 'wbc1'
LIMIT = 5000

LAYER_ID = 'wbc1_water_bodies'
BASENAME = 'WBC1_Water_Bodies_2017_18'
R2_PREFIX = 'water/wbc1-water-bodies'
CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
OUT_DIR = ROOT / 'data' / 'baked' / R2_PREFIX
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'
WORK = ROOT / 'data'                                 # scratch space, outside data/baked/ (uploaded wholesale)
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
SOURCE = 'MIWing'
PUBLISHER = {'name': 'Open Government Data Platform India', 'url': CATALOG_PAGE}

LAT, LON = 'latitude_dec', 'longitude_dec'
STATE = 'State Name'
TEXT_COLS = {'unique_id', 'khasra_number'}           # codes: never cast
NA = ('', 'NA', 'NULL')                       # the files' null markers
NA_SQL = '(' + ', '.join(f"'{v}'" for v in NA) + ')'
PERSONAL = re.compile(r'owner_?name|person|phone|mobile|e-?mail|aadha|contact|father|husband', re.I)
INDIA_BBOX = (68.0, 6.0, 97.5, 37.5)                 # lon/lat bounds used for the notes' point counts
TILE_MAX_ZOOM = 13
# Popup fields only: many tile attributes make tippecanoe drop points at low zoom.
TILE_FIELDS = ('water_body_name', 'unique_id', STATE, 'District Name', 'Village Name',
               'ref_water_body_type_id_name', 'water_body_ownership_name', 'ref_water_body_in_use_id_name',
               'ref_selection_id_water_body_encroached_name', 'water_spread_area_of_water_body')

# 1st census report, Vol I (All-India), water bodies per State/UT, for the
# States/UTs whose data.gov.in API copy is checked against it.
CENSUS_TOTAL = 2_424_540
OFFICIAL = {'West Bengal': 747_480, 'Uttar Pradesh': 245_087, 'Andhra Pradesh': 190_777,
            'Odisha': 181_837, 'Assam': 172_492, 'Jharkhand': 107_598, 'Tamil Nadu': 106_957,
            'Maharashtra': 97_062, 'Himachal Pradesh': 88_017, 'Madhya Pradesh': 82_643,
            'Telangana': 64_055, 'Kerala': 55_734, 'Gujarat': 54_069, 'Bihar': 45_793,
            'Tripura': 36_239, 'Chhattisgarh': 34_000, 'Karnataka': 27_013, 'Rajasthan': 16_939,
            'Punjab': 16_012, 'Haryana': 14_898, 'Meghalaya': 13_332, 'Jammu and Kashmir': 9_765}

Fetcher = Callable[[int, int], dict]


class TimeUp(Exception):
    """The pull reached its own time limit; every page so far is saved."""


# ── pull ─────────────────────────────────────────────────────────────────────

def resources(listing: dict) -> list[dict]:
    """One {uuid, state, datafile} per State/UT resource, sorted by state."""
    out = [{'uuid': r['uuid'][0], 'state': r['title'][0].rsplit(' - ', 1)[-1].strip(),
            'datafile': (r.get('datafile') or [None])[0]} for r in listing['data']['rows']]
    return sorted(out, key=lambda r: r['state'])


def api_fetch(uuid: str, key: str, tries: int = 10) -> Fetcher:
    """Big pages (~13 MB) are often cut off mid-transfer (IncompleteRead), hence the many tries."""
    return lambda offset, limit: pipeline.datagov_get(uuid, key, tries=tries, timeout=300, offset=offset, limit=limit)


def _write_atomic(path: Path, data: bytes) -> None:
    part = path.with_name(path.name + '.part')
    part.write_bytes(data)
    os.replace(part, path)


def _page(cache: Path, offset: int) -> Path:
    return cache / f'offset_{offset:07d}.json.gz'


def pull_resource(cache: Path, fetch: Fetcher, limit: int = LIMIT, refresh: bool = False,
                  deadline: float | None = None, now: Callable[[], float] = time.monotonic) -> int:
    """Every record of one resource, one gzip page per offset saved as it
    arrives; meta.json (total, fields) once the first page is in. A rerun with
    a full cache makes no request. Raises TimeUp past `deadline`. Returns the total."""
    cache.mkdir(parents=True, exist_ok=True)
    meta_path = cache / 'meta.json'
    meta = None if refresh or not meta_path.exists() else json.loads(meta_path.read_text())

    def get(offset: int) -> dict:
        if deadline is not None and now() > deadline:
            raise TimeUp(f'{cache.name}: time limit reached at offset {offset:,}')
        resp = fetch(offset, limit)
        recs = resp.get('records') or []
        _write_atomic(_page(cache, offset), gzip.compress(json.dumps(recs).encode(), mtime=0))
        return resp

    if meta is None:
        first = get(0)
        meta = {'total': int(first.get('total') or 0), 'fields': first.get('field') or [],
                'status': first.get('status'), 'message': first.get('message')}
        if meta['total'] == 0:
            _page(cache, 0).unlink(missing_ok=True)
        _write_atomic(meta_path, json.dumps(meta, indent=1).encode())
        log(f'  {cache.name}: total {meta["total"]:,}')
    for offset in range(0, meta['total'], limit):
        if refresh and offset == 0:
            continue  # just fetched with the meta
        if refresh or not _page(cache, offset).exists():
            n = len(get(offset).get('records') or [])
            log(f'  {cache.name}: rows {offset:,}-{offset + n:,} of {meta["total"]:,}')
    return meta['total']


def cached_records(cache: Path) -> Iterator[dict]:
    for p in sorted(cache.glob('offset_*.json.gz')):
        yield from json.loads(gzip.decompress(p.read_bytes()))


def pull(refresh: bool = False, max_minutes: float = 50, workers: int = 4) -> None:
    """Every resource, `workers` at a time (the API takes ~20 s per page)."""
    from concurrent.futures import ThreadPoolExecutor
    deadline = time.monotonic() + max_minutes * 60
    RAW.mkdir(parents=True, exist_ok=True)
    listing_path = RAW / 'listing.json'
    if refresh or not listing_path.exists():
        req = urllib.request.Request(LISTING_URL, headers={'User-Agent': 'curl/8'})

        def listing() -> bytes:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        _write_atomic(listing_path, with_retries(listing))
    res = resources(json.loads(listing_path.read_text()))
    key = pipeline.datagov_api_key()

    def one(r: dict) -> int:
        n = pull_resource(RAW / r['uuid'], api_fetch(r['uuid'], key), refresh=refresh, deadline=deadline)
        log(f'done {r["state"]}: {n:,} records')
        return n

    try:
        with ThreadPoolExecutor(workers) as ex:
            total = sum(ex.map(one, res))
    except TimeUp as e:
        log(f'stopped at the time limit ({max_minutes} min): {e}. Rerun to continue.')
        sys.exit(3)
    log(f'pulled {total:,} records from {len(res)} resources')


# ── columns ──────────────────────────────────────────────────────────────────

def columns(metas: Iterable[dict]) -> list[str]:
    """Published column names in published order, union across resources. The
    API id can differ by State (a "_" prefix when the State types it differently);
    the published name does not."""
    return list(dict.fromkeys(f['name'] for m in metas for f in m['fields']))


def named(fields: list[dict], rec: dict) -> dict:
    """An API record keyed by published column name."""
    return {f['name']: rec[f['id']] for f in fields if f['id'] in rec}


def check_columns(names: list[str]) -> None:
    bad = [c for c in names if PERSONAL.search(c)]
    if bad:
        raise ValueError(f'personal data columns must never be published: {bad}')


class NumericTracker:
    """Which columns hold only numbers (ignoring null, blank and 'NA'), and of
    those, which hold only whole numbers. Codes in TEXT_COLS stay text."""

    def __init__(self, cols: list[str]):
        self.cols = [c for c in cols if c not in TEXT_COLS]
        self.seen: set[str] = set()
        self.bad: set[str] = set()
        self.fractional: set[str] = set()

    def add(self, rec: dict) -> None:
        for c in self.cols:
            if c in self.bad:
                continue
            v = rec.get(c)
            if v is None or isinstance(v, str) and v.strip().upper() in NA:
                continue
            try:
                if isinstance(v, bool):
                    raise ValueError
                x = float(v)
                if not math.isfinite(x):
                    raise ValueError
            except (TypeError, ValueError):
                self.bad.add(c)
                continue
            self.seen.add(c)
            if not x.is_integer():
                self.fractional.add(c)

    def numeric(self) -> list[str]:
        return [c for c in self.cols if c in self.seen and c not in self.bad]

    def types(self) -> dict[str, str]:
        return {c: 'DOUBLE' if c in self.fractional else 'BIGINT' for c in self.numeric()}


def text(v) -> str | None:
    return None if v is None else str(v)


def cast_sql(name: str, typ: str | None) -> str:
    q = f'"{name}"'
    if typ is None:
        return q
    num = f"CASE WHEN upper(trim({q})) IN {NA_SQL} THEN NULL ELSE CAST({q} AS DOUBLE) END"
    return f'({num})::{typ} AS {q}'


def coord_sql(col: str) -> str:
    """The coordinate as a number, or NULL. A few States publish some
    coordinates as degrees/minutes/seconds text ("17/41/29"); those rows keep
    the text in the column but get no point (no parsing of our own)."""
    return f'TRY_CAST("{col}" AS DOUBLE)'


def point_class_sql(lon: str, lat: str) -> str:
    """null (no numeric pair), invalid (not a place on Earth), zero (0,0),
    india (inside INDIA_BBOX) or outside."""
    x0, y0, x1, y1 = INDIA_BBOX
    return (f"CASE WHEN {lon} IS NULL OR {lat} IS NULL THEN 'null' "
            f"WHEN abs({lon}) > 180 OR abs({lat}) > 90 THEN 'invalid' "
            f"WHEN {lon} = 0 AND {lat} = 0 THEN 'zero' "
            f"WHEN {lon} BETWEEN {x0} AND {x1} AND {lat} BETWEEN {y0} AND {y1} THEN 'india' "
            "ELSE 'outside' END")


# ── KML ──────────────────────────────────────────────────────────────────────

def placemark_name(props: dict) -> str:
    name = props.get('water_body_name')
    if name is None or str(name).strip().upper() in NA:
        return f'Water body {props.get("unique_id")}'
    return str(name)


def placemark(props: dict, lon: float | None, lat: float | None) -> str:
    from bake_extracts import esc_xml
    data = ''.join(f'<Data name="{esc_xml(str(k))}"><value>{esc_xml(str(v))}</value></Data>'
                   for k, v in props.items() if v is not None and v != '')
    point = '' if lon is None or lat is None else f'<Point><coordinates>{lon},{lat}</coordinates></Point>'
    return f'<Placemark><name>{esc_xml(placemark_name(props))}</name><ExtendedData>{data}</ExtendedData>{point}</Placemark>'


def write_kml(con, parquet: Path, out: Path, batch: int = 50_000) -> int:
    from bake_extracts import esc_xml
    cur = con.execute(f"SELECT * EXCLUDE (geometry), ST_X(geometry), ST_Y(geometry) FROM read_parquet('{parquet}')")
    names = [d[0] for d in cur.description][:-2]
    n = 0
    with out.open('w', encoding='utf-8') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n')
        f.write(f'<Document><name>{esc_xml(LAYER_ID)}</name>')
        while rows := cur.fetchmany(batch):
            for r in rows:
                f.write(placemark(dict(zip(names, r[:-2])), r[-2], r[-1]))
            n += len(rows)
        f.write('</Document>\n</kml>\n')
    return n


# ── shapefile ────────────────────────────────────────────────────────────────

def needs_split(dbf_sizes: list[int], limit: int) -> bool:
    return any(s >= limit for s in dbf_sizes)


def write_shapefile_zip(con, parquet: Path, out: Path, prop_cols: list[str]) -> list[str]:
    """One shapefile; per-state shapefiles if its .dbf would reach 2 GB. Short
    DBF names with a columns.txt key. Returns the .shp names written."""
    import bake_formats
    from pipeline import DBF_MAX_BYTES, slug
    names = bake_formats.short_field_names(prop_cols)
    select = ', '.join(f'"{long}" AS "{short}"' for long, short in names.items())
    con.execute('SET geometry_always_xy = true')  # a caller's own connection may lack it (lat,lon otherwise)

    def write(where: str, params: list, shp: Path) -> None:
        con.execute(f"COPY (SELECT {select}, geometry FROM read_parquet('{parquet}') {where}) TO '{shp}' "
                    "WITH (FORMAT GDAL, DRIVER 'ESRI Shapefile', "
                    "LAYER_CREATION_OPTIONS ('ENCODING=UTF-8', 'RESIZE=YES'))", params)

    with tempfile.TemporaryDirectory(prefix='wbc1_shp_', dir=WORK) as tmp:
        d = Path(tmp)
        write('', [], d / f'{BASENAME}.shp')
        if needs_split([p.stat().st_size for p in d.glob('*.dbf')], DBF_MAX_BYTES):
            for p in d.iterdir():
                p.unlink()
            states = [s for (s,) in con.execute(
                f'SELECT DISTINCT "{STATE}" FROM read_parquet(\'{parquet}\') ORDER BY 1').fetchall()]
            for s in states:
                cond, params = (f'WHERE "{STATE}" IS NULL', []) if s is None else (f'WHERE "{STATE}" = ?', [s])
                write(cond, params, d / f'{BASENAME}_{slug(s)}.shp')
            assert not needs_split([p.stat().st_size for p in d.glob('*.dbf')], DBF_MAX_BYTES)
        written = sorted(p.name for p in d.glob('*.shp'))
        bake_formats.zip_with_key(d, out, bake_formats.shapefile_key(names))
    return written


# ── catalog ──────────────────────────────────────────────────────────────────

def description() -> str:
    return ('Ponds, tanks, lakes, reservoirs and check dams from the 1st Census of Water Bodies '
            '(reference year 2017-18): one point per water body with its type, ownership, use, '
            'storage, water spread, encroachment and repair or revival schemes.')


def notes(s: dict) -> str:
    p = s['points']
    partial = '; '.join(f'{st} {got:,} of {official:,}' for st, (got, official) in sorted(s['partial'].items()))
    missing = ' '.join(f'{st} is missing (the census counted {OFFICIAL[st]:,} there).' if st in OFFICIAL
                       else f'{st} is missing.' for st in s['missing'])
    no_point = p.get('null', 0) + p.get('invalid', 0)
    return (f'Incomplete: this layer holds {s["rows"]:,} of the {CENSUS_TOTAL:,} water bodies the 1st Census of '
            'Water Bodies counted, because its source, the data.gov.in API of the 1st Water Bodies Census, '
            'holds fewer for some States. '
            f'Partial States: {partial}. {missing} The data is complete for the other '
            f'{s["states"] - len(s["partial"])} States/UTs. '
            f'{no_point:,} records without usable coordinates are kept with no geometry (no point on the map). '
            '1st Census of Water Bodies (reference year 2017-18), Department of Water Resources, River '
            'Development and Ganga Rejuvenation and the Minor Irrigation (Statistics) Wing, Ministry of '
            'Jal Shakti, published per State/UT on data.gov.in under GODL-India and read through its '
            'API. Columns are as published ("NA" or "NULL" in a numeric column becomes empty); unique_id holds '
            "the census's own state/district/block/village codes, not LGD codes. "
            'The point is the enumerator\'s latitude_dec/longitude_dec as published (the manual asks '
            'for the north-west corner of the water body); many were keyed in by hand and some are '
            f'stacked on one spot. Of {s["rows"]:,} records: {p.get("india", 0):,} fall inside India\'s '
            f'bounding box, {p.get("outside", 0):,} outside it, {p.get("zero", 0):,} at (0,0), '
            f'{p.get("invalid", 0):,} have impossible values (beyond 180 degrees longitude or 90 latitude) '
            f'and {p.get("null", 0):,} have no numeric coordinates ({s["text_coords"]:,} of them give '
            'degrees/minutes/seconds text such as 17/41/29). '
            'A registry, not satellite mapping: compare with wris_waterbodies, do not treat them as the '
            'same features.')


def level_meta() -> dict:
    return {'label': 'Water Bodies (1st Census, 2017-18)', 'unit': 'water bodies', 'description': description()}


TAGS = ['water bodies', 'ponds', 'tanks', 'lakes', 'reservoirs', 'check dams', 'census of water bodies',
        'encroachment', 'irrigation', 'Jal Shakti', 'minor irrigation']


def catalog_entry(s: dict, fetched_at: str, r2_public: str, names: dict[str, str] | None = None) -> dict:
    names = names or pipeline.plain_names(BASENAME, EXT)
    from build_catalog import ATTR
    entry = {'id': LAYER_ID, 'level': LAYER_ID, 'source': SOURCE, 'rows': s['rows']}
    for fmt, ext in EXT.items():
        entry[fmt] = {'url': f'{r2_public}/{R2_PREFIX}/{names[fmt]}', 'bytes': s['sizes'][fmt]}
    entry.update({'licence': 'GODL-India', 'attribution': {'primary': dict(ATTR[SOURCE]), 'publisher': dict(PUBLISHER)},
                  'category': 'water', 'provenance': 'curated', 'fetched_at': fetched_at,
                  'notes': notes(s), 'tags': TAGS})
    return entry


def manifest_entry(s: dict, names: dict[str, str] | None = None) -> dict:
    names = names or pipeline.plain_names(BASENAME, EXT)
    from build_catalog import ATTR
    return {'id': LAYER_ID, 'name': level_meta()['label'], 'level': LAYER_ID, 'category': 'water',
            'source': SOURCE, 'description': description(), 'unit': 'water bodies', 'features': s['rows'],
            'license': 'GODL-India', 'r2_prefix': R2_PREFIX,
            'parquet_file': names['parquet'], 'parquet_bytes': s['sizes']['parquet'],
            'pmtiles_file': names['pmtiles'], 'pmtiles_bytes': s['sizes']['pmtiles'],
            'source_url': CATALOG_PAGE, 'source_org': ATTR[SOURCE]['name'], 'notes': notes(s), 'tags': TAGS}


def register(catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST,
             summary_path: Path = SUMMARY, r2_public: str | None = None) -> None:
    """Patch catalog.json + the manifest in place (never rebuild). Idempotent.
    Run only once every file is on R2 (the upload step)."""
    from build_catalog import ATTR
    s = json.loads(summary_path.read_text())
    names = pipeline.summary_names(s)
    entry = catalog_entry(s, s['fetched_at'], r2_public or pipeline.R2_PUBLIC, names=names)
    pipeline.register_layer(catalog_path, manifest_path, entry, manifest_entry(s, names=names), level_meta(),
                            attribution=(SOURCE, ATTR[SOURCE]))


# ── bake ─────────────────────────────────────────────────────────────────────

def input_fingerprint(res: list[dict]) -> str:
    h = hashlib.md5()
    for r in res:
        for p in sorted((RAW / r['uuid']).glob('*.json*')):
            h.update(f'{r["uuid"]}/{p.name}:{p.stat().st_size}'.encode())
    return h.hexdigest()


def coverage(res: list[dict], metas: dict[str, dict]) -> tuple[list[str], dict[str, list[int]]]:
    """States with no rows, and {state: [rows in API, official count]} where the API holds fewer."""
    missing = [r['state'] for r in res if metas[r['uuid']]['total'] == 0]
    partial = {r['state']: [metas[r['uuid']]['total'], OFFICIAL[r['state']]] for r in res
               if 0 < metas[r['uuid']]['total'] < OFFICIAL.get(r['state'], 0)}
    return missing, partial


def bake(out_dir: Path = OUT_DIR, force: bool = False) -> dict:
    import bake_formats
    from bake_extracts import gdal_geojson_available
    from bake_whole_layer import write_geojson_whole
    from pipeline import rebake_flatten_bbox

    res = resources(json.loads((RAW / 'listing.json').read_text()))
    metas = {r['uuid']: json.loads((RAW / r['uuid'] / 'meta.json').read_text()) for r in res}
    fingerprint = input_fingerprint(res)
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    if not force and SUMMARY.exists() and all(p.exists() for p in path.values()):
        prev = json.loads(SUMMARY.read_text())
        if prev.get('fingerprint') == fingerprint and prev.get('names'):  # names: the published keys
            log('inputs unchanged and every output exists: nothing to do (--force rebakes)')
            return prev

    cols = columns(metas[r['uuid']] for r in res)
    check_columns(cols)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='wbc1_', dir=WORK))
    try:
        tracker = NumericTracker(cols)
        ndjson = work / 'rows.ndjson'
        n_in = 0
        with ndjson.open('w', encoding='utf-8') as f:
            for r in res:
                fields = metas[r['uuid']]['fields']
                for rec in cached_records(RAW / r['uuid']):
                    row = named(fields, rec)
                    tracker.add(row)
                    f.write(json.dumps({n: text(row.get(n)) for n in cols}, ensure_ascii=False) + '\n')
                    n_in += 1
                log(f'  read {r["state"]}: {n_in:,} rows so far')
        types = tracker.types()
        log(f'numeric columns: {len(types)} of {len(cols)}')
        con = pipeline.make_con(temp_dir=work)
        src_cols = '{' + ', '.join(f"'{n}': 'VARCHAR'" for n in cols) + '}'
        select = ', '.join(cast_sql(n, types.get(n)) for n in cols)
        joined = work / 'joined.parquet'
        con.execute(f"""COPY (
            SELECT *, CASE WHEN {point_class_sql(coord_sql(LON), coord_sql(LAT))} NOT IN ('null', 'invalid')
                           THEN ST_Point({coord_sql(LON)}, {coord_sql(LAT)}) END AS geometry
            FROM (SELECT {select} FROM read_json('{ndjson}', format = 'newline_delimited',
                                                 columns = {src_cols}, maximum_object_size = 1048576))
        ) TO '{joined}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
        parquet = path['parquet']
        rows, prop_cols = rebake_flatten_bbox(joined, parquet, con)
        assert rows == n_in, (rows, n_in)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    con = pipeline.make_con()
    points = dict(con.execute(f"""SELECT {point_class_sql(coord_sql(LON), coord_sql(LAT))} AS c, count(*)
        FROM read_parquet('{parquet}') GROUP BY c""").fetchall())
    as_text = ' OR '.join(f"""({coord_sql(c)} IS NULL AND upper(trim("{c}"::VARCHAR)) NOT IN {NA_SQL})"""
                          for c in (LAT, LON))
    text_coords = con.execute(f"SELECT count(*) FROM read_parquet('{parquet}') WHERE {as_text}").fetchone()[0]
    log(f'points: {points}')

    path['geojson'].unlink(missing_ok=True)
    write_geojson_whole(con, parquet, path['geojson'], gdal_geojson_available(con))
    log('geojson written')
    assert write_kml(con, parquet, path['kml']) == rows
    log('kml written')
    shp_files = write_shapefile_zip(con, parquet, path['shapefile'], prop_cols)
    log(f'shapefile written: {len(shp_files)} file(s)')
    seq = WORK / f'{BASENAME}.tiles.geojsonl'
    try:
        props = ', '.join(f"'{c}': \"{c}\"" for c in TILE_FIELDS)
        con.execute(f"""COPY (SELECT 'Feature' AS type, ST_AsGeoJSON(geometry)::JSON AS geometry,
            {{{props}}} AS properties FROM read_parquet('{parquet}') WHERE geometry IS NOT NULL)
            TO '{seq}' (FORMAT JSON)""")
        args = bake_formats.pmtiles_args(seq, path['pmtiles'], LAYER_ID, TILE_FIELDS, parallel=True)
        args[args.index('-zg')] = f'-z{TILE_MAX_ZOOM}'
        path['pmtiles'].unlink(missing_ok=True)
        pipeline.run(args, timeout=pipeline.TOOL_TIMEOUT_S)
    finally:
        seq.unlink(missing_ok=True)
    log('pmtiles written')

    missing, partial = coverage(res, metas)
    summary = {'rows': rows, 'points': points, 'text_coords': text_coords, 'states': sum(1 for m in metas.values() if m['total']),
               'missing': missing, 'partial': partial,
               'numeric_columns': sorted(types), 'shapefiles': shp_files, 'fingerprint': fingerprint,
               'fetched_at': datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
               'resources': {r['state']: r['uuid'] for r in res},
               'sizes': {fmt: p.stat().st_size for fmt, p in path.items()},
               'names': pipeline.versioned_names(path)}
    SUMMARY.write_text(json.dumps(summary, indent=2))
    log(json.dumps({k: v for k, v in summary.items() if k not in ('resources', 'numeric_columns')}, indent=2))
    return summary


def local_paths(out_dir: Path) -> dict[str, Path]:
    return {fmt: out_dir / name for fmt, name in pipeline.plain_names(BASENAME, EXT).items()}


def upload(out_dir: Path = OUT_DIR) -> dict[str, str]:
    """Every format to its content-versioned key, by resumable multipart uploads:
    the multi-GB GeoJSON/KML kept losing the connection, and a plain upload
    starts over each time."""
    s3 = pipeline.r2_client(read_timeout=300, connect_timeout=60, retries={'max_attempts': 5, 'mode': 'standard'})
    return pipeline.upload_versioned(s3, local_paths(out_dir), R2_PREFIX, put=lambda s3, local, key:
                                     pipeline.r2_upload_resumable(s3, local, key, WORK / 'r2-uploads'))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['pull', 'bake', 'upload', 'register'])
    ap.add_argument('--refresh', action='store_true', help='refetch the listing and every page')
    ap.add_argument('--max-minutes', type=float, default=50, help='pull stops cleanly after this long')
    ap.add_argument('--workers', type=int, default=4, help='resources pulled at once')
    ap.add_argument('--force', action='store_true', help='rebake even if inputs are unchanged')
    a = ap.parse_args()
    if a.step == 'pull':
        with cache_backup(RAW, 'bake_wbc1_water_bodies'):
            pull(a.refresh, a.max_minutes, a.workers)
    elif a.step == 'bake':
        bake(force=a.force)
    elif a.step == 'upload':
        upload()
    else:
        register()


if __name__ == '__main__':
    main()
