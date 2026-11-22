#!/usr/bin/env python3
"""
Bake two CoRE Stack micro-watershed layers, as CoRE Stack publishes them:

  core_mws_water_balance  "Annual water balance" (STAC item <s>_<d>_<t>_change_in_well_depth_vector):
                          per micro-watershed and hydrological year 2017-18 to 2024-25, a JSON string of
                          Precipitation, RunOff, ET, DeltaG, G and WellDepth (mm; WellDepth in m), the net
                          change in depth to water over 5-year windows (Net2017_22 ... Net2020_25) and the
                          aquifer's weighted average yield.
  core_mws_drought        "Drought frequency" (STAC item <s>_<d>_<t>_drought_frequency_vector): per
                          micro-watershed and year 2017-2022 (2024 in most tehsils), weeks in no/mild/moderate/severe drought,
                          drought frequency and intensity at four thresholds, dry spells, monsoon onset,
                          kharif sown area and weekly rainfall deviation, after the 2016 Manual for Drought
                          Management.

Source: CoRE Stack (core-stack.org) computes both itself (from GSMaP rainfall, FLDAS evapotranspiration,
CHIRPS, Landsat, MODIS and its IndiaSAT land cover) and serves them per tehsil from its GeoServer
(geoserver.core-stack.org). Its tehsil-wise STAC catalogue (public S3 bucket spatio-temporal-asset-catalog,
CorestackCatalogs_merged_collection/tehsil_wise) names one item per tehsil and layer, and every state's
collection states licence CC-BY-4.0 with CoRE Stack as provider. CoRE Stack is credited.

The layer: every tehsil file's features, every published column in the order the files give them
(columns a later file adds go after; files differ a little, e.g. weighted_a for weighted_avg_yeild, kept
apart as published), with `stac_state`, `stac_district` and `stac_tehsil` from the item's STAC path in front
so a row can be traced to its file. Columns whose every value is a number become numbers ("NA" ->
null); the JSON strings stay text, as published. A micro-watershed that crosses a tehsil boundary is in
each tehsil's file, so it can appear more than once (same uid), as published.

Pull: the bucket listing (cached once in data/work/core_mws/index.json; delete it to look again), each
state's licence (must stay CC-BY-4.0 from CoRE Stack), then each tehsil's STAC item and the GeoServer file
its `data` asset names. Each file is kept gzipped with the sha256 of the bytes served, as it arrives, and
backed up to R2 (cache/core_mws) every 10 minutes and on exit. A second run fetches nothing. A tehsil
whose GeoServer answer is an error page is recorded as unavailable (delete its .json to try again).
--max-minutes (default 150) stops the run cleanly between tehsils.

Usage:
    python3 -u scripts/bake_core_mws.py pull     [--layer ID] [--max-minutes N]
    python3 -u scripts/bake_core_mws.py bake     [--layer ID]
    python3 -u scripts/bake_core_mws.py upload   [--layer ID]   # new content-versioned keys only
    python3 -u scripts/bake_core_mws.py register [--layer ID]   # patch catalog + manifest
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import sys
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402
from bake_wbc1_water_bodies import NumericTracker, cast_sql  # noqa: E402
from pipeline import log, make_con  # noqa: E402

S3 = 'https://spatio-temporal-asset-catalog.s3.ap-south-1.amazonaws.com/'
TEHSIL_WISE = 'CorestackCatalogs_merged_collection/tehsil_wise'
STAC_URL = f'{S3}{TEHSIL_WISE}/catalog.json'
GEOSERVER = 'https://geoserver.core-stack.org:8443/geoserver/'
CORE = {'name': 'CoRE Stack', 'url': 'https://core-stack.org/'}
LICENCE = 'CC-BY-4.0'
SOURCE = 'CoRE Stack'
PLACE = ('state', 'district', 'tehsil')
PLACE_COLS = {k: f'stac_{k}' for k in PLACE}   # added columns: the item's STAC path
CRS_OK = ('EPSG::4326', 'EPSG:4326', 'CRS84')
RAW = pipeline.work_dir('core_mws', 'CORE_MWS_WORK')
CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
WORKERS = 4          # GeoServer is CoRE Stack's own: a few requests at a time
DBF_TEXT_MAX = 254   # a .dbf text field holds at most 254 bytes
DBF_FIELDS_MAX = 255

COMMON_NOTE = ('CoRE Stack computes this layer itself and publishes it per tehsil on its GeoServer, listed in its '
               'tehsil-wise STAC files, under CC-BY-4.0. bharatlas puts every tehsil file together as '
               'published: one row per micro-watershed per tehsil file, every column as published, with stac_state, '
               'stac_district and stac_tehsil added from the STAC path (CoRE Stack\'s spelling). A micro-watershed that '
               'crosses a tehsil boundary is in each tehsil\'s file, so the same uid can appear more than once, '
               'with values CoRE Stack computed for that tehsil. '
               'CoRE Stack covers the tehsils it has computed so far, not all of India. Methods: CoRE Stack\'s '
               'technical manual and code (github.com/core-stack-org).')


@dataclass(frozen=True)
class Spec:
    id: str
    kind: str            # the STAC item name's suffix
    label: str
    basename: str
    category: str
    description: str
    note: str
    tile_fields: tuple[str, ...]
    tags: tuple[str, ...]

    @property
    def r2_prefix(self) -> str:
        return f'{self.category}/{self.id.replace("_", "-")}'

    @property
    def summary_path(self) -> Path:
        return ROOT / 'data' / f'{self.id}.summary.json'

    @property
    def out_dir(self) -> Path:
        return ROOT / 'data' / 'baked' / self.r2_prefix


LAYERS = {s.id: s for s in (
    Spec(id='core_mws_water_balance', kind='change_in_well_depth_vector',
         label='Water balance by micro-watershed (CoRE Stack, 2017-2025)',
         basename='CoRE_MWS_Water_Balance', category='water',
         description=('Yearly water balance for each micro-watershed CoRE Stack has mapped, 2017-18 to 2024-25: '
                      'rainfall, runoff, evapotranspiration, the change in groundwater and the estimated change '
                      'in depth to water, with net change over 5-year windows.'),
         note=('Each year column (2017_2018 to 2024_2025, July to June) holds a JSON string with Precipitation, '
               'RunOff, ET, DeltaG and G in mm and WellDepth in metres: the water balance is rainfall minus '
               'runoff minus evapotranspiration, and WellDepth turns it into a change in depth to water using '
               'the aquifer\'s specific yield (weighted_avg_yeild, spelled as published; some tehsil files name it '
               'weighted_a, and a few add their own STATE, District and TEHSIL columns, all kept as published). Net2017_22 to '
               'Net2020_25 are the net change in depth to water in metres over each 5-year window; where the '
               'aquifer\'s yield is near zero they run very large (about 110 beyond 1,000 m), as published. '
               'CoRE Stack notes this counts only vertical flow, not water moving underground between '
               'micro-watersheds. Rainfall is from JAXA GSMaP, evapotranspiration from the FLDAS Noah land '
               'surface model (NASA, USGS). '),
         tile_fields=('stac_state', 'stac_district', 'stac_tehsil', 'uid', 'area_in_ha',
                      'Net2017_22', 'Net2018_23', 'Net2019_24', 'Net2020_25'),
         tags=('water balance', 'groundwater', 'groundwater recharge', 'depth to water', 'well depth',
               'evapotranspiration', 'runoff', 'rainfall', 'micro-watershed', 'watershed', 'hydrology',
               'CoRE Stack')),
    Spec(id='core_mws_drought', kind='drought_frequency_vector',
         label='Drought by micro-watershed (CoRE Stack, 2017-2024)',
         basename='CoRE_MWS_Drought', category='agriculture',
         description=('Drought weeks for each micro-watershed CoRE Stack has mapped, each monsoon from 2017 to '
                      '2022 or 2024: weeks in mild, moderate and severe drought, dry spells, monsoon onset, kharif sown '
                      'area and weekly rainfall deviation.'),
         note=('CoRE Stack follows the Manual for Drought Management (2016, Ministry of Agriculture and Farmers '
               'Welfare), using CHIRPS rainfall, Landsat vegetation, MODIS crop data and IndiaSAT land cover. '
               'Per year: w_no, w_mld, w_mod and w_sev are weeks in no, mild, moderate and severe drought out '
               'of t_wks weeks analysed; drlb holds the weekly drought labels (0 none, 1 mild, 2 moderate, '
               '3 severe); frth0 to frth3 and inth0 to inth3 are drought frequency and intensity at thresholds '
               '0 to 3; drysp is dry spell length; m_ons the monsoon onset date; kh_cr kharif cropped area in '
               'sq km and pcr_k its percent; columns rdYY-M-D are the rainfall deviation in percent for the '
               'week starting that date. Most tehsils run to 2024, about a third stop at 2022, so a later year\'s '
               'columns are empty where a tehsil has no data; the weekly columns differ by tehsil, as published. '),
         tile_fields=('stac_state', 'stac_district', 'stac_tehsil', 'uid', 'area_in_ha',
                      'w_sev_2022', 'w_mod_2022', 'w_mld_2022', 'w_sev_2021', 'w_mod_2021', 'drysp_2022'),
         tags=('drought', 'drought frequency', 'dry spell', 'monsoon', 'monsoon onset', 'rainfall deviation',
               'kharif', 'micro-watershed', 'watershed', 'agriculture', 'climate', 'CoRE Stack')),
)}


# ── the index ────────────────────────────────────────────────────────────────

def parse_listing(xml: str) -> tuple[list[str], str | None]:
    """(keys, the next continuation token or None) of one S3 ListObjectsV2 page."""
    keys = re.findall(r'<Key>([^<]*)</Key>', xml)
    more = re.search(r'<IsTruncated>true</IsTruncated>', xml)
    token = re.search(r'<NextContinuationToken>([^<]*)</NextContinuationToken>', xml)
    return keys, token.group(1) if more and token else None


def list_bucket(get: Callable[[str], bytes], prefix: str = TEHSIL_WISE + '/') -> list[str]:
    keys, token, page = [], None, 0
    while True:
        url = f'{S3}?list-type=2&prefix={quote(prefix)}' + (f'&continuation-token={quote(token)}' if token else '')
        got, token = parse_listing(get(url).decode())
        keys += got
        page += 1
        if page % 20 == 0:
            log(f'  listing: {len(keys):,} keys')
        if token is None:
            return keys


def index_items(keys: list[str], kind: str) -> list[dict]:
    """The items of one kind: [{state, district, tehsil, key}] in listing order."""
    out = []
    for key in keys:
        parts = key.split('/')
        if len(parts) != 7 or parts[:2] != TEHSIL_WISE.split('/'):
            continue
        state, district, tehsil, name, leaf = parts[2:]
        if leaf == f'{name}.json' and name.endswith('_' + kind):
            out.append({'state': state, 'district': district, 'tehsil': tehsil, 'key': key})
    return out


def check_licence(state: str, collection: dict) -> None:
    if collection.get('license') != LICENCE:
        raise ValueError(f'{state}: the STAC collection now states licence {collection.get("license")!r}, '
                         f'not {LICENCE}: review it before ingesting')
    if not any(p.get('name') == CORE['name'] for p in collection.get('providers', [])):
        raise ValueError(f'{state}: the STAC collection no longer names {CORE["name"]} as provider')


# ── pull ─────────────────────────────────────────────────────────────────────

def item_name(row: dict) -> str:
    return row['key'].split('/')[-2]


def file_of(raw: Path, row: dict) -> Path:
    return raw / 'files' / f'{item_name(row)}.geojson.gz'


def record_of(raw: Path, row: dict) -> Path:
    return raw / 'files' / f'{item_name(row)}.json'


def pull_one(raw: Path, row: dict, get: Callable[[str], bytes]) -> dict:
    """One tehsil's file, fetched once: {state, district, tehsil, href, sha256, bytes, features}, or
    {..., unavailable: <the start of the answer>} when GeoServer answers with an error page."""
    rec = record_of(raw, row)
    if rec.exists():
        return json.loads(rec.read_text())
    href = json.loads(get(S3 + row['key']))['assets']['data']['href']
    if not href.startswith(GEOSERVER):
        raise ValueError(f'{item_name(row)}: its data is now at {href}, not on CoRE Stack\'s GeoServer: review it')
    body = get(href)
    got = {**{k: row[k] for k in PLACE}, 'href': href}
    if not body.lstrip().startswith(b'{'):
        got['unavailable'] = body[:200].decode('utf-8', 'replace')
    else:
        got.update(sha256=hashlib.sha256(body).hexdigest(), bytes=len(body),
                   features=len(json.loads(body)['features']))
        file_of(raw, row).parent.mkdir(parents=True, exist_ok=True)
        with pipeline.atomic_output(file_of(raw, row)) as part:
            part.write_bytes(gzip.compress(body, mtime=0))
    rec.parent.mkdir(parents=True, exist_ok=True)
    pipeline.write_json(rec, got)
    return got


def http_get(url: str) -> bytes:
    import urllib.request
    req = urllib.request.Request(url, headers={'User-Agent': pipeline.USER_AGENT})
    return pipeline.with_retries(lambda: urllib.request.urlopen(req, timeout=300).read(),
                                 give_up=pipeline.is_client_error)


def cached_get(path: Path, url: str, get: Callable[[str], bytes]) -> bytes:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with pipeline.atomic_output(path) as part:
            part.write_bytes(get(url))
    return path.read_bytes()


def pull(spec: Spec, raw: Path = RAW, get: Callable[[str], bytes] = http_get, minutes: float = 150,
         now: str | None = None) -> dict | None:
    """Every tehsil of the layer; the pull record once all are in (None when the time limit stopped it)."""
    deadline = pipeline.Deadline(minutes)
    raw.mkdir(parents=True, exist_ok=True)
    index = raw / 'index.json'
    if not index.exists():
        log('listing the tehsil-wise STAC catalogue')
        pipeline.write_json(index, {'listed_at': now or pipeline.now_iso(), 'keys': list_bucket(get)})
    rows = index_items(json.loads(index.read_text())['keys'], spec.kind)
    for state in sorted({r['state'] for r in rows}):
        url = f'{S3}{TEHSIL_WISE}/{state}/collection.json'
        check_licence(state, json.loads(cached_get(raw / 'stac' / f'{state}.json', url, get)))
    log(f'{spec.id}: {len(rows)} tehsils in {len({r["state"] for r in rows})} states, licence {LICENCE}')
    done = []

    def one(row: dict) -> dict | None:
        if not record_of(raw, row).exists() and deadline.left() < 0:
            return None
        got = pull_one(raw, row, get)
        done.append(1)
        if len(done) % 25 == 0:
            log(f'  {len(done)}/{len(rows)} tehsils')
        return got

    with ThreadPoolExecutor(WORKERS) as pool:
        recs = list(pool.map(one, rows))
    if any(r is None for r in recs):
        log(f'time limit: {sum(r is None for r in recs)} tehsils left for the next run')
        return None
    for r in recs:
        if 'unavailable' in r:
            log(f'  unavailable: {r["state"]}/{r["district"]}/{r["tehsil"]}: {r["unavailable"][:120]!r}')
    ok = [r for r in recs if 'sha256' in r]
    got = {'tehsils': len(ok), 'unavailable': len(recs) - len(ok),
           'features': sum(r['features'] for r in ok),
           'sha256': hashlib.sha256(''.join(sorted(r['sha256'] for r in ok)).encode()).hexdigest()}
    record = raw / f'{spec.id}.pull.json'
    prev = json.loads(record.read_text()) if record.exists() else {}
    if {k: v for k, v in prev.items() if k != 'pulled_at'} == got:
        return prev
    got['pulled_at'] = now or pipeline.now_iso()
    pipeline.write_json(record, got)
    return got


# ── bake ─────────────────────────────────────────────────────────────────────

def _text(v) -> str | None:
    if v is None:
        return None
    return json.dumps(v) if isinstance(v, (dict, list)) else str(v)


def build_table(con, raw: Path, rows: list[dict], out: Path) -> int:
    """Every feature of every tehsil file, stac_state/stac_district/stac_tehsil first, then the published columns in
    the order the files give them; all-number columns as numbers. Returns the row count."""
    ndjson = out.with_suffix('.ndjson')
    cols: dict[str, None] = {}
    nums = NumericTracker([])
    with ndjson.open('w') as f:
        for row in rows:
            body = json.loads(gzip.decompress(file_of(raw, row).read_bytes()))
            crs = ((body.get('crs') or {}).get('properties') or {}).get('name', 'CRS84')
            if not crs.endswith(CRS_OK):
                raise ValueError(f'{item_name(row)}: the file is in {crs}, not lon/lat WGS84')
            for feat in body['features']:
                props = feat.get('properties') or {}
                clash = [c for c in props if c.lower() in PLACE_COLS.values()]
                if clash:
                    raise ValueError(f'{item_name(row)}: a published column is named {clash}')
                for c in props:
                    if c not in cols:
                        cols[c] = None
                        nums.cols.append(c)
                nums.add(props)
                rec = {**{PLACE_COLS[k]: row[k] for k in PLACE}, **{c: _text(v) for c, v in props.items()},
                       '__geom': json.dumps(feat['geometry']) if feat.get('geometry') else None}
                f.write(json.dumps(rec) + '\n')
    types = nums.types()
    names = [*PLACE_COLS.values(), *cols]
    schema = '{' + ', '.join(f"'{c}': 'VARCHAR'" for c in [*names, '__geom']) + '}'
    sel = ', '.join(cast_sql(c, types.get(c)) for c in names)
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute(f"""COPY (SELECT {sel}, ST_GeomFromGeoJSON("__geom") AS geometry
                          FROM read_json('{ndjson}', format = 'newline_delimited', columns = {schema},
                                         maximum_object_size = 268435456))
                    TO '{out}' (FORMAT PARQUET)""")
    ndjson.unlink()
    return con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]


def shapefile_fits(con, parquet: Path, cols: list[str]) -> bool:
    """A .dbf holds at most 255 fields of at most 254 bytes of text: a layer past either is not shipped as a
    shapefile (it would lose columns or cut values)."""
    if len(cols) > DBF_FIELDS_MAX:
        return False
    text = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM '{parquet}'").fetchall()
            if r[1] == 'VARCHAR' and r[0] in cols]
    if not text:
        return True
    longest = con.execute('SELECT ' + ', '.join(f'max(strlen("{c}"))' for c in text) + f" FROM '{parquet}'").fetchone()
    return max(x or 0 for x in longest) <= DBF_TEXT_MAX


def tile_args(spec: Spec, src: Path, out: Path) -> list[str]:
    """tippecanoe with the house polygon settings (rebake_tiles: polygons coalesce at low zoom instead of
    dropping, a smaller tile budget, shared borders), the tile fields only, reading GDAL's GeoJSON (no -P)."""
    from rebake_tiles import MIN_MAX_ZOOM, tippecanoe_args
    args = tippecanoe_args(src, out, spec.id, list(spec.tile_fields), 'polygon', MIN_MAX_ZOOM)
    return [a for a in args if a != '-P']


