"""Refresh overture_places_india from an Overture Maps release (places theme).

Replaces the Dec 2023 ramSeraph mirror with a bake straight from Overture's
public S3 release, clipped to India's boundary. The data is presented as
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
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'

LAYER_ID = 'overture_places_india'
R2_DIR = 'pois/overture-places'
INDIA_BBOX = (68.0, 6.0, 98.0, 38.0)  # xmin, ymin, xmax, ymax
INDIA_BOUNDARY_URL = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/reference/india_boundary.geojson'
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


def clip_sql(src_files: list[str], boundary_geojson: str) -> str:
    files = ', '.join(f"'{f}'" for f in src_files)
    xmin, ymin, xmax, ymax = INDIA_BBOX
    return f"""
        WITH india AS (SELECT geom FROM ST_Read('{boundary_geojson}'))
        SELECT p.* FROM read_parquet([{files}]) p, india
        WHERE p.bbox.xmin <= {xmax} AND p.bbox.xmax >= {xmin}
          AND p.bbox.ymin <= {ymax} AND p.bbox.ymax >= {ymin}
          AND ST_Within(p.geometry, india.geom)"""


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
    args = ['tippecanoe', '-o', str(out), '-l', LAYER_ID, '-zg', '-P',
            '--drop-densest-as-needed', '--extend-zooms-if-still-dropping']
    for field in TILE_FIELDS:
        args += ['-y', field]
    return args + ['--force', '--no-progress-indicator', str(geojsonseq)]


def shapefile_key() -> list[str]:
    key = ['Shapefile field names are limited to 10 characters and cannot hold nested values.',
           'Each field below is taken from the Parquet / GeoJSON column shown',
           '(first element where the source holds a list).', '']
    return key + [f'{short:<11} {expr}' for short, expr in SHP_FIELDS.items()]


def patched_layer(layer: dict, release: str, sizes: dict[str, int], rows: int,
                  fetched_at: str, r2_public: str) -> dict:
    """The catalog entry for the new release; identity fields untouched."""
    new = copy.deepcopy(layer)
    keys = r2_keys(release)
    for fmt, size in sizes.items():
        new[fmt] = {'url': f'{r2_public}/{keys[fmt]}', 'upstream_url': upstream_url(release), 'bytes': size}
    new['kml'] = None
    new['rows'] = rows
    new['fetched_at'] = fetched_at
    new['notes'] = notes_for(release)
    return new


def notes_for(release: str) -> str:
    return (f'Overture Maps Foundation places, release {release}, clipped to India\'s boundary '
            '(LGD states dissolved). Every Overture column is kept as published; names, addresses, '
            'sources and taxonomy stay nested in the Parquet and GeoJSON. The shapefile carries a '
            'flat subset (see columns.txt in the zip). For KML, use Filter & export on a category '
            'or area. Each record lists its upstream sources and their licences in `sources`.')


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

def _con():
    import duckdb
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    return con


def bake(release: str, src: Path, out: Path) -> dict:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from ingest_ramseraph import rebake_flatten_bbox

    out.mkdir(parents=True, exist_ok=True)
    con = _con()
    files = sorted(str(p) for p in src.glob('*.parquet'))
    boundary = out / 'india_boundary.geojson'
    if not boundary.exists():
        subprocess.run(['curl', '-sfL', '-A', 'Mozilla/5.0', '-o', str(boundary), INDIA_BOUNDARY_URL], check=True)

    clipped = out / 'clipped.parquet'
    con.execute(f"COPY ({clip_sql(files, str(boundary))}) TO '{clipped}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    parquet = out / f'{LAYER_ID}.parquet'
    rows, prop_cols = rebake_flatten_bbox(clipped, parquet)
    clipped.unlink()

    # Tiles from line-delimited GeoJSON (streams; tippecanoe -P reads it in parallel).
    seq = out / 'tiles.geojsons'
    con.execute(f"COPY ({tile_features_sql(str(parquet))}) TO '{seq}' (FORMAT JSON)")
    pmtiles = out / f'{LAYER_ID}.pmtiles'
    subprocess.run(pmtiles_args(seq, pmtiles), check=True, capture_output=True)
    seq.unlink()

    # Whole-layer GeoJSON, streamed: a JSON array of features wrapped as a FeatureCollection.
    feats = out / 'features.json'
    con.execute(f"COPY ({geojson_features_sql(str(parquet), prop_cols)}) TO '{feats}' (FORMAT JSON, ARRAY true)")
    geojson = out / f'{LAYER_ID}.geojson'
    with geojson.open('wb') as dst, feats.open('rb') as fsrc:
        dst.write(b'{"type":"FeatureCollection","features":')
        while chunk := fsrc.read(64 << 20):
            dst.write(chunk)
        dst.write(b'}\n')
    feats.unlink()

    shp_zip = out / f'{LAYER_ID}.shp.zip'
    _write_shapefile_zip(con, parquet, shp_zip)

    summary = {'release': release, 'rows': rows,
               'sizes': {fmt: (out / f'{LAYER_ID}.{ext}').stat().st_size for fmt, ext in FORMATS.items()}}
    (out / 'summary.json').write_text(json.dumps(summary, indent=2))
    return summary


def _write_shapefile_zip(con, parquet: Path, out: Path) -> None:
    select = ', '.join(f'{expr} AS "{short}"' for short, expr in SHP_FIELDS.items())
    with tempfile.TemporaryDirectory(prefix='shp_') as tmp:
        tmp_dir = Path(tmp)
        con.execute(
            f"COPY (SELECT {select}, geometry FROM read_parquet('{parquet}')) "
            f"TO '{tmp_dir / (LAYER_ID + '.shp')}' "
            f"WITH (FORMAT GDAL, DRIVER 'ESRI Shapefile', LAYER_CREATION_OPTIONS ('ENCODING=UTF-8', 'RESIZE=YES'))")
        (tmp_dir / 'columns.txt').write_text('\n'.join(shapefile_key()) + '\n')
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(tmp_dir.iterdir()):
                zf.write(f, arcname=f.name)


def upload(release: str, out: Path) -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
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
    sys.path.insert(0, str(Path(__file__).resolve().parent))
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
