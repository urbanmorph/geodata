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
    python3 scripts/bake_overture_places.py bake   --release 2026-09-23.1 --src DIR --out DIR
    python3 scripts/bake_overture_places.py upload --release 2026-09-23.1 --out DIR
    python3 scripts/bake_overture_places.py delete-stale --old-catalog FILE
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import subprocess
import sys
import tempfile
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
    'name': 'names."primary"',
    'category': 'basic_category',
    'confidence': 'confidence',
    'status': 'operating_status',
    'address': 'addresses[1].freeform',
    'locality': 'addresses[1].locality',
    'postcode': 'addresses[1].postcode',
    'region': 'addresses[1].region',
    'country': 'addresses[1].country',
    'website': 'websites[1]',
    'phone': 'phones[1]',
    'brand': 'brand.names."primary"',
    'source': 'sources[1].dataset',
}

# Overture places mix sources: Meta/Microsoft/DAC/PinMeTo are CDLA-Permissive-2.0,
# Foursquare is Apache-2.0, AllThePlaces CC0 (each record's `sources` says which).
LICENCE = 'CDLA-Permissive-2.0 / Apache-2.0'

FORMATS = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'shapefile': 'shp.zip'}


def upstream_url(release: str) -> str:
    return f'{S3_BUCKET_URL}/release/{release}/theme=places/type=place/'


def r2_keys(release: str) -> dict[str, str]:
    return {fmt: f'{R2_DIR}/{release}/{LAYER_ID}.{ext}' for fmt, ext in FORMATS.items()}


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


def clip_sql(src_files: list[str], districts_parquet: str) -> str:
    """Places inside an LGD district. A spatial join against the 785 district
    polygons is indexed (one detailed India polygon per point ran out of
    memory); points on a shared border match twice, so keep one row per id."""
    files = ', '.join(f"'{f}'" for f in src_files)
    xmin, ymin, xmax, ymax = INDIA_BBOX
    return f"""
        WITH d AS (SELECT ST_SetCRS(geometry, 'OGC:CRS84') AS geom FROM read_parquet('{districts_parquet}'))
        SELECT p.* FROM read_parquet([{files}]) p JOIN d ON ST_Intersects(d.geom, p.geometry)
        WHERE p.bbox.xmin <= {xmax} AND p.bbox.xmax >= {xmin}
          AND p.bbox.ymin <= {ymax} AND p.bbox.ymax >= {ymin}
        QUALIFY row_number() OVER (PARTITION BY p.id ORDER BY p.id) = 1"""


def tile_features_sql(parquet: str) -> str:
    """One GeoJSON Feature per row with the popup fields only."""
    return f"""
        SELECT 'Feature' AS type,
               ST_AsGeoJSON(geometry)::JSON AS geometry,
               struct_pack(id := id, name := names."primary", basic_category := basic_category,
                           confidence := confidence, operating_status := operating_status) AS properties
        FROM read_parquet('{parquet}')"""


def geojson_features_sql(parquet: str, prop_cols: list[str]) -> str:
    """One GeoJSON Feature per row with every non-geometry column."""
    props = ', '.join(f'"{c}" := "{c}"' for c in prop_cols)
    return f"""
        SELECT 'Feature' AS type,
               ST_AsGeoJSON(geometry)::JSON AS geometry,
               struct_pack({props}) AS properties
        FROM read_parquet('{parquet}')"""


def pmtiles_args(geojsonseq: Path, out: Path) -> list[str]:
    return bake_formats.pmtiles_args(geojsonseq, out, LAYER_ID, TILE_FIELDS, parallel=True)


DBF_MAX_BYTES = 2 * 1024**3  # most GIS tools refuse a .dbf over 2 GB

SHP_INTRO = ['One shapefile per state: a single India-wide .dbf would exceed 2 GB.',
             'Shapefile field names are limited to 10 characters and cannot hold nested values.',
             'Each field below is taken from the Parquet / GeoJSON column shown',
             '(first element where the source holds a list).', '']


def shapefile_key() -> list[str]:
    return bake_formats.shapefile_key({expr: short for short, expr in SHP_FIELDS.items()}, SHP_INTRO)


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
            'polygon). Every Overture column is kept as published; names, addresses, '
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
    import duckdb
    tmp.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    # ~4.4M rows with nested columns: let order-free COPYs stream and spill.
    con.execute(f"SET preserve_insertion_order = false; SET temp_directory = '{tmp}';")
    return con


def _layer_url(layer_id: str, fmt: str) -> str:
    return next(l for l in json.loads(CATALOG.read_text())['layers'] if l['id'] == layer_id)[fmt]['url']


