"""Refresh overture_places_india from an Overture Maps release (places theme).

Replaces the Dec 2023 ramSeraph mirror with a bake straight from Overture's
public S3 release, clipped to India (points inside an LGD district polygon). The data is presented as
Overture publishes it (every column, nested types kept in Parquet/GeoJSON);
the only transforms are generic: clip, flat bbox + Hilbert sort for
/api/v1/nearby, popup-only fields in the tiles, and a flattened field subset
for the shapefile (DBF cannot hold nested values; columns.txt maps names).

R2 keys are versioned by release because R2 objects are served
`immutable, max-age=604800`: overwriting a key would let caches mix old and
new bytes in range reads. The old keys are deleted only after verification
(`--delete-stale`).

Usage:
    python3 scripts/bake_overture_places.py fetch  --release 2026-09-23.1 --src DIR
    python3 scripts/bake_overture_places.py bake   --release 2026-09-23.1 --src DIR --out DIR
    python3 scripts/bake_overture_places.py upload --release 2026-09-23.1 --out DIR
    python3 scripts/bake_overture_places.py delete-stale --old-catalog FILE
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_formats  # noqa: E402
CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'

LAYER_ID = 'overture_places_india'
R2_DIR = 'pois/overture-places'
INDIA_BBOX = (68.0, 6.0, 98.0, 38.0)  # xmin, ymin, xmax, ymax
S3_BUCKET_URL = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com'

# Popup fields only: every extra tile attribute makes tippecanoe drop more
# points at low zoom (see corestack_lulc_blocks, PR #187).
TILE_FIELDS = ('id', 'name', 'basic_category', 'confidence', 'operating_status')

# Shapefile: short DBF name -> SQL expression over the published parquet.
SHP_FIELDS = {
    'id': 'id',
    'name': 'name',
    'category': 'basic_category',
    'confidence': 'confidence',
    'status': 'operating_status',
    'address': 'addresses[1].freeform',
    'locality': 'addresses[1].locality',
    'postcode': 'addresses[1].postcode',
    'region': 'addresses[1].region',
    'country': 'addresses[1].country',
    'website': 'websites[1]',
    'brand': 'brand.names."primary"',
    'source': 'sources[1].dataset',
}

# Contact details of (often sole-trader) businesses: personal data, stripped
# from every format (owner decision 2026-10-07).
PERSONAL_COLUMNS = ('emails', 'phones', 'socials')

# Overture places mix sources: Meta/Microsoft/DAC/PinMeTo are CDLA-Permissive-2.0,
# Foursquare is Apache-2.0, AllThePlaces CC0 (each record's `sources` says which).
LICENCE = 'CDLA-Permissive-2.0 / Apache-2.0'

# Bump when re-baking a release that was already uploaded: R2 keys are
# immutable-cached, so a new bake of the same release gets new keys.
BAKE_REVISION = 3

FORMATS = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'shapefile': 'shp.zip'}


def upstream_url(release: str) -> str:
    return f'{S3_BUCKET_URL}/release/{release}/theme=places/type=place/'


def r2_keys(release: str) -> dict[str, str]:
    return {fmt: f'{R2_DIR}/{release}-r{BAKE_REVISION}/{LAYER_ID}.{ext}' for fmt, ext in FORMATS.items()}


def overlapping_files(row_groups: list[dict], bbox=INDIA_BBOX) -> list[str]:
    """Files with at least one row group whose bbox stats overlap `bbox`.
    Overture files are spatially sorted, so only a couple of the ~30 files
    per release touch India; reading the rest is the slow path."""
    xmin, ymin, xmax, ymax = bbox
    hits = {
        g['file'] for g in row_groups
        if None not in (g['xmin'], g['ymin'], g['xmax'], g['ymax'])
        and g['xmin'] <= xmax and g['xmax'] >= xmin and g['ymin'] <= ymax and g['ymax'] >= ymin
    }
    return sorted(hits)


def _prefilter(alias: str = 'p') -> str:
    xmin, ymin, xmax, ymax = INDIA_BBOX
    return (f"{alias}.bbox.xmin <= {xmax} AND {alias}.bbox.xmax >= {xmin} "
            f"AND {alias}.bbox.ymin <= {ymax} AND {alias}.bbox.ymax >= {ymin}")


def check_no_personal_columns(cols: list[str]) -> None:
    found = [c for c in cols if c in PERSONAL_COLUMNS]
    if found:
        raise ValueError(f'personal data must not be published: {found}')


def place_states_sql(src_files: list[str], districts_parquet: str) -> str:
    """id -> LGD state for every place inside an LGD district. The one spatial
    join of the bake (the clip and the per-state shapefiles both reuse it):
    785 indexed district polygons, only id + geometry through the join; a
    point on a shared district border matches twice, so group by id."""
    files = ', '.join(f"'{f}'" for f in src_files)
    return f"""
        WITH d AS (SELECT stname, ST_SetCRS(geometry, 'OGC:CRS84') AS geom FROM read_parquet('{districts_parquet}')),
             p AS (SELECT id, geometry, bbox FROM read_parquet([{files}]) p WHERE {_prefilter()})
        SELECT p.id, any_value(d.stname) AS stname
        FROM p JOIN d ON ST_Intersects(d.geom, p.geometry)
        GROUP BY p.id"""


def clip_sql(src_files: list[str], place_states: str) -> str:
    """Every Overture column, for the places inside India, plus a flat `name`
    (copy of names.primary) so the filter panel and API can search names
    without decoding the nested struct."""
    files = ', '.join(f"'{f}'" for f in src_files)
    return f"""
        SELECT p.id, p.names."primary" AS name, p.* EXCLUDE (id, {', '.join(PERSONAL_COLUMNS)})
        FROM read_parquet([{files}]) p
        SEMI JOIN read_parquet('{place_states}') s ON p.id = s.id
        WHERE {_prefilter()}"""


TILE_PROPS_SQL = ('struct_pack(id := id, name := name, basic_category := basic_category, '
                  'confidence := confidence, operating_status := operating_status)')


DBF_MAX_BYTES = 2 * 1024**3  # most GIS tools refuse a .dbf over 2 GB

SHP_INTRO = ['One shapefile per state: a single India-wide .dbf would exceed 2 GB.',
             'Shapefile field names are limited to 10 characters and cannot hold nested values.',
             'Each field below is taken from the Parquet / GeoJSON column shown',
             '(first element where the source holds a list).', '']


def shapefile_key() -> list[str]:
    return bake_formats.shapefile_key({expr: short for short, expr in SHP_FIELDS.items()}, SHP_INTRO)


def row_group_bboxes_sql(release: str) -> str:
    """Per file + row group bbox from Parquet footers only (no data read)."""
    return f"""
        SELECT file_name AS file, row_group_id,
          min(CASE WHEN path_in_schema = 'bbox, xmin' THEN TRY_CAST(stats_min AS DOUBLE) END) AS xmin,
          max(CASE WHEN path_in_schema = 'bbox, xmax' THEN TRY_CAST(stats_max AS DOUBLE) END) AS xmax,
          min(CASE WHEN path_in_schema = 'bbox, ymin' THEN TRY_CAST(stats_min AS DOUBLE) END) AS ymin,
          max(CASE WHEN path_in_schema = 'bbox, ymax' THEN TRY_CAST(stats_max AS DOUBLE) END) AS ymax
        FROM parquet_metadata('s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*')
        GROUP BY 1, 2"""


def patched_layer(layer: dict, release: str, sizes: dict[str, int], rows: int,
                  fetched_at: str, r2_public: str) -> dict:
    """The catalog entry for the new release; identity fields untouched."""
    new = copy.deepcopy(layer)
    keys = r2_keys(release)
    for fmt, size in sizes.items():
        new[fmt] = {'url': f'{r2_public}/{keys[fmt]}', 'upstream_url': upstream_url(release), 'bytes': size}
    new['kml'] = None
    new['licence'] = LICENCE
    new['rows'] = rows
    new['fetched_at'] = fetched_at
    new['notes'] = notes_for(release)
    return new


def notes_for(release: str) -> str:
    return (f'Overture Maps Foundation places, release {release}, clipped to India (inside an LGD district '
            'polygon). Every Overture column is kept as published, and `name` is a copy of names.primary '
            'added for search and simple queries. Contact emails, phone numbers and social media '
            'links are removed (personal data of sole traders). Names, addresses, '
            'sources and taxonomy stay nested in the Parquet and GeoJSON. The shapefile carries a '
            'flat subset (see columns.txt in the zip). For KML, use Filter & export on a category '
            'or area. Licences follow the source of each record (listed in `sources`): Meta, '
            'Microsoft and other contributors CDLA-Permissive-2.0, Foursquare Apache-2.0, '
            'AllThePlaces CC0-1.0.')


def display_name(release: str) -> str:
    month = datetime.strptime(release[:10], '%Y-%m-%d').strftime('%b %Y')
    return f'Places (Overture Maps, {month})'


def description_for(release: str) -> str:
    return (f'Pan-India points of interest from the Overture Maps Foundation release {release}. '
            'Names, categories, addresses, websites, phone numbers, brands and confidence scores '
            'for shops, restaurants, ATMs, schools, hospitals, transit, monuments and more.')


def patched_manifest_entry(entry: dict, release: str, sizes: dict[str, int], rows: int) -> dict:
    """external-ingested.json entry; build_catalog rebuilds URLs from r2_prefix + file names."""
    keys = r2_keys(release)
    new = copy.deepcopy(entry)
    new.update({
        'name': display_name(release),
        'description': description_for(release),
        'features': rows,
        'r2_prefix': keys['parquet'].rsplit('/', 1)[0],
        'parquet_file': keys['parquet'].rsplit('/', 1)[1],
        'parquet_bytes': sizes['parquet'],
        'pmtiles_file': keys['pmtiles'].rsplit('/', 1)[1],
        'pmtiles_bytes': sizes['pmtiles'],
        'source_url': 'https://docs.overturemaps.org/release-calendar/',
        'license': LICENCE,
        'notes': notes_for(release),
    })
    return new


def patched_level_meta(meta: dict, release: str) -> dict:
    return {**meta, 'label': display_name(release), 'description': description_for(release)}


def stale_keys(old: dict, new: dict, r2_public: str) -> list[str]:
    """R2 keys the old entry referenced that the new entry no longer does."""
    def keys(layer):
        return {(layer.get(f) or {}).get('url', '') for f in ('parquet', 'pmtiles', 'geojson', 'kml', 'shapefile')}
    gone = keys(old) - keys(new)
    return sorted(u.removeprefix(f'{r2_public}/') for u in gone if u.startswith(f'{r2_public}/'))


# ── side-effecting steps ─────────────────────────────────────────────────

def _con(tmp: Path):
    from bake_extracts import make_con
    tmp.mkdir(parents=True, exist_ok=True)
    con = make_con()
    # ~4.4M rows with nested columns: let order-free COPYs stream and spill.
    con.execute(f"SET preserve_insertion_order = false; SET temp_directory = '{tmp}';")
    return con


def fetch(release: str, src: Path, parts: int = 8) -> list[Path]:
    """Download only the release files whose row groups overlap India.
    Overture files are spatially sorted, so a release's ~30 files reduce to a
    few; S3 throttles one connection to us-west-2 (~0.7 MB/s from India), so
    each file comes down as `parts` parallel byte ranges."""
    from bake_extracts import make_con
    con = make_con()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region = 'us-west-2';")
    cols = ('file', 'row_group_id', 'xmin', 'xmax', 'ymin', 'ymax')
    groups = [dict(zip(cols, r)) for r in con.execute(row_group_bboxes_sql(release)).fetchall()]
    done = []
    for s3_path in overlapping_files(groups):
        url = f"{S3_BUCKET_URL}/{s3_path.removeprefix('s3://overturemaps-us-west-2/')}"
        dest = src / s3_path.rsplit('/', 1)[1]
        if not dest.exists():
            download_ranged(url, dest, parts)
        done.append(dest)
    return done


def download_ranged(url: str, dest: Path, parts: int = 8) -> Path:
    """GET `url` as `parts` parallel byte ranges into `dest` (atomic, size-checked)."""
    head = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'Mozilla/5.0'})
    size = int(urllib.request.urlopen(head, timeout=60).headers['Content-Length'])

    def get(rng: tuple[int, int]) -> bytes:
        req = urllib.request.Request(url, headers={'Range': f'bytes={rng[0]}-{rng[1]}', 'User-Agent': 'Mozilla/5.0'})
        return urllib.request.urlopen(req, timeout=600).read()

    with bake_formats.atomic_output(dest) as part:
        with ThreadPoolExecutor(parts) as pool, part.open('wb') as out:
            for chunk in pool.map(get, bake_formats.byte_ranges(size, parts)):
                out.write(chunk)
        if part.stat().st_size != size:
            raise IOError(f'{dest.name}: got {part.stat().st_size} of {size} bytes')
    return dest


def bake(release: str, src: Path, out: Path) -> dict:
    """Each stage writes atomically and skips an output that already exists:
    delete one file and re-run to rebuild just that format."""
    from ingest_ramseraph import rebake_flatten_bbox

    out.mkdir(parents=True, exist_ok=True)
    con = _con(out / 'tmp')
    path = {fmt: out / f'{LAYER_ID}.{ext}' for fmt, ext in FORMATS.items()}
    files = sorted(str(p) for p in src.glob('*.parquet'))
    districts = bake_formats.fetch_layer_file(CATALOG, 'lgd_districts', 'parquet', out / 'lgd_districts.parquet')

    place_states = out / 'place_states.parquet'
    if not place_states.exists():
        with bake_formats.atomic_output(place_states) as part:
            con.execute(f"COPY ({place_states_sql(files, str(districts))}) TO '{part}' (FORMAT PARQUET)")

    if not path['parquet'].exists():
        clipped = out / 'clipped.parquet'
        try:
            con.execute(f"COPY ({clip_sql(files, str(place_states))}) TO '{clipped}' (FORMAT PARQUET, COMPRESSION ZSTD)")
            with bake_formats.atomic_output(path['parquet']) as part:
                rebake_flatten_bbox(clipped, part, con=con)
        finally:
            clipped.unlink(missing_ok=True)
    parquet = path['parquet']
    check_no_personal_columns([c[0] for c in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{parquet}')").fetchall()])
    rows = con.execute(f"SELECT count(*) FROM read_parquet('{parquet}')").fetchone()[0]

    if not path['pmtiles'].exists():
        # Line-delimited GeoJSON streams; tippecanoe -P reads it in parallel.
        seq = out / 'tiles.geojsons'
        try:
            con.execute(f"COPY ({bake_formats.features_sql(str(parquet), TILE_PROPS_SQL)}) TO '{seq}' (FORMAT JSON)")
            with bake_formats.atomic_output(path['pmtiles']) as part:
                bake_formats.write_pmtiles(seq, part, LAYER_ID, TILE_FIELDS, parallel=True)
        finally:
            seq.unlink(missing_ok=True)

    if not path['geojson'].exists():
        # Streamed: DuckDB writes a JSON array of features; wrap it as a
        # FeatureCollection (one extra sequential copy of ~6 GB, ~1 min).
        cols = [c[0] for c in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{parquet}')").fetchall()
                if c[0] != 'geometry']
        props = 'struct_pack(' + ', '.join(f'"{c}" := "{c}"' for c in cols) + ')'
        feats = out / 'features.json'
        try:
            con.execute(f"COPY ({bake_formats.features_sql(str(parquet), props)}) TO '{feats}' (FORMAT JSON, ARRAY true)")
            with bake_formats.atomic_output(path['geojson']) as part, part.open('wb') as dst, feats.open('rb') as fsrc:
                dst.write(b'{"type":"FeatureCollection","features":')
                while chunk := fsrc.read(64 << 20):
                    dst.write(chunk)
                dst.write(b'}\n')
        finally:
            feats.unlink(missing_ok=True)

    if not path['shapefile'].exists():
        with bake_formats.atomic_output(path['shapefile']) as part:
            write_shapefile_zip(con, parquet, place_states, part, out / 'tmp')

    summary = {'release': release, 'rows': rows, 'sizes': {fmt: p.stat().st_size for fmt, p in path.items()}}
    (out / 'summary.json').write_text(json.dumps(summary, indent=2))
    return summary


def state_slug(name: str) -> str:
    return re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')


def check_dbf_sizes(sizes: dict[str, int]) -> None:
    over = {k: v for k, v in sizes.items() if v > DBF_MAX_BYTES}
    if over:
        raise ValueError(f'.dbf over 2 GB (split further): {over}')


def shapefile_rows_sql(parquet: str, place_states: str) -> str:
    """Flat shapefile fields plus the LGD state each place falls in."""
    select = ', '.join(f'p.{expr} AS "{short}"' for short, expr in SHP_FIELDS.items())
    return f"""
        SELECT s.stname, {select}, p.geometry
        FROM read_parquet('{parquet}') p JOIN read_parquet('{place_states}') s ON p.id = s.id"""


def write_shapefile_zip(con, parquet: Path, place_states: Path, out: Path, tmp: Path) -> dict[str, int]:
    """One shapefile per state, zipped with columns.txt; each .dbf < 2 GB."""
    con.execute(f"CREATE OR REPLACE TEMP TABLE shp AS {shapefile_rows_sql(str(parquet), str(place_states))}")
    states = [r[0] for r in con.execute("SELECT DISTINCT stname FROM shp ORDER BY 1").fetchall()]
    fields = ', '.join(f'"{short}"' for short in SHP_FIELDS)
    dbf_sizes: dict[str, int] = {}
    with tempfile.TemporaryDirectory(prefix='shp_', dir=tmp) as work:
        work_dir = Path(work)
        for st in states:
            stem = f'{LAYER_ID}_{state_slug(st)}'
            con.execute(
                f"COPY (SELECT {fields}, geometry FROM shp WHERE stname = ?) TO '{work_dir / (stem + '.shp')}' "
                f"WITH (FORMAT GDAL, DRIVER 'ESRI Shapefile', LAYER_CREATION_OPTIONS ('ENCODING=UTF-8', 'RESIZE=YES'))",
                [st])
            dbf_sizes[state_slug(st)] = (work_dir / f'{stem}.dbf').stat().st_size
        check_dbf_sizes(dbf_sizes)
        bake_formats.zip_with_key(work_dir, out, shapefile_key())
    con.execute("DROP TABLE shp")
    return dbf_sizes


def upload(release: str, out: Path) -> None:
    from ingest_ramseraph import R2_PUBLIC, r2_client, r2_upload

    summary = json.loads((out / 'summary.json').read_text())
    s3 = r2_client()
    for fmt, key in r2_keys(release).items():
        r2_upload(s3, out / f'{LAYER_ID}.{FORMATS[fmt]}', key)

    fetched_at = datetime.now(timezone.utc).isoformat()
    catalog = json.loads(CATALOG.read_text())
    catalog['layers'] = [
        patched_layer(l, release, summary['sizes'], summary['rows'], fetched_at, R2_PUBLIC)
        if l['id'] == LAYER_ID else l for l in catalog['layers']]
    catalog['level_meta'][LAYER_ID] = patched_level_meta(catalog['level_meta'][LAYER_ID], release)
    CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=True) + '\n')

    manifest = json.loads(MANIFEST.read_text())
    manifest = [patched_manifest_entry(e, release, summary['sizes'], summary['rows'])
                if e['id'] == LAYER_ID else e for e in manifest]
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=True) + '\n')


def delete_stale(old_catalog: Path) -> None:
    from ingest_ramseraph import BUCKET, R2_PUBLIC, r2_client

    def entry(path):
        return next(l for l in json.loads(path.read_text())['layers'] if l['id'] == LAYER_ID)

    s3 = r2_client()
    for key in stale_keys(entry(old_catalog), entry(CATALOG), R2_PUBLIC):
        print(f'  deleting s3://{BUCKET}/{key}')
        s3.delete_object(Bucket=BUCKET, Key=key)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['fetch', 'bake', 'upload', 'delete-stale'])
    ap.add_argument('--release')
    ap.add_argument('--src', type=Path)
    ap.add_argument('--out', type=Path)
    ap.add_argument('--old-catalog', type=Path)
    a = ap.parse_args()
    if a.step == 'fetch':
        a.src.mkdir(parents=True, exist_ok=True)
        print('\n'.join(str(p) for p in fetch(a.release, a.src)))
    elif a.step == 'bake':
        print(json.dumps(bake(a.release, a.src, a.out), indent=2))
    elif a.step == 'upload':
        upload(a.release, a.out)
    else:
        delete_stale(a.old_catalog)


if __name__ == '__main__':
    main()