def published_formats(parquet_bytes: int, shapefile_ok: bool) -> list[str]:
    """Parquet and tiles always; GeoJSON and KML only up to the whole-layer cap (pipeline.WHOLE_LAYER_MAX_MB,
    as for every big layer: CoRE Stack's pixel-stepped outlines make them over 1 GB); the zipped shapefile
    whenever its .dbf can hold the table."""
    small = parquet_bytes <= pipeline.WHOLE_LAYER_MAX_MB * 1024 * 1024
    return [f for f in EXT if f in ('parquet', 'pmtiles') or (small and f in ('geojson', 'kml'))
            or (f == 'shapefile' and shapefile_ok)]


def bake(spec: Spec, raw: Path = RAW) -> dict:
    import tempfile

    import bake_formats
    from bake_extracts import write_kml_from_geojson
    from bake_whole_layer import write_geojson_whole

    got = json.loads((raw / f'{spec.id}.pull.json').read_text())
    keys = json.loads((raw / 'index.json').read_text())['keys']
    rows = [r for r in index_items(keys, spec.kind) if file_of(raw, r).exists()]
    if len(rows) != got['tehsils']:
        raise ValueError(f'{spec.id}: {len(rows)} tehsil files on disk, the pull recorded {got["tehsils"]}')
    out_dir = spec.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    path = {fmt: out_dir / f'{spec.basename}.{ext}' for fmt, ext in EXT.items()}
    with tempfile.TemporaryDirectory(prefix='core_mws_') as tmp:
        table = Path(tmp) / 'mws.parquet'
        log(f'{spec.id}: reading {len(rows)} tehsil files')
        build_table(make_con(), raw, rows, table)
        n, prop_cols = pipeline.rebake_flatten_bbox(table, path['parquet'])
    con = make_con()
    states = dict(con.execute(f"SELECT stac_state, count(*) FROM '{path['parquet']}' GROUP BY 1 ORDER BY 2 DESC")
                  .fetchall())
    log(f'{n} micro-watershed rows: {states}')
    path['geojson'].unlink(missing_ok=True)
    write_geojson_whole(con, path['parquet'], path['geojson'])   # the tiles' input
    formats = published_formats(path['parquet'].stat().st_size, shapefile_fits(con, path['parquet'], prop_cols))
    if 'kml' in formats:
        write_kml_from_geojson(path['geojson'], spec.id, path['kml'])
    if 'shapefile' in formats:
        bake_formats.shapefile_zip_from_geojson(path['geojson'], path['shapefile'],
                                                bake_formats.short_field_names(prop_cols))
    path['pmtiles'].unlink(missing_ok=True)
    pipeline.run(tile_args(spec, path['geojson'], path['pmtiles']), timeout=pipeline.TOOL_TIMEOUT_S)
    log(f'  publishing {formats}')
    path = {fmt: path[fmt] for fmt in formats}
    summary = {'rows': n, 'states': states, 'pull': got,
               **pipeline.sizes_and_names(path)}
    pipeline.write_json(spec.summary_path, summary)
    log(json.dumps({k: v for k, v in summary.items() if k != 'states'}, indent=2))
    return summary


