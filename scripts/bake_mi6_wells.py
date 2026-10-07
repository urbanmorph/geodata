"""Bake mi6_wells_districts: wells per LGD district, 6th Minor Irrigation Census.

Input is the Land Ledger district aggregate (~/Projects/rural/shc/build/
mi6_wells_district.parquet, method in its .md): census counts summed to LGD
districts, checked against the census report. The raw census rows (owner
social group, gender, village) never reach this script.

We publish the census-derived columns unedited and drop the four net-sown-area
columns (nsa_ha, nsa_years, wells_per_1000ha_nsa, parent_wells_per_1000ha_nsa):
their denominator is IDP land-use statistics, whose licence is blank.

Geometry: every lgd_districts polygon (785), census values where present.

Usage:
    python3 scripts/bake_mi6_wells.py bake [--wells PATH] [--out DIR]
    python3 scripts/upload_baked.py                    # uploads data/baked/*
    python3 scripts/bake_mi6_wells.py register         # patch catalog + manifest
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_formats  # noqa: E402
from build_catalog import ATTR  # noqa: E402

CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'

LAYER_ID = 'mi6_wells_districts'
BASENAME = 'MI6_Wells_Districts_2017_18'
R2_PREFIX = 'water/mi6-wells-districts'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
# Outside data/baked/: upload_baked.py mirrors that whole tree to the public bucket.
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'
DEFAULT_WELLS = Path.home() / 'Projects/rural/shc/build/mi6_wells_district.parquet'

CENSUS_TOTAL_WELLS = 21_931_924   # All-India report, Vol. I, Table I(A)
LGD_DISTRICT_POLYGONS = 785

KEYS = ['dist_lgd', 'state_lgd', 'district', 'state']
EXCLUDED = ('nsa_ha', 'nsa_years', 'wells_per_1000ha_nsa', 'parent_wells_per_1000ha_nsa')
PERSONAL = re.compile(r'owner|social|caste|gender|village|name_of', re.I)

TILE_FIELDS = ('district', 'state', 'status', 'total', 'dugwell', 'shallow_tw',
               'medium_tw', 'deep_tw', 'in_use_share', 'electric_share')

SOURCE = 'MIWing'
ATTRIBUTION = ATTR[SOURCE]


def output_columns(wells_cols: list[str]) -> list[str]:
    return [c for c in wells_cols if c not in EXCLUDED]


def check_columns(cols: list[str]) -> None:
    bad = [c for c in cols if PERSONAL.search(c)]
    if bad:
        raise ValueError(f'personal or village-level columns must never be published: {bad}')


def check_totals(rows: int, wells: int) -> None:
    if rows != LGD_DISTRICT_POLYGONS:
        raise ValueError(f'expected {LGD_DISTRICT_POLYGONS} district polygons, got {rows}')
    if wells != CENSUS_TOTAL_WELLS:
        raise ValueError(f'expected {CENSUS_TOTAL_WELLS:,} wells (census total), got {wells:,}')


def join_sql(wells: str, districts: str, cols: list[str]) -> str:
    """Every district polygon; names fall back to LGD's for districts the census lacks."""
    select = []
    for c in cols:
        if c == 'dist_lgd':
            select.append('g.dist_lgd')
        elif c == 'state_lgd':
            select.append('g.state_lgd')
        elif c == 'district':
            select.append('COALESCE(w.district, g.dtname) AS district')
        elif c == 'state':
            select.append('COALESCE(w.state, g.stname) AS state')
        else:
            select.append(f'w."{c}"')
    return f"""
        SELECT {', '.join(select)}, g.geometry
        FROM read_parquet('{districts}') g
        LEFT JOIN read_parquet('{wells}') w ON w.dist_lgd = g.dist_lgd
        ORDER BY g.dist_lgd"""


def description() -> str:
    return ('Wells per LGD district from the 6th Minor Irrigation Census (reference year 2017-18): '
            'dugwells and shallow, medium and deep tubewells, with status, pump energy source, '
            'depth and irrigation potential. Official census counts summed to districts.')


def notes() -> str:
    return ('Counts from the 6th Minor Irrigation Census (reference year 2017-18, enumerated '
            '2019-22), Minor Irrigation (Statistics) Wing, Ministry of Jal Shakti, published on '
            'data.gov.in under GODL-India. Summed from the ground-water scheme files to LGD '
            'districts by Land Ledger; the total matches the census report (21,931,924 wells). '
            'Census districts are the 2017-18 ones: districts carved out since have no counts of '
            'their own (status new_district) and their former district keeps them '
            '(counts_pre_split); counts are not split. Irrigation potential utilised is gross, '
            'summed over seasons, not net irrigated area. Depth classes are bins of the reported '
            'scheme depth. Well locations are not published and nothing below the district is '
            'included here. Delhi, Ladakh, Lakshadweep and Dadra and Nagar Haveli and Daman and '
            'Diu were not in the census; Manipur and Sikkim report no ground-water schemes.')


def level_meta() -> dict:
    return {'label': 'Wells by District (Minor Irrigation Census 2017-18)', 'unit': 'districts',
            'description': description()}


