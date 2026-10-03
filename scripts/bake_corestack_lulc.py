#!/usr/bin/env python3
"""
Bake the CoRE Stack IndiaSAT v4 land-use / land-cover (2023-24) block layer.

Input is the per-polygon class-area table exported from Google Earth Engine:
for every lgd_blocks polygon (keyed by its unique OBJECTID), the summed pixel
area in m² of each IndiaSAT class, computed at the native 10 m resolution with
class labels rounded to integers (the asset stores them as DOUBLE with float
noise, e.g. 5.999999999999999 for class 6). That export lives outside this repo;
this script turns it into the catalog layer.

Outputs (local only; upload is a separate, explicit step):
  data/baked/agriculture/corestack-lulc-blocks/<basename>.parquet   (+ flat bbox, Hilbert order)
  data/baked/agriculture/corestack-lulc-blocks/<basename>.pmtiles
  data/baked/agriculture/corestack-lulc-blocks/<basename>.geojson
  data/baked/agriculture/corestack-lulc-blocks/<basename>.kml
  data/baked/agriculture/corestack-lulc-blocks/<basename>.shp.zip  (short DBF names + columns.txt)

Geometry is the original lgd_blocks geometry, one row per source polygon, so
district and state totals (query_layer group_by + sum on the *_ha columns) never
double-count. Shares (*_pct) are not additive: sum hectares and recompute.

Run:
    python3 scripts/bake_corestack_lulc.py --results lulc_final_by_objectid.json \\
        --blocks LGD_Blocks.parquet
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
R2_PREFIX = 'agriculture/corestack-lulc-blocks'
BASENAME = 'CoREStack_LULC_Blocks_2023_24'
LAYER_ID = 'corestack_lulc_blocks'
LULC_YEAR = '2023-24'

# IndiaSAT v4 class code -> output column stem. Class 0 (background) is not land
# cover. Class 5 ("Crops", intensity unassigned) has no column: it is a handful of
# stray pixels in v4 2023-24 (0.73 ha nationally), so it is folded into
# cropland_ha / mapped_area_ha and kept out of the intensity index.
# check_class5_share() stops the bake if a future year makes it material.
CLASS_COLS: dict[int, str] = {
    1: 'built_up',
    2: 'water_kharif',
    3: 'water_kharif_rabi',
    4: 'water_perennial',
    6: 'trees',
    7: 'barren',
    8: 'single_kharif',
    9: 'single_nonkharif',
    10: 'double_crop',
    11: 'triple_crop',
    12: 'shrubs_scrubs',
    13: 'orchard',
}
CROPLAND = (8, 9, 10, 11)       # intensity-labelled cropland
UNASSIGNED_CROPS = 5            # cropland without an intensity label
CLASS5_MAX_SHARE_PCT = 1.0      # above this, class 5 deserves its own column

KEY_COLUMNS = ['block_lgd', 'block_name', 'dist_lgd', 'district', 'state_lgd', 'state', 'lulc_year']
OUTPUT_COLUMNS = (
    KEY_COLUMNS
    + ['block_area_ha', 'mapped_area_ha', 'mapped_pct']
    + [f'{s}_ha' for s in CLASS_COLS.values()]
    + ['cropland_ha', 'cropping_intensity_index']
    + [f'{s}_pct' for s in CLASS_COLS.values()]
    + ['cropland_pct']
)

# Shapefile (DBF) field names cap at 10 characters; ogr2ogr's automatic
# truncation would turn the *_ha / *_pct pairs into ambiguous clashes.
SHP_NAMES: dict[str, str] = {
    'block_lgd': 'block_lgd', 'block_name': 'block_name', 'dist_lgd': 'dist_lgd',
    'district': 'district', 'state_lgd': 'state_lgd', 'state': 'state',
    'lulc_year': 'lulc_year',
    'block_area_ha': 'blk_ha', 'mapped_area_ha': 'mapped_ha', 'mapped_pct': 'mapped_pct',
    'built_up_ha': 'built_ha', 'water_kharif_ha': 'wtrk_ha', 'water_kharif_rabi_ha': 'wtrkr_ha',
    'water_perennial_ha': 'wtrkrz_ha', 'trees_ha': 'trees_ha', 'barren_ha': 'barren_ha',
    'single_kharif_ha': 'crp1k_ha', 'single_nonkharif_ha': 'crp1nk_ha',
    'double_crop_ha': 'crp2_ha', 'triple_crop_ha': 'crp3_ha',
    'shrubs_scrubs_ha': 'shrubs_ha', 'orchard_ha': 'orchrd_ha',
    'cropland_ha': 'crop_ha', 'cropping_intensity_index': 'crop_int',
    'built_up_pct': 'built_pct', 'water_kharif_pct': 'wtrk_pct', 'water_kharif_rabi_pct': 'wtrkr_pct',
    'water_perennial_pct': 'wtrkrz_pct', 'trees_pct': 'trees_pct', 'barren_pct': 'barren_pct',
    'single_kharif_pct': 'crp1k_pct', 'single_nonkharif_pct': 'crp1nk_pct',
    'double_crop_pct': 'crp2_pct', 'triple_crop_pct': 'crp3_pct',
    'shrubs_scrubs_pct': 'shrubs_pct', 'orchard_pct': 'orchrd_pct',
    'cropland_pct': 'crop_pct',
}

KNOWN_CODES = {0, 5, *CLASS_COLS}


def _share(part: float, whole: float) -> float | None:
    return round(100 * part / whole, 2) if whole > 0 else None


def check_class5_share(class5_ha: float, cropland_ha: float) -> None:
    """Stop the bake if unassigned-intensity cropland is material nationally."""
    share = _share(class5_ha, cropland_ha) or 0.0
    if share > CLASS5_MAX_SHARE_PCT:
        raise ValueError(f'class 5 ("Crops", intensity unassigned) is {share:.2f}% of cropland, '
                         f'above {CLASS5_MAX_SHARE_PCT}%: give it its own column before baking')


def derive_row(classes_m2: dict[str, float], block_area_ha: float) -> dict:
    """Output columns for one polygon from its class areas (m², keys 'c<code>').

    Raises on any unknown class so a future IndiaSAT year with new classes fails
    loudly instead of silently losing area.
    """
    for key in classes_m2:
        if int(key[1:]) not in KNOWN_CODES:
            raise ValueError(f'unexpected IndiaSAT class {key}; update CLASS_COLS')

    ha = {code: classes_m2.get(f'c{code}', 0.0) / 1e4 for code in CLASS_COLS}
    unassigned = classes_m2.get(f'c{UNASSIGNED_CROPS}', 0.0) / 1e4
    mapped = sum(ha.values()) + unassigned
    intensity_cropland = sum(ha[c] for c in CROPLAND)
    cropland = intensity_cropland + unassigned
    weighted = 1 * (ha[8] + ha[9]) + 2 * ha[10] + 3 * ha[11]

    mapped_pct = _share(mapped, block_area_ha)
    row = {
        'block_area_ha': round(block_area_ha, 2),
        'mapped_area_ha': round(mapped, 2),
        'mapped_pct': min(mapped_pct, 100.0) if mapped_pct is not None else None,
    }
    for code, stem in CLASS_COLS.items():
        row[f'{stem}_ha'] = round(ha[code], 2)
    row['cropland_ha'] = round(cropland, 2)
    row['cropping_intensity_index'] = (round(weighted / intensity_cropland, 3)
                                       if intensity_cropland > 0 else None)
    for code, stem in CLASS_COLS.items():
        row[f'{stem}_pct'] = _share(ha[code], mapped)
    row['cropland_pct'] = _share(cropland, mapped)
    return row


# ---------------------------------------------------------------------------
# Bake (I/O). Heavy helpers are imported here so the pure functions above stay
# importable by the unit tests without GDAL / build_catalog side effects.
# ---------------------------------------------------------------------------

def _column_types() -> dict[str, str]:
    types = {c: 'DOUBLE' for c in OUTPUT_COLUMNS}
    types.update({'block_lgd': 'INTEGER', 'dist_lgd': 'INTEGER', 'state_lgd': 'INTEGER',
                  'block_name': 'VARCHAR', 'district': 'VARCHAR', 'state': 'VARCHAR',
                  'lulc_year': 'VARCHAR', 'objectid': 'INTEGER'})
    return types


def _write_shapefile_zip(geojson: Path, out: Path) -> None:
    """GeoJSON -> shapefile with explicit short DBF names, zipped with a key."""
    layer = subprocess.run(['ogrinfo', '-q', '-so', str(geojson)], check=True,
                           capture_output=True, text=True).stdout.split(':', 1)[1].split('(')[0].strip()
    select = ', '.join(f'"{long}" AS "{short}"' for long, short in SHP_NAMES.items())
    with tempfile.TemporaryDirectory(prefix='shp_') as tmp:
        tmp_dir = Path(tmp)
        subprocess.run(['ogr2ogr', '-f', 'ESRI Shapefile', '-nlt', 'PROMOTE_TO_MULTI',
                        '-lco', 'ENCODING=UTF-8', '-dialect', 'OGRSQL',
                        '-sql', f'SELECT {select} FROM "{layer}"',
                        str(tmp_dir / f'{out.name.removesuffix(".shp.zip")}.shp'), str(geojson)],
                       check=True, capture_output=True)
        key = ['Shapefile field names are limited to 10 characters.',
               'Full names (as in the Parquet / GeoJSON / API):', '']
        key += [f'{short:<11} {long}' for long, short in SHP_NAMES.items()]
        (tmp_dir / 'columns.txt').write_text('\n'.join(key) + '\n')
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(tmp_dir.iterdir()):
                zf.write(f, arcname=f.name)


def _write_pmtiles(geojson: Path, out: Path) -> None:
    out.unlink(missing_ok=True)
    subprocess.run(['tippecanoe', '-o', str(out), '-l', LAYER_ID, '-zg',
                    '--drop-densest-as-needed', '--extend-zooms-if-still-dropping',
                    '-x', 'xmin', '-x', 'ymin', '-x', 'xmax', '-x', 'ymax',
                    '--force', '--no-progress-indicator', str(geojson)],
                   check=True, capture_output=True)


def bake(results_path: Path, blocks_parquet: Path, out_dir: Path) -> dict:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import duckdb
    from ingest_ramseraph import rebake_flatten_bbox
    from bake_extracts import gdal_geojson_available, write_kml_from_geojson
    from bake_whole_layer import write_geojson_whole

    results = {int(k): v for k, v in json.loads(results_path.read_text()).items()}
    con = duckdb.connect()
    con.execute('LOAD spatial;')
    blocks = con.execute(f"""
        SELECT OBJECTID, block_lgd, block_name, dist_lgd, district, state_lgd, state,
               ST_Area_Spheroid(ST_FlipCoordinates(geometry)) / 1e4 AS area_ha
        FROM read_parquet('{blocks_parquet.as_posix()}')""").fetchall()

    ids = {b[0] for b in blocks}
    if ids != set(results):
        raise SystemExit(f'results/polygon mismatch: {len(ids - set(results))} polygons without '
                         f'results, {len(set(results) - ids)} results without a polygon')
    check_class5_share(
        class5_ha=sum(v.get(f'c{UNASSIGNED_CROPS}', 0.0) for v in results.values()) / 1e4,
        cropland_ha=sum(v.get(f'c{c}', 0.0) for v in results.values() for c in CROPLAND) / 1e4,
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='lulc_') as tmp:
        tmp = Path(tmp)
        ndjson = tmp / 'attrs.ndjson'
        with ndjson.open('w') as f:
            for oid, blk, bname, dlgd, dist, slgd, st, area in blocks:
                row = {'objectid': oid, 'block_lgd': blk, 'block_name': bname, 'dist_lgd': dlgd,
                       'district': dist, 'state_lgd': slgd, 'state': st, 'lulc_year': LULC_YEAR,
                       **derive_row(results[oid], area)}
                f.write(json.dumps(row) + '\n')

        types = _column_types()
        cols_sql = ', '.join(f"'{c}': '{t}'" for c, t in types.items())
        select = ', '.join(f'a."{c}"' for c in OUTPUT_COLUMNS)
        unsorted = tmp / 'unsorted.parquet'
        con.execute(f"""
            COPY (
              SELECT {select}, b.geometry
              FROM read_json('{ndjson.as_posix()}', format='newline_delimited', columns={{{cols_sql}}}) a
              JOIN read_parquet('{blocks_parquet.as_posix()}') b ON a.objectid = b.OBJECTID
            ) TO '{unsorted.as_posix()}' (FORMAT parquet, COMPRESSION zstd)""")

        parquet = out_dir / f'{BASENAME}.parquet'
        rows, _ = rebake_flatten_bbox(unsorted, parquet)

    geojson = out_dir / f'{BASENAME}.geojson'
    geojson.unlink(missing_ok=True)
    write_geojson_whole(con, parquet, geojson, gdal_geojson_available(con))
    kml = out_dir / f'{BASENAME}.kml'
    write_kml_from_geojson(geojson, LAYER_ID, kml)
    shp = out_dir / f'{BASENAME}.shp.zip'
    _write_shapefile_zip(geojson, shp)
    pmtiles = out_dir / f'{BASENAME}.pmtiles'
    _write_pmtiles(geojson, pmtiles)

    return {'rows': rows, 'files': {p.name: p.stat().st_size
                                    for p in (parquet, pmtiles, geojson, kml, shp)}}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--results', type=Path, required=True,
                    help='JSON {OBJECTID: {c<code>: m²}} exported from Earth Engine')
    ap.add_argument('--blocks', type=Path, required=True, help='lgd_blocks parquet')
    ap.add_argument('--out', type=Path, default=ROOT / 'data' / 'baked' / R2_PREFIX)
    args = ap.parse_args()
    summary = bake(args.results, args.blocks, args.out)
    print(f"rows: {summary['rows']}")
    for name, size in summary['files'].items():
        print(f'  {name:42} {size / 1e6:8.1f} MB')


if __name__ == '__main__':
    main()