def upload(spec: Spec) -> dict[str, str]:
    """Every format to its content-versioned key; a key R2 already holds is never overwritten."""
    names = json.loads(spec.summary_path.read_text())['names']
    paths = {fmt: p for fmt, p in pipeline.layer_paths(spec.out_dir, spec.basename, EXT).items() if fmt in names}

    def put(s3, local: Path, key: str) -> None:
        pipeline.r2_upload(s3, local, key, new_only=True)
    return pipeline.upload_versioned(pipeline.r2_client(), paths, spec.r2_prefix, put)


# ── register ─────────────────────────────────────────────────────────────────

def notes(spec: Spec) -> str:
    return spec.note + COMMON_NOTE


def level_meta(spec: Spec) -> dict:
    return {'label': spec.label, 'unit': 'micro-watersheds', 'description': spec.description}


def catalog_entry(spec: Spec, summ: dict, prev: dict, r2_public: str) -> dict:
    from populate_refresh import refresh_block
    from populate_source_check import override
    names, sizes, got = summ['names'], summ['sizes'], summ['pull']
    entry = {'id': spec.id, 'level': spec.id, 'source': SOURCE, 'rows': summ['rows']}
    for fmt in EXT:
        entry[fmt] = {'url': f'{r2_public}/{spec.r2_prefix}/{names[fmt]}', 'bytes': sizes[fmt]} \
            if fmt in names else None
    entry.update({'licence': LICENCE, 'attribution': {'primary': dict(CORE), 'publisher': None},
                  'category': spec.category, 'provenance': 'curated', 'notes': notes(spec),
                  'tags': list(spec.tags), 'fetched_at': got['pulled_at'],
                  'source_check': {**override(spec.id), 'fingerprint': f'sha256={got["sha256"]}',
                                   'checked_at': got['pulled_at'], 'changed_at': None}})
    entry['refresh'] = refresh_block(entry, prev, got['pulled_at'])
    return entry