def catalog_entry(rows: int, sizes: dict[str, int], fetched_at: str, r2_public: str) -> dict:
    entry = {'id': LAYER_ID, 'level': LAYER_ID, 'source': SOURCE, 'rows': rows}
    for fmt, ext in EXT.items():
        entry[fmt] = {'url': f'{r2_public}/{R2_PREFIX}/{BASENAME}.{ext}', 'bytes': sizes[fmt]}
    entry.update({
        'licence': 'GODL-India',
        'attribution': {'primary': dict(ATTRIBUTION), 'publisher': None},
        'category': 'water',
        'provenance': 'curated',
        'fetched_at': fetched_at,
        'notes': notes(),
        'tags': TAGS,
    })
    return entry


TAGS = ['wells', 'groundwater', 'irrigation', 'dugwell', 'tubewell', 'borewell',
        'minor irrigation census', 'pumps', 'electric pumps', 'diesel pumps', 'solar pumps',
        'district', 'Jal Shakti']


def manifest_entry(rows: int, sizes: dict[str, int]) -> dict:
    return {
        'id': LAYER_ID, 'name': level_meta()['label'], 'level': LAYER_ID, 'category': 'water',
        'source': SOURCE, 'description': description(), 'unit': 'districts', 'features': rows,
        'license': 'GODL-India', 'r2_prefix': R2_PREFIX,
        'parquet_file': f'{BASENAME}.parquet', 'parquet_bytes': sizes['parquet'],
        'pmtiles_file': f'{BASENAME}.pmtiles', 'pmtiles_bytes': sizes['pmtiles'],
        'source_url': ATTRIBUTION['url'], 'source_org': ATTRIBUTION['name'],
        'notes': notes(), 'tags': TAGS,
    }


# ── side-effecting steps ─────────────────────────────────────────────────

def write_joined_parquet(wells: Path, districts: Path, out: Path) -> tuple[int, int]:
    import duckdb
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    wells_cols = [c[0] for c in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{wells}')").fetchall()]
    cols = output_columns(wells_cols)
    check_columns(cols)
    con.execute(f"COPY ({join_sql(str(wells), str(districts), cols)}) TO '{out}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    return con.execute(f"SELECT count(*), sum(total)::BIGINT FROM read_parquet('{out}')").fetchone()


def bake(wells: Path, out_dir: Path) -> dict:
    import duckdb
    from bake_extracts import gdal_geojson_available, write_kml_from_geojson
    from bake_whole_layer import write_geojson_whole
    from ingest_ramseraph import rebake_flatten_bbox

    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='wells_') as tmp:
        tmp = Path(tmp)
        districts = bake_formats.fetch_layer_file(CATALOG, 'lgd_districts', 'parquet', tmp / 'lgd_districts.parquet')
        joined = tmp / 'joined.parquet'
        rows, total = write_joined_parquet(wells, districts, joined)
        check_totals(rows=rows, wells=total)
        parquet = out_dir / f'{BASENAME}.parquet'
        _, prop_cols = rebake_flatten_bbox(joined, parquet)

    con = duckdb.connect()
    con.execute('LOAD spatial;')
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    path['geojson'].unlink(missing_ok=True)
    write_geojson_whole(con, parquet, path['geojson'], gdal_geojson_available(con))
    write_kml_from_geojson(path['geojson'], LAYER_ID, path['kml'])
    bake_formats.shapefile_zip_from_geojson(path['geojson'], path['shapefile'], bake_formats.short_field_names(prop_cols))
    bake_formats.write_pmtiles(path['geojson'], path['pmtiles'], LAYER_ID, TILE_FIELDS)

    summary = {'rows': rows, 'wells': total, 'sizes': {fmt: p.stat().st_size for fmt, p in path.items()}}
    SUMMARY.write_text(json.dumps(summary, indent=2))
    return summary


def register(catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST,
             summary_path: Path = SUMMARY, r2_public: str | None = None) -> None:
    """Patch catalog.json + external-ingested.json in place (never rebuild the
    catalog). Idempotent: re-running replaces this layer's entries."""
    if r2_public is None:
        from ingest_ramseraph import R2_PUBLIC as r2_public

    summary = json.loads(summary_path.read_text())
    fetched_at = datetime.now(timezone.utc).isoformat()
    catalog = json.loads(catalog_path.read_text())
    catalog['layers'] = [l for l in catalog['layers'] if l['id'] != LAYER_ID]
    catalog['layers'].append(catalog_entry(summary['rows'], summary['sizes'], fetched_at, r2_public))
    catalog['level_meta'][LAYER_ID] = level_meta()
    if LAYER_ID not in catalog['level_order']:
        catalog['level_order'].append(LAYER_ID)
    catalog['attribution'][SOURCE] = dict(ATTRIBUTION)
    catalog_path.write_text(json.dumps(catalog, indent=2, ensure_ascii=True) + '\n')

    manifest = [e for e in json.loads(manifest_path.read_text()) if e['id'] != LAYER_ID]
    manifest.append(manifest_entry(summary['rows'], summary['sizes']))
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=True) + '\n')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['bake', 'register'])
    ap.add_argument('--wells', type=Path, default=DEFAULT_WELLS)
    ap.add_argument('--out', type=Path, default=ROOT / 'data' / 'baked' / R2_PREFIX)
    a = ap.parse_args()
    if a.step == 'bake':
        print(json.dumps(bake(a.wells, a.out), indent=2))
    else:
        register()


if __name__ == '__main__':
    main()
