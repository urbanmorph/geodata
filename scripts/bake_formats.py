"""Shared helpers for baking a layer's download formats.

Used by the layer bakes (bake_corestack_lulc.py, bake_overture_places.py,
bake_mi6_wells.py) so tile settings and the shapefile key stay consistent.
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
from collections.abc import Iterable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# atomic_output is re-exported for scripts on other branches.
from pipeline import (  # noqa: E402,F401
    DBF_MAX_BYTES, TOOL_TIMEOUT_S, atomic_output, download, log, run, sizes_and_names, write_stable_zip)

HERE = Path(__file__).resolve().parent
JUNK_TS = HERE.parent / 'web' / 'functions' / 'lib' / 'junk-columns.ts'
BBOX = ('bbox', 'xmin', 'ymin', 'xmax', 'ymax')
DBF_NAME_MAX = 10
DBF_MAX_FIELDS = 255  # the dBASE limit; GDAL writes more, most readers refuse them
SHP_INTRO = ['Shapefile field names are limited to 10 characters.',
             'Full names (as in the Parquet / GeoJSON / API):', '']


def layer_url(catalog: dict, layer_id: str, fmt: str) -> str:
    return next(x for x in catalog['layers'] if x['id'] == layer_id)[fmt]['url']


def fetch_layer_file(catalog_path: Path, layer_id: str, fmt: str, dest: Path) -> Path:
    """Download a catalog layer's file (e.g. lgd_districts parquet) unless
    `dest` exists (pipeline.download: resumable, size- and md5-checked)."""
    if not dest.exists():
        download(layer_url(json.loads(catalog_path.read_text()), layer_id, fmt), dest)
    return dest


def features_sql(parquet: str, props_sql: str) -> str:
    """One GeoJSON Feature per parquet row; `props_sql` builds its properties."""
    return f"""
        SELECT 'Feature' AS type,
               ST_AsGeoJSON(geometry)::JSON AS geometry,
               {props_sql} AS properties
        FROM read_parquet('{parquet}')"""


def gis_artefact_columns(ts: Path = JUNK_TS) -> set[str]:
    """GIS_ARTEFACT_COLUMNS from junk-columns.ts (the set locate and nearby
    leave out), read from the one source so the two never drift."""
    text = ts.read_text()
    body = text[text.index('GIS_ARTEFACT_COLUMNS'):]
    body = body[body.index('[') + 1:body.index(']')]
    return set(re.findall(r"'([^']+)'", body))


def is_nested(sql_type: str) -> bool:
    t = sql_type.upper()
    return t.startswith(('STRUCT', 'MAP', 'UNION')) or t.endswith(']') or 'GEOMETRY' in t or t == 'BLOB'


def plain_popup_fields(schema: list[tuple[str, str]], junk: set[str]) -> list[str]:
    """The fields map tiles carry by default, in source order: every plain
    column but GIS artefacts (`junk`, lower case), the bbox and nested or
    geometry columns. The parquet and downloads keep every column."""
    return [c for c, t in schema if c not in BBOX and c.lower() not in junk and not is_nested(t)]


def tile_fields(popup: Iterable[str], filter_columns: Iterable[str],
                schema: list[tuple[str, str]]) -> list[str]:
    """The fields map tiles carry: the popup fields, then each column the
    Filter panel filters on (build_filter_stats.tile_filter_columns) that the
    popup lacks, so the map can draw every filter. Names not in the source
    are left out."""
    names = {c for c, _ in schema}
    out = list(popup)
    out += [c for c in dict.fromkeys(filter_columns) if c in names and c not in out]
    return out


def geojson_popup_fields(geojson: Path) -> list[str]:
    """plain_popup_fields of a GeoJSON's properties (read through DuckDB)."""
    from pipeline import make_con
    rows = make_con().execute(f"DESCRIBE SELECT * FROM ST_Read('{geojson}')").fetchall()
    return plain_popup_fields([(r[0], r[1]) for r in rows], gis_artefact_columns())


def pmtiles_args(src: Path, out: Path, layer: str, fields: Iterable[str],
                 parallel: bool = False, max_zoom: int | None = None, keep_all: bool = False) -> list[str]:
    """tippecanoe args keeping only `fields` (popup fields): every extra tile
    attribute makes tippecanoe drop more features at low zoom; no fields keeps
    them all. `parallel` reads line-delimited GeoJSON with -P. `max_zoom`
    fixes z0..max_zoom (locate tests points at the max zoom) instead of -zg.
    `keep_all` keeps every feature at every zoom (drop rate 1, no dropping to
    fit): for a few hundred points that should all show on the map of India."""
    # -n: tippecanoe otherwise names the tileset after the input file path.
    zoom = ['-Z0', f'-z{max_zoom}'] if max_zoom is not None else ['-zg']
    args = ['tippecanoe', '-o', str(out), '-l', layer, '-n', layer, *zoom]
    if parallel:
        args.append('-P')
    args += ['-r', '1'] if keep_all else ['--drop-densest-as-needed', '--extend-zooms-if-still-dropping']
    for field in fields:
        args += ['-y', field]
    return args + ['--force', '--no-progress-indicator', str(src)]