def manifest_entry(spec: Spec, summ: dict) -> dict:
    names, sizes = summ['names'], summ['sizes']
    return {'id': spec.id, 'name': spec.label, 'level': spec.id, 'category': spec.category, 'source': SOURCE,
            'description': spec.description, 'unit': 'micro-watersheds', 'features': summ['rows'],
            'license': LICENCE, 'r2_prefix': spec.r2_prefix,
            **pipeline.manifest_files(names, sizes),
            'source_url': STAC_URL, 'source_org': 'CoRE Stack',
            'source_version': f'sha256 {summ["pull"]["sha256"][:12]}, {summ["pull"]["tehsils"]} tehsils',
            'notes': notes(spec), 'tags': list(spec.tags)}


def register(spec: Spec, catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST,
             summary_path: Path | None = None, r2_public: str | None = None) -> None:
    """Patch catalog.json + the manifest in place (never rebuild). Idempotent."""
    summ = json.loads((summary_path or spec.summary_path).read_text())
    pipeline.summary_names(summ)
    pipeline.register_layer(catalog_path, manifest_path,
                            lambda prev: catalog_entry(spec, summ, prev, r2_public or pipeline.R2_PUBLIC),
                            manifest_entry(spec, summ), level_meta(spec), as_built=True, level=spec.id,
                            attribution=(SOURCE, CORE))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['pull', 'bake', 'upload', 'register'])
    ap.add_argument('--layer', choices=sorted(LAYERS), help='one layer (default: both)')
    ap.add_argument('--max-minutes', type=float, default=150)
    a = ap.parse_args()
    specs = [LAYERS[a.layer]] if a.layer else list(LAYERS.values())
    if a.step == 'pull':
        deadline = pipeline.Deadline(a.max_minutes)
        with pipeline.cache_backup(RAW, 'core_mws'):
            for spec in specs:
                got = pull(spec, minutes=max(deadline.left(), 0) / 60)
                log(json.dumps(got, indent=2) if got else f'{spec.id}: not finished, run pull again')
                if got is None:
                    sys.exit(3)
    for spec in specs:
        if a.step == 'bake':
            bake(spec)
        elif a.step == 'upload':
            log(json.dumps(upload(spec), indent=2))
        elif a.step == 'register':
            register(spec)


if __name__ == '__main__':
    main()
