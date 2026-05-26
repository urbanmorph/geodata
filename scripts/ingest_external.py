#!/usr/bin/env python3
"""
Ingest external geo datasets into the bharatlas catalog.

Pipeline per dataset:
  1. KML → GeoJSON via ogr2ogr (skipped if input is already GeoJSON)
  2. GeoJSON → Parquet via DuckDB-spatial (zstd-compressed)
  3. GeoJSON → PMTiles via tippecanoe (vector tiles for the viewer)
  4. Upload Parquet + PMTiles to R2 via boto3 multipart
  5. Emit Python catalog entries (LEVELS + LAYERS rows) to stdout — paste
     into scripts/build_catalog.py

Run:
    pip install boto3 duckdb
    brew install gdal tippecanoe
    export R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... CLOUDFLARE_ACCOUNT_ID=...
    python3 scripts/ingest_external.py            # all datasets
    python3 scripts/ingest_external.py chennai    # one by id substring
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import duckdb
import boto3
from botocore.config import Config

HOME = Path.home()
ROOT = Path(__file__).resolve().parent.parent
WORK = Path('/tmp/ingest')

# R2 bucket the catalog reads from.
BUCKET = 'geodata-data'


@dataclass
class Dataset:
    id: str                 # catalog id (snake_case, unique)
    name: str               # display label on the home card
    src: str                # absolute path to the source file (KML or GeoJSON)
    category: str           # one of catalog.categories keys
    level: str              # LEVELS dict id (one per layer for city data)
    description: str        # one-liner for the card + JSON-LD
    source_org: str         # primary attribution org (e.g. "BBMP")
    source_url: str         # canonical link to the upstream dataset
    license: str            # SPDX-style; must be in OPEN_LICENCES
    r2_prefix: str          # R2 key prefix (e.g. "admin/wards-bengaluru-gba")
    unit: str = 'features'  # plural noun shown next to the count ("wards", "corporations")
    features: int | None = None  # feature count; filled in post-conversion if None
    notes: str = ''         # extra note shown on the card


# All datasets ingested in v4.1 (notf + BDA).
# source_url points at OpenCity (the canonical citation) where applicable;
# notf is just our local working copy.
DATASETS: list[Dataset] = [
    # ──────── Bengaluru ────────
    Dataset(
        id='wards_bengaluru_gba',
        name='Greater Bengaluru Wards (2025)',
        src=str(HOME / 'GitHub/notf/supporting documents/bengaluru/gba-369-wards-december-2025.kml'),
        category='administrative',
        level='wards_bengaluru_gba',
        description='Greater Bengaluru Authority — 369 final wards across 5 corporations, notified Nov 2025.',
        source_org='Greater Bengaluru Authority',
        source_url='https://data.opencity.in/dataset/gba-wards-delimitation-2025',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-bengaluru-gba',
        features=369,
        notes='Latest GBA delimitation. Pair with the 5-corp polygons for parent grouping.',
    ),
    Dataset(
        id='corporation_bengaluru',
        name='Greater Bengaluru Corporations (2025)',
        src=str(HOME / 'GitHub/notf/supporting documents/bengaluru/gba_corporation.geojson'),
        category='administrative',
        level='corporation_bengaluru',
        description='Five corporation-level polygons that make up the Greater Bengaluru Authority.',
        source_org='Greater Bengaluru Authority',
        source_url='https://data.opencity.in/dataset/greater-bengaluru-authority-corporations-delimitation-2025',
        license='ODbL-1.0',
        unit='corporations',
        r2_prefix='admin/corporation-bengaluru',
        features=5,
        notes='Parent polygons for the 369 GBA wards.',
    ),
    Dataset(
        id='wards_bengaluru_bbmp_2022',
        name='BBMP Wards (2022, historical)',
        src=str(HOME / 'GitHub/BDA/supporting-documents/bbmp-wards-2022.geojson'),
        category='administrative',
        level='wards_bengaluru_bbmp_2022',
        description='Bruhat Bengaluru Mahanagara Palike — 243 wards from the 2022 draft delimitation. Historical reference; superseded by the 2025 GBA 369-ward scheme.',
        source_org='BBMP',
        source_url='https://data.opencity.in/dataset/bbmp-wards',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-bengaluru-bbmp-2022',
        features=243,
        notes='Use the GBA 2025 layer for current ward boundaries.',
    ),
    Dataset(
        id='bda_jurisdiction',
        name='BDA Jurisdiction',
        src=str(HOME / 'GitHub/BDA/public/data/bda_jurisdiction.geojson'),
        category='administrative',
        level='bda_jurisdiction',
        description='Bengaluru Development Authority planning + acquisition jurisdiction boundary.',
        source_org='Bengaluru Development Authority',
        source_url='https://data.opencity.in/dataset/bda-jurisdiction-and-boundary',
        license='ODbL-1.0',
        unit='jurisdiction',
        r2_prefix='admin/bda-jurisdiction',
        notes='Single polygon. Useful as a boundary mask for any BDA-scoped analysis.',
    ),
    Dataset(
        id='bda_layouts',
        name='BDA Approved Layouts',
        src=str(HOME / 'GitHub/BDA/supporting-documents/bda layout boundaries.kml'),
        category='administrative',
        level='bda_layouts',
        description='BDA-approved residential and commercial layout boundaries within the BDA jurisdiction.',
        source_org='Bengaluru Development Authority',
        source_url='https://data.opencity.in/dataset/bda-approved-layouts',
        license='ODbL-1.0',
        unit='layouts',
        r2_prefix='admin/bda-layouts',
        features=149,
    ),

    # ──────── Chennai ────────
    Dataset(
        id='wards_chennai',
        name='Chennai (GCC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/chennai/chennai-wards.kml'),
        category='administrative',
        level='wards_chennai',
        description='Greater Chennai Corporation — 200 ward boundaries across the 15 zones.',
        source_org='Greater Chennai Corporation',
        source_url='https://data.opencity.in/dataset/gcc-ward-information',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-chennai',
        features=200,
    ),

    # ──────── Hyderabad ────────
    Dataset(
        id='wards_hyderabad',
        name='Hyderabad (GHMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/hyderabad/hyderabad-wards.kml'),
        category='administrative',
        level='wards_hyderabad',
        description='Greater Hyderabad Municipal Corporation — 145 wards across 6 zones.',
        source_org='Greater Hyderabad Municipal Corporation',
        source_url='https://data.opencity.in/dataset/hyderabad-wards-info',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-hyderabad',
        features=145,
    ),

    # ──────── Mumbai ────────
    Dataset(
        id='wards_mumbai',
        name='Mumbai (BMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/mumbai/mumbai-wards.kml'),
        category='administrative',
        level='wards_mumbai',
        description='Brihanmumbai Municipal Corporation — 24 administrative wards (A–T plus the city-island spread).',
        source_org='Brihanmumbai Municipal Corporation',
        source_url='https://data.opencity.in/dataset/mumbai-wards',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-mumbai',
        features=24,
    ),
    Dataset(
        id='electoral_wards_mumbai_2017',
        name='Mumbai Electoral Wards (2017)',
        src=str(HOME / 'GitHub/notf/supporting documents/mumbai/mumbai-227-electoral-wards-2017.geojson'),
        category='people',  # electoral → people-and-places
        level='electoral_wards_mumbai_2017',
        description='227 electoral ward divisions of Mumbai, 2017 delimitation. Use for election + civic-rep maps.',
        source_org='Mumbai State Election Commission',
        source_url='https://data.opencity.in/dataset/mumbai-electoral-wards',
        license='ODbL-1.0',
        unit='electoral wards',
        r2_prefix='electoral/wards-mumbai-2017',
        features=227,
    ),

    # ──────── Kolkata ────────
    Dataset(
        id='wards_kolkata',
        name='Kolkata (KMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/kolkata/kolkata-wards.kml'),
        category='administrative',
        level='wards_kolkata',
        description='Kolkata Municipal Corporation — 141 ward boundaries across the 16 boroughs.',
        source_org='Kolkata Municipal Corporation',
        source_url='https://data.opencity.in/dataset/kolkata-wards',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-kolkata',
        features=141,
    ),

    # ──────── Pune ────────
    Dataset(
        id='wards_pune',
        name='Pune (PMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/pune/pune-wards.kml'),
        category='administrative',
        level='wards_pune',
        description='Pune Municipal Corporation — 58 administrative wards.',
        source_org='Pune Municipal Corporation',
        source_url='https://data.opencity.in/dataset/pune-wards',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-pune',
        features=58,
    ),

    # ──────── Ahmedabad ────────
    Dataset(
        id='wards_ahmedabad',
        name='Ahmedabad (AMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/ahmedabad/ahmedabad-wards.kml'),
        category='administrative',
        level='wards_ahmedabad',
        description='Ahmedabad Municipal Corporation — 48 wards across the 7 zones.',
        source_org='Ahmedabad Municipal Corporation',
        source_url='https://data.opencity.in/dataset/ahmedabad-wards',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-ahmedabad',
        features=48,
    ),

    # ──────── Jaipur ────────
    Dataset(
        id='wards_jaipur',
        name='Jaipur (JMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/jaipur/jaipur-wards.kml'),
        category='administrative',
        level='wards_jaipur',
        description='Jaipur Municipal Corporation — 150 ward boundaries.',
        source_org='Jaipur Municipal Corporation',
        source_url='https://data.opencity.in/dataset/jaipur-wards',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-jaipur',
        features=150,
    ),

    # ──────── Gurugram ────────
    Dataset(
        id='wards_gurugram',
        name='Gurugram (MCG) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/gurugram/gurugram-wards.kml'),
        category='administrative',
        level='wards_gurugram',
        description='Municipal Corporation of Gurugram — 35 ward boundaries.',
        source_org='Municipal Corporation of Gurugram',
        source_url='https://data.opencity.in/dataset/gurugram-wards',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-gurugram',
        features=35,
    ),

    # ──────── Kochi ────────
    Dataset(
        id='wards_kochi',
        name='Kochi (KMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/kochi/kochi-wards.kml'),
        category='administrative',
        level='wards_kochi',
        description='Kochi Municipal Corporation ward boundaries — 74 administrative wards covering the city. Sourced from Oorvani Foundation\'s OpenCity data portal.',
        source_org='Kochi Municipal Corporation',
        source_url='https://data.opencity.in/dataset/kochi-wards',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-kochi',
        features=74,
    ),

    # ──────── Bhubaneshwar ────────
    Dataset(
        id='wards_bhubaneshwar',
        name='Bhubaneshwar (BMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/bhubaneshwar/bhubaneshwar-wards.kml'),
        category='administrative',
        level='wards_bhubaneshwar',
        description='Bhubaneshwar Municipal Corporation ward boundaries — 67 wards covering Odisha\'s capital city. Sourced from Oorvani Foundation\'s OpenCity data portal.',
        source_org='Bhubaneshwar Municipal Corporation',
        source_url='https://data.opencity.in/dataset/bhubaneshwar-wards',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-bhubaneshwar',
        features=67,
    ),

    # ──────── Visakhapatnam ────────
    Dataset(
        id='wards_vizag',
        name='Visakhapatnam (GVMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/vishakapatnam/vizag-wards.kml'),
        category='administrative',
        level='wards_vizag',
        description='Greater Visakhapatnam Municipal Corporation — 98 wards.',
        source_org='Greater Visakhapatnam Municipal Corporation',
        source_url='https://data.opencity.in/dataset/visakhapatnam-wards',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-vizag',
        features=98,
    ),

    # ──────── Thane ────────
    Dataset(
        id='wards_thane',
        name='Thane (TMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/thane/thane-wards.kml'),
        category='administrative',
        level='wards_thane',
        description='Thane Municipal Corporation — 47 wards across the city.',
        source_org='Thane Municipal Corporation',
        source_url='https://data.opencity.in/dataset/thane-wards',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-thane',
        features=47,
    ),
]


# ───────────────────── pipeline ─────────────────────

def r2_client():
    acc = os.environ['CLOUDFLARE_ACCOUNT_ID']
    return boto3.client(
        's3',
        endpoint_url=f'https://{acc}.r2.cloudflarestorage.com',
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto',
        config=Config(signature_version='s3v4', s3={'addressing_style': 'path'}),
    )


def upload(s3, path: Path, key: str, content_type: str) -> None:
    """Idempotent: skip if R2 already has an object of matching size."""
    size = path.stat().st_size
    try:
        head = s3.head_object(Bucket=BUCKET, Key=key)
        if head['ContentLength'] == size:
            print(f'    skip  {key}  ({size:,} bytes — already on R2)')
            return
    except s3.exceptions.ClientError as e:
        if e.response['Error']['Code'] not in ('404', 'NoSuchKey'):
            raise
    with path.open('rb') as f:
        s3.put_object(
            Bucket=BUCKET, Key=key, Body=f, ContentType=content_type,
            CacheControl='public, max-age=31536000, immutable',
        )
    print(f'    put   {key}  ({size:,} bytes)')


def to_geojson(src: Path, out: Path) -> None:
    """KML → GeoJSON via ogr2ogr (no-op if already .geojson/.json)."""
    if src.suffix.lower() in ('.geojson', '.json'):
        # ogr2ogr-roundtrip even GeoJSON to enforce CRS=4326 + drop NaN coords
        pass
    subprocess.run(
        ['ogr2ogr', '-f', 'GeoJSON', '-t_srs', 'EPSG:4326',
         '-skipfailures', str(out), str(src)],
        check=True, capture_output=True,
    )


def to_parquet(gj: Path, out: Path) -> int:
    """GeoJSON → Parquet via DuckDB-spatial. Returns feature count."""
    con = duckdb.connect()
    con.install_extension('spatial')
    con.load_extension('spatial')
    con.execute(f"""
        COPY (SELECT * FROM ST_Read('{gj}'))
        TO '{out}' (FORMAT 'parquet', COMPRESSION 'zstd')
    """)
    (n,) = con.execute(f"SELECT COUNT(*) FROM '{out}'").fetchone()
    return n


def to_pmtiles(gj: Path, out: Path, layer_name: str) -> None:
    """GeoJSON → PMTiles via tippecanoe."""
    out.unlink(missing_ok=True)
    subprocess.run(
        ['tippecanoe',
         '-o', str(out),
         '-l', layer_name,
         '-zg',
         '--drop-densest-as-needed',
         '--extend-zooms-if-still-dropping',
         '--force',
         '--no-progress-indicator',
         str(gj)],
        check=True, capture_output=True,
    )


def ingest(ds: Dataset, s3) -> dict:
    print(f'  {ds.id}  ({ds.src})')
    src = Path(ds.src)
    if not src.exists():
        raise FileNotFoundError(src)
    work = WORK / ds.id
    work.mkdir(parents=True, exist_ok=True)

    gj = work / f'{ds.id}.geojson'
    pq = work / f'{ds.id}.parquet'
    pmt = work / f'{ds.id}.pmtiles'

    to_geojson(src, gj)
    n = to_parquet(gj, pq)
    if ds.features and n != ds.features:
        print(f'    !!  feature count drifted: expected {ds.features}, got {n}')
    to_pmtiles(gj, pmt, ds.id)

    pq_key = f'{ds.r2_prefix}/{ds.id}.parquet'
    pmt_key = f'{ds.r2_prefix}/{ds.id}.pmtiles'
    upload(s3, pq, pq_key, 'application/x-parquet')
    upload(s3, pmt, pmt_key, 'application/vnd.pmtiles')

    return {
        'id': ds.id,
        'name': ds.name,                # friendly label shown on the card
        'level': ds.level,
        'category': ds.category,
        'source': 'OpenCity',
        'description': ds.description,
        'unit': ds.unit,                # "wards" / "corporations" / "layouts" etc.
        'features': n,
        'license': ds.license,
        'r2_prefix': ds.r2_prefix,
        'parquet_file': f'{ds.id}.parquet',
        'parquet_bytes': pq.stat().st_size,
        'pmtiles_file': f'{ds.id}.pmtiles',
        'pmtiles_bytes': pmt.stat().st_size,
        'source_url': ds.source_url,
        'source_org': ds.source_org,
        'notes': ds.notes,
    }


def main() -> None:
    needed_env = ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    missing = [k for k in needed_env if k not in os.environ]
    if missing:
        sys.exit(f'missing env: {", ".join(missing)}')

    filt = sys.argv[1] if len(sys.argv) > 1 else None
    todo = [d for d in DATASETS if not filt or filt in d.id]
    if not todo:
        sys.exit(f'no datasets match "{filt}"')

    print(f'ingesting {len(todo)} dataset(s)…')
    s3 = r2_client()
    WORK.mkdir(parents=True, exist_ok=True)

    results = []
    for ds in todo:
        try:
            results.append(ingest(ds, s3))
        except Exception as e:
            print(f'    ✗ FAIL  {ds.id}: {e}')
            continue

    # Write manifest for build_catalog.py to consume
    manifest = ROOT / 'scripts' / 'external-ingested.json'
    manifest.write_text(json.dumps(results, indent=2))
    print(f'\nwrote {manifest.relative_to(ROOT)} ({len(results)}/{len(todo)} succeeded)')
    print('\nNext: update scripts/build_catalog.py LEVELS + LAYERS to surface these in the catalog.')


if __name__ == '__main__':
    main()