def bake(release: str, src: Path, out: Path) -> dict:
    """Each stage skips an output that already exists: delete one file and
    re-run to rebuild just that format."""
    from ingest_ramseraph import rebake_flatten_bbox

    out.mkdir(parents=True, exist_ok=True)
    con = _con(out / 'tmp')
    path = {fmt: out / f'{LAYER_ID}.{ext}' for fmt, ext in FORMATS.items()}
    districts = out / 'lgd_districts.parquet'
    if not districts.exists():
        subprocess.run(['curl', '-sfL', '-A', 'Mozilla/5.0', '-o', str(districts),
                        _layer_url('lgd_districts', 'parquet')], check=True)

    if not path['parquet'].exists():
        files = sorted(str(p) for p in src.glob('*.parquet'))
        clipped = out / 'clipped.parquet'
        con.execute(f"COPY ({clip_sql(files, str(districts))}) TO '{clipped}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        rebake_flatten_bbox(clipped, path['parquet'])
        clipped.unlink()
    parquet = path['parquet']
    rows = con.execute(f"SELECT count(*) FROM read_parquet('{parquet}')").fetchone()[0]

    if not path['pmtiles'].exists():
        # Line-delimited GeoJSON streams; tippecanoe -P reads it in parallel.
        seq = out / 'tiles.geojsons'
        con.execute(f"COPY ({tile_features_sql(str(parquet))}) TO '{seq}' (FORMAT JSON)")
        bake_formats.write_pmtiles(seq, path['pmtiles'], LAYER_ID, TILE_FIELDS, parallel=True)
        seq.unlink()

    if not path['geojson'].exists():
        # Streamed: DuckDB writes a JSON array of features; wrap it as a FeatureCollection.
        prop_cols = [c[0] for c in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{parquet}')").fetchall()
                     if c[0] != 'geometry']
        feats = out / 'features.json'
        con.execute(f"COPY ({geojson_features_sql(str(parquet), prop_cols)}) TO '{feats}' (FORMAT JSON, ARRAY true)")
        with path['geojson'].open('wb') as dst, feats.open('rb') as fsrc:
            dst.write(b'{"type":"FeatureCollection","features":')
            while chunk := fsrc.read(64 << 20):
                dst.write(chunk)
            dst.write(b'}\n')
        feats.unlink()

    if not path['shapefile'].exists():
        write_shapefile_zip(parquet, districts, path['shapefile'], out / 'tmp')

    summary = {'release': release, 'rows': rows, 'sizes': {fmt: p.stat().st_size for fmt, p in path.items()}}
    (out / 'summary.json').write_text(json.dumps(summary, indent=2))
    return summary


def state_slug(name: str) -> str:
    return re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')


def check_dbf_sizes(sizes: dict[str, int]) -> None:
    over = {k: v for k, v in sizes.items() if v > DBF_MAX_BYTES}
    if over:
        raise ValueError(f'.dbf over 2 GB (split further): {over}')


def shapefile_rows_sql(parquet: str, districts_parquet: str) -> str:
    """Flat shapefile fields plus the LGD state each place falls in."""
    select = ', '.join(f'p.{expr} AS "{short}"' for short, expr in SHP_FIELDS.items())
    return f"""
        WITH d AS (SELECT stname, ST_SetCRS(geometry, 'OGC:CRS84') AS geom FROM read_parquet('{districts_parquet}'))
        SELECT d.stname, {select}, p.geometry
        FROM read_parquet('{parquet}') p JOIN d ON ST_Intersects(d.geom, p.geometry)
        QUALIFY row_number() OVER (PARTITION BY p.id ORDER BY p.id) = 1"""


def write_shapefile_zip(parquet: Path, districts: Path, out: Path, tmp: Path) -> dict[str, int]:
    con = _con(tmp)
    con.execute(f"CREATE TABLE shp AS {shapefile_rows_sql(str(parquet), str(districts))}")
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
    ap.add_argument('step', choices=['bake', 'upload', 'delete-stale'])
    ap.add_argument('--release')
    ap.add_argument('--src', type=Path)
    ap.add_argument('--out', type=Path)
    ap.add_argument('--old-catalog', type=Path)
    a = ap.parse_args()
    if a.step == 'bake':
        print(json.dumps(bake(a.release, a.src, a.out), indent=2))
    elif a.step == 'upload':
        upload(a.release, a.out)
    else:
        delete_stale(a.old_catalog)


if __name__ == '__main__':
    main()