def write_pmtiles(src: Path, out: Path, layer: str, fields: Iterable[str], parallel: bool = False,
                  max_zoom: int | None = None, keep_all: bool = False) -> None:
    out.unlink(missing_ok=True)
    run(pmtiles_args(src, out, layer, fields, parallel, max_zoom, keep_all), timeout=TOOL_TIMEOUT_S)


def write_all_formats(con, path: dict[str, Path], layer: str, prop_cols: list[str], tile_fields: Iterable[str],
                      **tile_kw) -> dict[str, dict]:
    """From the layer's parquet at path['parquet']: the GeoJSON, and from it the
    KML, the shapefile zip (short DBF names for prop_cols, with their key) and
    the pmtiles (tile_kw: write_pmtiles' max_zoom, keep_all). Returns the
    summary's sizes and names of every file in `path`."""
    from bake_extracts import write_kml_from_geojson
    from bake_whole_layer import write_geojson_whole
    log(f'  {layer}: geojson')
    write_geojson_whole(con, path['parquet'], path['geojson'])
    log(f'  {layer}: kml')
    write_kml_from_geojson(path['geojson'], layer, path['kml'])
    log(f'  {layer}: shapefile')
    shapefile_zip_from_geojson(path['geojson'], path['shapefile'], short_field_names(prop_cols))
    log(f'  {layer}: pmtiles')
    write_pmtiles(path['geojson'], path['pmtiles'], layer, tile_fields, **tile_kw)
    return sizes_and_names(path)


def short_field_names(columns: list[str]) -> dict[str, str]:
    """Column -> unique (case-insensitive) DBF name of at most 10 characters.
    Names that already fit are reserved first and pass through unchanged;
    long ones are truncated, with a numeric suffix on collision.
    Deterministic for a given column order."""
    taken = {c.lower() for c in columns if len(c) <= DBF_NAME_MAX}
    names: dict[str, str] = {}
    for col in columns:
        if len(col) <= DBF_NAME_MAX:
            names[col] = col
            continue
        short, n = col[:DBF_NAME_MAX], 1
        while short.lower() in taken:
            suffix = str(n)
            short = col[:DBF_NAME_MAX - len(suffix)] + suffix
            n += 1
        taken.add(short.lower())
        names[col] = short
    return names


def shapefile_key(names: dict[str, str], intro: list[str] = SHP_INTRO) -> list[str]:
    """columns.txt lines: intro, then 'SHORT  long' per field."""
    return intro + [f'{short:<11} {long}' for long, short in names.items()]


def zip_with_key(src_dir: Path, out: Path, key_lines: list[str]) -> None:
    """Zip every file in `src_dir` plus a columns.txt holding `key_lines`."""
    (src_dir / 'columns.txt').write_text('\n'.join(key_lines) + '\n')
    write_stable_zip(sorted(src_dir.iterdir()), out)


class ShapefileTooBig(ValueError):
    """The layer does not fit one shapefile (a 2 GB .shp/.dbf, or over 255
    fields): ship none rather than one most GIS tools refuse."""


def shapefile_zip_from_geojson(geojson: Path, out: Path, names: dict[str, str],
                               intro: list[str] = SHP_INTRO, max_bytes: int = DBF_MAX_BYTES,
                               fid_column: str | None = None) -> None:
    """GeoJSON -> zipped shapefile with explicit short DBF names and a columns.txt key.
    String fields are as wide as their longest value (RESIZE=YES). `fid_column`
    is a column GDAL wrote as each feature's "id" (it does so to OGC_FID): it
    comes back from the id. Raises ShapefileTooBig, writing nothing, when the
    layer has more fields than a .dbf holds or the .shp or .dbf would reach `max_bytes`."""
    if len(names) > DBF_MAX_FIELDS:
        raise ShapefileTooBig(f'{out.name}: {len(names)} fields, a .dbf holds {DBF_MAX_FIELDS}')
    layer = run(['ogrinfo', '-q', '-so', str(geojson)], timeout=600,
                text=True).stdout.split(':', 1)[1].split('(')[0].strip()

    def source(long: str) -> str:
        return 'FID' if long == fid_column else f'"{long}"'
    select = ', '.join(f'{source(long)} AS "{short}"' for long, short in names.items())
    with tempfile.TemporaryDirectory(prefix='shp_') as tmp:
        tmp_dir = Path(tmp)
        run(['ogr2ogr', '-f', 'ESRI Shapefile', '-nlt', 'PROMOTE_TO_MULTI',
             '-lco', 'ENCODING=UTF-8', '-lco', 'RESIZE=YES', '-dialect', 'OGRSQL',
             '-sql', f'SELECT {select} FROM "{layer}"',
             str(tmp_dir / f'{out.name.removesuffix(".shp.zip")}.shp'), str(geojson)], timeout=TOOL_TIMEOUT_S)
        too_big = [p.name for p in sorted(tmp_dir.iterdir())
                   if p.suffix in ('.shp', '.dbf') and p.stat().st_size >= max_bytes]
        if too_big:
            raise ShapefileTooBig(f'{out.name}: {", ".join(too_big)} at or over {max_bytes:,} bytes')
        zip_with_key(tmp_dir, out, shapefile_key(names, intro))
