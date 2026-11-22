"""Bake property_tax_chennai_wards: ward-wise property tax demand and collection,
2013-14 to 2017-18, for Greater Chennai Corporation, on the wards_chennai polygons.

Source: "Property Tax Data : Chennai : 2013 - 2018", published by Chennai Smart
City Ltd on the Smart Cities Mission data portal (smartcities.data.gov.in,
GODL-India). That portal gates each file behind a captcha, so the file is taken
from OpenCity's copy of it (data.opencity.in/dataset/chennai-property-tax-collections,
same 48,236 bytes; OpenCity sits behind a Cloudflare challenge, so it is fetched
by hand into data/external-src/chennai-property-tax/ and checked by md5 here).

Every source column is kept with its name and unit (rupees crore) as published.
Join: "Ward No." (N001..N200) to the ward number of the 200 wards_chennai
polygons (the 2011 Greater Chennai ward map, in force 2013-18). The bake stops
unless every ward joins one to one.

Usage:
    python3 scripts/bake_chennai_property_tax.py bake       # local formats
    python3 scripts/bake_chennai_property_tax.py upload     # R2, skips on md5
    python3 scripts/bake_chennai_property_tax.py register   # patch catalog + manifest
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import log  # noqa: E402
import pipeline  # noqa: E402
import bake_formats  # noqa: E402

CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
SRC = ROOT / 'data' / 'external-src' / 'chennai-property-tax' / 'Property_Tax_Data_Chennai_2013_to_2018.csv'
SRC_MD5 = 'c628d3092f38e70e9faa014929f4b85a'

LAYER_ID = 'property_tax_chennai_wards'
BASENAME = 'property_tax_chennai_wards'
R2_PREFIX = 'economy/property-tax-chennai-wards'
WARD_LAYER = 'wards_chennai'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'

YEARS = ['2013-14', '2014-15', '2015-16', '2016-17', '2017-18']
SOURCE_COLUMNS = ['City Name', 'Zone Name', 'Ward Name', 'Ward No.'] + [
    f'{fy} - Property Tax {what} (in crores) - {use}'
    for use in ('Residential', 'Commercial') for what in ('Collection', 'Demand') for fy in YEARS]
# Shapefile (.dbf) names, at most 10 characters; columns.txt in the zip maps them back.
SHP_NAMES = {'ward_no': 'ward_no', 'City Name': 'CityName', 'Zone Name': 'ZoneName', 'Ward Name': 'WardName',
             'Ward No.': 'WardNo', **{
                 f'{fy} - Property Tax {what} (in crores) - {use}': f'{use[0]}{what[:3].upper()}_{fy[2:4]}{fy[5:]}'
                 for use in ('Residential', 'Commercial') for what in ('Collection', 'Demand') for fy in YEARS},
             **{c: c for c in ('xmin', 'ymin', 'xmax', 'ymax')}}
LATEST_RES = '2017-18 - Property Tax Collection (in crores) - Residential'
TILE_FIELDS = ('ward_no', 'Zone Name', LATEST_RES,
               '2017-18 - Property Tax Demand (in crores) - Residential',
               '2017-18 - Property Tax Collection (in crores) - Commercial',
               '2017-18 - Property Tax Demand (in crores) - Commercial')

SOURCE = 'SmartCitiesChennai'
ATTRIBUTION = {'name': ('Greater Chennai Corporation / Chennai Smart City Ltd, '
                        'via the Smart Cities Mission data portal (MoHUA)'),
               'url': 'https://smartcities.data.gov.in/catalog/property-tax-chennai'}


# ── pure helpers ─────────────────────────────────────────────────────────

def source_ward_no(raw) -> int | None:
    m = re.fullmatch(r'N(\d+)', str(raw or '').strip())
    return int(m.group(1)) if m else None


def polygon_ward_no(raw) -> int | None:
    s = str(raw or '').strip()
    return int(s) if s.isdigit() else None


def join_problems(figures: dict[int, object], polygons: dict[int, object]) -> list[str]:
    out = []
    if extra := sorted(set(figures) - set(polygons)):
        out.append(f'figures for wards with no polygon: {extra}')
    if missing := sorted(set(polygons) - set(figures)):
        out.append(f'polygons with no figures: {missing}')
    return out


# ── bake ─────────────────────────────────────────────────────────────────

def write_joined_parquet(wards: Path, src: Path, out: Path) -> dict:
    import duckdb

    con = duckdb.connect()
    con.execute('LOAD spatial;')
    con.execute(f"CREATE TABLE tax AS SELECT * FROM read_csv('{src}', header = true, all_varchar = false)")
    header = [r[0] for r in con.execute('DESCRIBE tax').fetchall()]
    if header != SOURCE_COLUMNS:
        raise SystemExit(f'source columns changed: {header}')
    figures = {source_ward_no(w): w for (w,) in con.execute('SELECT "Ward No." FROM tax').fetchall()}
    polys = {polygon_ward_no(n): n for (n,) in con.execute(f"SELECT name2 FROM read_parquet('{wards}')").fetchall()}
    if None in figures or None in polys:
        raise SystemExit('a source row or polygon has no ward number')
    if probs := join_problems(figures, polys):
        raise SystemExit(f'join is not one to one: {probs}')
    con.create_function('ward_no_of', polygon_ward_no, ['VARCHAR'], 'INTEGER')
    cols = ', '.join(f't."{c}"' for c in SOURCE_COLUMNS)
    con.execute(f"""COPY (
        SELECT w.ward_no, {cols}, w.geometry
        FROM (SELECT ward_no_of(name2) AS ward_no, geom AS geometry FROM read_parquet('{wards}')) w
        JOIN tax t ON w.ward_no = CAST(substr(trim(t."Ward No."), 2) AS INTEGER)
        ORDER BY w.ward_no
    ) TO '{out}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
    return {'wards': len(polys), 'joined': con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]}


def bake(out_dir: Path, src: Path = SRC) -> dict:
    from bake_extracts import write_kml_from_geojson
    from pipeline import rebake_flatten_bbox

    if pipeline.file_md5(src) != SRC_MD5:
        raise SystemExit(f'{src.name}: md5 differs from the checked source file')
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='chennai_ptax_') as tmp:
        tmp = Path(tmp)
        wards = bake_formats.fetch_layer_file(CATALOG, WARD_LAYER, 'parquet', tmp / 'wards.parquet')
        joined = tmp / 'joined.parquet'
        stats = write_joined_parquet(wards, src, joined)
        parquet = out_dir / f'{BASENAME}.parquet'
        rows, prop_cols = rebake_flatten_bbox(joined, parquet)

    con = pipeline.make_con()
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    path['geojson'].unlink(missing_ok=True)
    # Not RFC7946: GDAL's RFC7946 mode cuts invalid source polygons into
    # GeometryCollections. Geometry as published, longitude first.
    con.execute(f"COPY (SELECT * FROM read_parquet('{parquet}')) TO '{path['geojson']}' "
                "WITH (FORMAT GDAL, DRIVER 'GeoJSON')")
    write_kml_from_geojson(path['geojson'], LAYER_ID, path['kml'])
    if prop_cols != list(SHP_NAMES):
        raise SystemExit(f'columns changed: {prop_cols}')
    bake_formats.shapefile_zip_from_geojson(path['geojson'], path['shapefile'], SHP_NAMES)
    bake_formats.write_pmtiles(path['geojson'], path['pmtiles'], LAYER_ID, TILE_FIELDS)
    summary = {'rows': rows, **stats, **pipeline.sizes_and_names(path)}
    SUMMARY.write_text(json.dumps(summary, indent=2))
    return summary


# ── catalog ──────────────────────────────────────────────────────────────

TAGS = ['property tax', 'municipal finance', 'ward', 'Chennai', 'Greater Chennai Corporation', 'GCC',
        'tax collection', 'tax demand', 'Smart Cities Mission']

CHOROPLETH = {'column': LATEST_RES, 'label': 'Residential property tax collected, 2017-18', 'unit': 'INR crore'}


def description() -> str:
    return ('Property tax demand and collection in each of Chennai\'s 200 wards, residential and '
            'commercial, for 2013-14 to 2017-18, in rupees crore, from Greater Chennai Corporation via '
            'the Smart Cities Mission data portal.')


def notes() -> str:
    return ('Published by Chennai Smart City Ltd on the Smart Cities Mission data portal '
            '(smartcities.data.gov.in, "Property Tax Data : Chennai : 2013 - 2018", GODL-India). The portal '
            'puts each download behind a captcha, so the file was taken from OpenCity\'s identical copy '
            '(data.opencity.in/dataset/chennai-property-tax-collections). Columns and units (rupees crore) '
            'are as published; Ward Name is NA in the source. Joined by ward number (N001 to N200) to the '
            '200-ward Greater Chennai Corporation map (wards_chennai), the ward map in force in 2013-18. '
            'Other Smart Cities property tax files are city totals or sit behind the same captcha and are '
            'not included.')


def level_meta() -> dict:
    return {'label': 'Chennai Property Tax by Ward (2013-18)', 'unit': 'wards', 'description': description()}


def catalog_entry(rows: int, sizes: dict[str, int], fetched_at: str, r2_public: str,
                  names: dict[str, str] | None = None) -> dict:
    names = names or pipeline.plain_names(BASENAME, EXT)
    entry = {'id': LAYER_ID, 'level': LAYER_ID, 'source': SOURCE, 'rows': rows,
             **pipeline.format_blocks(EXT, names, sizes, f'{r2_public}/{R2_PREFIX}')}
    entry.update({
        'licence': 'GODL-India',
        'attribution': {'primary': dict(ATTRIBUTION),
                        'publisher': {'name': 'OpenCity / Oorvani Foundation',
                                      'url': 'https://data.opencity.in/dataset/chennai-property-tax-collections'}},
        'category': 'economy',
        'provenance': 'curated',
        'fetched_at': fetched_at,
        'notes': notes(),
        'tags': TAGS,
        'choropleth': dict(CHOROPLETH),
    })
    return entry


def manifest_entry(rows: int, sizes: dict[str, int], names: dict[str, str] | None = None) -> dict:
    names = names or pipeline.plain_names(BASENAME, EXT)
    return {
        'id': LAYER_ID, 'name': level_meta()['label'], 'level': LAYER_ID, 'category': 'economy',
        'source': SOURCE, 'description': description(), 'unit': 'wards', 'features': rows,
        'license': 'GODL-India', 'r2_prefix': R2_PREFIX,
        **pipeline.manifest_files(names, sizes),
        'source_url': ATTRIBUTION['url'], 'source_org': ATTRIBUTION['name'],
        'notes': notes(), 'tags': TAGS,
    }


def upload(out_dir: Path) -> dict[str, str]:
    """Upload every format to its content-versioned key (<BASENAME>.<md5[:8]>.<ext>):
    changed bytes get a new key, unchanged files keep theirs (md5-skipped)."""
    return pipeline.upload_layer(out_dir, BASENAME, EXT, R2_PREFIX)


def register(catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST,
             summary_path: Path = SUMMARY, r2_public: str | None = None) -> None:
    """Patch catalog.json + external-ingested.json in place (never rebuild the
    catalog). Idempotent: the layer keeps its place, its first fetched_at and
    any rebaked tiles (pipeline.register_layer)."""
    summary = json.loads(summary_path.read_text())
    names = pipeline.summary_names(summary)
    fetched_at = datetime.now(timezone.utc).date().isoformat()
    entry = catalog_entry(summary['rows'], summary['sizes'], fetched_at, r2_public or pipeline.R2_PUBLIC, names=names)
    pipeline.register_layer(catalog_path, manifest_path, entry,
                            manifest_entry(summary['rows'], summary['sizes'], names=names),
                            level_meta(), attribution=(SOURCE, ATTRIBUTION))


def main() -> None:
    pipeline.step_cli(__doc__, {'bake': lambda a: log(json.dumps(bake(a.out), indent=2)),
                                'upload': lambda a: upload(a.out), 'register': lambda a: register()},
                      ('--out', {'type': Path, 'default': ROOT / 'data' / 'baked' / R2_PREFIX}))


if __name__ == '__main__':
    main()
