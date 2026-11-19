#!/usr/bin/env python3
"""
Land and water layers from ramSeraph releases (Nov 2026), republished under
policy B (bharatlas.com/about#sources-and-licensing): the government
publishers (NRSC Bhuvan, GSI NGDR, SLUSI) state no open licence, so the
compiler's CC0 applies, crediting DataMeet, ramSeraph and the publisher.

  slusi_priority_micro_watersheds  SLUSI micro-watersheds with a soil-conservation priority
  bhuvan_gw_prospect_structures    structures (faults, dykes, lineaments) on the RGNDWM groundwater prospect maps
  bhuvan_lineaments_50k            NRSC lineaments 1:50k (2005-06)
  gsi_lithology_50k                GSI lithology 1:50k
  bhuvan_geomorphology_50k         NRSC geomorphology 1:50k (2005-06)

Not ingested (see SKIPPED): parquet over 2 GB does not fit the one-file-per-
layer architecture, and the catalog has no pattern for splitting one national
layer into per-state layers.

Same pipeline as scripts/ingest_ramseraph.py (its helpers are imported, not
copied), with what multi-GB inputs need: resumable downloads, every step
cached and written atomically (a killed run resumes; a second run does no
work), a time limit that stops cleanly between steps, and checks before
anything goes live (lon,lat first coordinates; decoded tile counts).

Run (R2 creds in the env: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY):
    python3 -u scripts/bake_land_water.py                     # all, smallest first
    python3 -u scripts/bake_land_water.py gsi_lithology_50k   # one layer
    python3 -u scripts/bake_land_water.py --no-upload         # build + check locally only
    python3 -u scripts/bake_land_water.py --no-upload --register  # + manifest and root catalog entry
    python3 -u scripts/bake_land_water.py --minutes 300       # stop cleanly after 5 h
Uploads wait for the host-wide upload lock (pipeline.upload_lock, shared with
the other upload jobs); a lock left by a killed job (kill -9) is taken over.
"""
from __future__ import annotations

import contextlib
import dataclasses
import json
import math
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest_ramseraph as ir  # noqa: E402
from pipeline import make_con as pipeline_make_con  # noqa: E402
from pipeline import (  # noqa: E402
    CHUNK,
    OGR_ENV,
    TOOL_TIMEOUT_S,
    R2_PUBLIC,
    Deadline,
    OutOfTime,
    cached,
    download,
    file_md5,
    patient_r2_client,
    r2_upload_retrying,
    rebake_flatten_bbox,
    run,
    upload_lock,
    write_json,
)
from bake_formats import pmtiles_args  # noqa: E402

WORK = ir.WORK / 'land_water'


def parquet_and_tiles_only(d: ir.Dataset) -> ir.Dataset:
    """No whole-layer GeoJSON/KML/shapefile: for 4 million detailed 1:50k
    polygons the GeoJSON alone came to 25.6 GB. The parquet (and the viewer's
    Filter & export, and the API) serve parts of the layer."""
    return dataclasses.replace(d, bake_all_formats=False, notes=d.notes + (
        ' Parquet and map tiles only: a whole-layer GeoJSON would be tens of GB;'
        ' use Filter & export on the map, or the API, to download an area.'))


DATASETS: list[ir.Dataset] = [
    ir.republished(
        'slusi_priority_micro_watersheds', 'Priority micro-watersheds (SLUSI)', 'water', 'SLUSI',
        'indian_water_features/hydro-boundaries', 'SLUSI_Priority_MicroWatersheds',
        ('Micro-watersheds ranked by the Soil and Land Use Survey of India for soil conservation '
         '(priority from very high to very low), with hydrologic unit code. '
         'Use with the SLUSI micro-watershed boundaries.'),
        'micro-watersheds', 'https://slusi.dacnet.nic.in/', 'SLUSI (Soil & Land Use Survey of India)',
        'HU_CODE', 'water/slusi-priority-micro-watersheds'),
    ir.republished(
        'bhuvan_gw_prospect_structures', 'Groundwater prospect structures (Bhuvan)', 'water', 'Bhuvan',
        'indian_land_features/groundwater-prospects', 'Bhuvan_Groundwater_Prospects_STRU',
        ('Faults, fractures, dykes and lineaments mapped on the groundwater prospect maps of the Rajiv '
         'Gandhi National Drinking Water Mission (NRSC, 1:50k). Columns vary by state in the source. '
         'The prospect zones themselves are not included (too large for one file).'),
        'structures', 'https://bhuvan-app1.nrsc.gov.in/gwis/', 'Bhuvan (NRSC, ISRO)',
        'STRU', 'water/bhuvan-gw-prospect-structures'),
    ir.republished(
        'bhuvan_lineaments_50k', 'Lineaments 1:50k (Bhuvan 2005-06)', 'environment', 'Bhuvan',
        'indian_land_features/geomorphology', 'Bhuvan_Lineament_50k_0506',
        ('Geological and geomorphic lineaments mapped at 1:50,000 by NRSC in the 2005-06 national '
         'geomorphology mapping. Mizoram, Lakshadweep and some UTs are missing in the source.'),
        'lineaments', 'https://bhuvan.nrsc.gov.in/', 'Bhuvan (NRSC, ISRO)',
        'Des', 'environment/bhuvan-lineaments-50k'),
    parquet_and_tiles_only(ir.republished(
        'gsi_lithology_50k', 'Lithology 1:50k (GSI)', 'environment', 'NGDR',
        'indian_land_features/geology', 'NGDR_Lithology_50k',
        ('Rock units mapped at 1:50,000 by the Geological Survey of India: lithology, age, '
         'supergroup, group, formation and stratigraphy, by toposheet.'),
        'rock units', 'https://bhukosh.gsi.gov.in/', 'Geological Survey of India (NGDR / Bhukosh)',
        'lithologic', 'environment/gsi-lithology-50k')),
    parquet_and_tiles_only(ir.republished(
        'bhuvan_geomorphology_50k', 'Geomorphology 1:50k (Bhuvan 2005-06)', 'environment', 'Bhuvan',
        'indian_land_features/geomorphology', 'Bhuvan_Geomorphology_50k_0506',
        ('Landforms mapped at 1:50,000 by NRSC in the 2005-06 national geomorphology mapping, in '
         'three levels (origin, process, landform). Mizoram, Lakshadweep and some UTs are missing '
         'in the source.'),
        'landform polygons', 'https://bhuvan.nrsc.gov.in/', 'Bhuvan (NRSC, ISRO)',
        'Des', 'environment/bhuvan-geomorphology-50k')),
]

# Tile attributes = the popup fields (the parquet and downloads keep every
# column); True = polygons (coalesce at low zoom, checked for holes).
TILES: dict[str, tuple[list[str], bool]] = {
    'slusi_priority_micro_watersheds': (['Priority', 'HU_CODE', 'HYDRO_UNIT', 'REP_CODE'], True),
    'bhuvan_gw_prospect_structures': (['STRU', 'SUB_STRU', 'SUB_STRUC', 'STRUCTURE_', 'NAME', 'sname'], False),
    'bhuvan_lineaments_50k': (['Des', 'Level1', 'Level2', 'Magnitude', 'st_code'], False),
    'gsi_lithology_50k': (['lithologic', 'age', 'supergroup', 'group_name', 'formation', 'stratigraphy_new',
                           'toposheet_'], True),
    'bhuvan_geomorphology_50k': (['Des', 'Level1', 'Level2', 'Level3', 'st_code'], True),
}

# Checked 2026-11-17 against the ramSeraph release assets (parquet total over all shards).
SKIPPED: dict[str, dict] = {
    'bhuvan_gw_prospects': {
        'file': 'indian_land_features/groundwater-prospects/Bhuvan_Groundwater_Prospects_LGEOM.{00,01}.parquet',
        'features': 820_552, 'parquet_bytes': 2_700_148_317, 'pmtiles_bytes': 856_905_481},
    'bhuvan_land_degradation_0506': {
        'file': 'indian_land_features/degradation/Bhuvan_Land_Degradation_50k_0506.{000,001,010,011}.parquet',
        'features': 1_110_598, 'parquet_bytes': 3_937_014_492, 'pmtiles_bytes': 672_575_832},
    'bhuvan_land_degradation_1516': {
        'file': 'indian_land_features/degradation/Bhuvan_Land_Degradation_50k_1516.{000,001,010,011}.parquet',
        'features': 1_106_126, 'parquet_bytes': 3_925_747_962, 'pmtiles_bytes': 673_950_856},
}


# ── verification ───────────────────────────────────────────────────────

KML_VERTEX = re.compile(r'<coordinates>\s*([^,\s<]+),([^,\s<]+)')


def _vertex(geom: dict | None) -> tuple[float, float] | None:
    coords = (geom or {}).get('coordinates')
    while coords and isinstance(coords[0], list):
        coords = coords[0]
    if not coords:
        return None
    x, y = float(coords[0]), float(coords[1])
    return (x, y) if math.isfinite(x) and math.isfinite(y) else None


def first_coord(path: Path) -> tuple[float, float]:
    """First vertex of the first feature with a real geometry (sources carry a
    few empty ones) in a GeoJSON, KML or zipped shapefile. Streams the file:
    GDAL's KML reader loads all of it and runs out of memory on GBs."""
    if path.name.endswith('.kml'):
        with path.open(encoding='utf-8') as f:
            tail = ''
            while chunk := f.read(CHUNK):
                buf = tail + chunk
                for m in KML_VERTEX.finditer(buf):
                    with contextlib.suppress(ValueError):
                        if v := _vertex({'coordinates': [m[1], m[2]]}):
                            return v
                tail = buf[-256:]
        raise ValueError(f'{path.name}: no coordinates')
    src = str(path)
    if path.name.endswith('.shp.zip'):
        shp = next(n for n in sorted(zipfile.ZipFile(path).namelist()) if n.endswith('.shp'))
        src = f'/vsizip/{path}/{shp}'
    proc = subprocess.Popen(['ogr2ogr', '-f', 'GeoJSONSeq', '/vsistdout/', src],
                            stdout=subprocess.PIPE, text=True, env=OGR_ENV)
    try:
        for line in proc.stdout:
            if v := _vertex(json.loads(line.strip('\x1e'))['geometry']):
                return v
    finally:
        proc.kill()
        proc.wait()
    raise ValueError(f'{path.name}: no coordinates')


def assert_lon_lat(path: Path) -> None:
    x, y = first_coord(path)
    assert 68 <= x <= 98 and 6 <= y <= 38, f'{path.name}: first coordinate {x},{y} is not lon,lat in India'


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """(west, south, east, north) in degrees of a web-mercator tile."""
    n = 2 ** z

    def lat(yy: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))
    return x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)


def tile_for(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def decode_tile(pmtiles: Path, z: int, x: int, y: int, out: Path) -> int:
    """Write one decoded tile's features (lon,lat) to a GeoJSON file; return their count."""
    text = run(['tippecanoe-decode', '-c', str(pmtiles), str(z), str(x), str(y)], timeout=600, text=True).stdout
    feats = [line.rstrip(',') for line in text.splitlines() if line.startswith('{ "type": "Feature"')]
    out.write_text('{"type": "FeatureCollection", "features": [' + ','.join(feats) + ']}')
    return len(feats)


def pmtiles_maxzoom(pmtiles: Path) -> int:
    with pmtiles.open('rb') as f:
        header = f.read(127)
    return header[101]


# Check points: Delhi ridge, Deccan (Pune), Chota Nagpur (Ranchi), Kerala coast.
PROBES = [(77.2, 28.6), (73.85, 18.5), (85.3, 23.35), (76.3, 9.95)]


def covered(col: str, env: str, polygons: bool, z: int) -> str:
    """SQL aggregate of what `col` covers inside the tile `env`: polygon area
    of the union (sources overlap: GSI lithology's summed area was 11x a z8
    tile), snapped to the tile's own grid so the union stays cheap; line length
    summed."""
    if not polygons:
        return f'coalesce(sum(ST_Length(ST_Intersection(ST_MakeValid({col}), {env}))), 0)'
    union = f'ST_Union_Agg(ST_ReducePrecision(ST_MakeValid({col}), {overview_grid(z)}))'
    return f'coalesce(ST_Area(ST_Intersection({union}, {env})), 0)'


def tile_report(pmtiles: Path, parquet: Path, con: duckdb.DuckDBPyConnection, polygons: bool,
                zooms: list[int]) -> list[dict]:
    """Per probe tile at each of `zooms`: decoded features vs parquet
    features meeting the tile, and the area (polygons) or length (lines)
    each covers inside the tile. tippecanoe can silently drop polygons and
    leave holes; decoded tiles, not HTTP statuses, show it."""
    rows = []
    tmp = pmtiles.with_name(f'{pmtiles.stem}.decoded.geojson')
    for lon, lat in PROBES:
        for z in zooms:
            x, y = tile_for(lon, lat, z)
            w, s, e, n = tile_bounds(z, x, y)
            env = f'ST_MakeEnvelope({w}, {s}, {e}, {n})'
            # bbox first (cheap), then the geometry: a big irregular polygon's
            # bbox meets many tiles the polygon does not.
            expect, want = con.execute(
                f"SELECT count(*), {covered('geometry', env, polygons, z)} "
                f"FROM read_parquet('{parquet}') WHERE xmax >= ? AND xmin <= ? AND ymax >= ? AND ymin <= ? "
                f"AND ST_Intersects(geometry, {env})",
                [w, e, s, n]).fetchone()
            decoded = decode_tile(pmtiles, z, x, y, tmp)
            got = con.execute(
                f"SELECT {covered('geom', env, polygons, z)} FROM ST_Read('{tmp}')"
            ).fetchone()[0] if decoded else 0
            rows.append({'z': z, 'x': x, 'y': y, 'decoded': decoded, 'parquet': expect,
                         'cover': round(got / want, 3) if want else None})
    tmp.unlink(missing_ok=True)
    return rows


def probe_zooms(zmax: int, overview: bool) -> list[int]:
    """z5 and the max zoom; with an overview, both sides of its seam too."""
    seam = {OVERVIEW_MAXZOOM, OVERVIEW_MAXZOOM + 1} if overview else set()
    return sorted({5, zmax} | seam)


MIN_COVER = 0.98
# Below the detail zooms an overview generalises by design: tippecanoe's
# simplification at z5 (about 1 km a tile unit) removes landforms narrower
# than that (river channels, valleys). Geomorphology measured 0.95-0.96 at z5
# even with every polygon kept; lithology 0.99. Real holes measured 0.54.
MIN_OVERVIEW_COVER = 0.93


def tiles_ok(rows: list[dict], complete_from: int, polygons: bool, overview: bool = False) -> bool:
    """Every zoom from `complete_from` (the max zoom, or the first detail
    zoom under an overview) keeps every feature; polygons also cover the
    land at every probed zoom (no holes)."""
    for r in rows:
        if r['parquet'] == 0:
            continue
        if r['z'] >= complete_from and r['decoded'] < r['parquet']:
            return False
        least = MIN_OVERVIEW_COVER if overview and r['z'] < complete_from else MIN_COVER
        if polygons and r['cover'] is not None and r['cover'] < least:
            return False
    return True


def tippecanoe_args(src: Path, out: Path, layer: str, fields: list[str], polygons: bool,
                    minzoom: int = 0, maxzoom: int | None = None) -> list[str]:
    """The house tile settings (bake_formats.pmtiles_args: popup fields only),
    but polygons coalesce instead of dropping at low zoom: dropping left half
    of a z5 tile of micro-watersheds empty, coalescing covers all of it.
    A fixed `maxzoom` (an overview) never extends past it; `minzoom` starts
    the detail tiles above an overview."""
    args = pmtiles_args(src, out, layer, fields, parallel=True, max_zoom=maxzoom)
    if maxzoom is not None:
        # An overview drops its smallest (sub-pixel) polygons first: coalescing
        # merged them back into many-ring features that overflowed again.
        args[args.index('--drop-densest-as-needed')] = '--drop-smallest-as-needed'
        args.remove('--extend-zooms-if-still-dropping')
        # Half the detail below its max zoom (invisible on a 512 px tile):
        # z5 geomorphology tiles fit without dropping, cover 0.70 -> 0.95.
        args.insert(args.index('-P'), '-D11')
        # Marks every overview feature: the viewer leaves these unstroked, or
        # the 1-degree cell seams of the dissolve draw a grid over the land.
        args[-1:-1] = ['-y', OVERVIEW_MARKER, '--set-attribute', f'{OVERVIEW_MARKER}:1']
    elif polygons:
        args[args.index('--drop-densest-as-needed')] = '--coalesce-densest-as-needed'
    if minzoom:
        zmin = f'-Z{minzoom}'
        if '-Z0' in args:
            args[args.index('-Z0')] = zmin
        else:
            args.insert(args.index('-zg') + 1, zmin)
    return args


# Polygon layers so dense that no low-zoom tile can hold their features
# (4 million 1:50k rock units: a z5 tile met 900,000 and kept 2,000, 9% of
# the land) get a dissolved overview below the detail tiles: the union per
# class per 1-degree cell, written as single polygons (tippecanoe shrinks
# sub-pixel polygons per feature, not per ring), snapped to and simplified at one tile unit of the
# overview's max zoom (smaller than anything it can show). Value = the
# class column (a popup field), kept as the overview's only attribute.
OVERVIEW: dict[str, str] = {
    'gsi_lithology_50k': 'lithologic',
    'bhuvan_geomorphology_50k': 'Des',
}
# z9 is the first zoom whose lithology tiles kept every 1:50k polygon at all
# four probes (z8 kept 3,223 of 33,539 near Pune), so the overview runs to z8.
OVERVIEW_MAXZOOM = 8
OVERVIEW_CELL_DEG = 1
OVERVIEW_MARKER = '_ov'  # web/src reads the same name


def overview_grid(maxzoom: int = OVERVIEW_MAXZOOM) -> float:
    """One tile unit (of 4096) at `maxzoom`, in degrees: snapping to it
    changes nothing the overview tiles can show."""
    return 360 / 2 ** maxzoom / 4096


def dissolve_overview(flat: Path, out: Path, field: str, con: duckdb.DuckDBPyConnection,
                      deadline: Deadline) -> Path:
    """Line-delimited GeoJSON of `field` + geometry, unioned per value per
    cell. Every polygon is clipped to each cell it touches, so neighbouring
    cells meet on the cell line and never overlap (GSI sheets overlap at
    their edges: assigned whole to one cell, those strips drew twice, a
    darker 1-degree grid at country zoom). One cached file per 1-degree
    latitude band (a killed run redoes one band), joined at the end. Reads
    the parquet; never writes it."""
    if out.exists():
        return out
    grid, cell = overview_grid(), OVERVIEW_CELL_DEG
    real = 'xmin <= 180'  # rows with a real geometry (some are LINESTRING(nan nan, ...))
    bands = [b for (b,) in con.execute(
        f"SELECT DISTINCT unnest(range(floor(ymin / {cell})::INT, floor(ymax / {cell})::INT + 1)) b "
        f"FROM read_parquet('{flat}') WHERE {real} ORDER BY b").fetchall()]
    parts = []
    for i, band in enumerate(bands):
        deadline.check(f'overview band {band}')
        part_out = out.with_name(f'{out.stem}.band{band}.geojsonl')
        south, north = band * cell, (band + 1) * cell
        cached(part_out, lambda part, south=south, north=north: con.execute(f"""
            COPY (WITH pieces AS (
                    SELECT "{field}", cx, ST_ReducePrecision(ST_Intersection(ST_MakeValid(geometry),
                               ST_MakeEnvelope(cx * {cell}, {south}, (cx + 1) * {cell}, {north})), {grid}) AS g
                    FROM (SELECT "{field}", geometry,
                                 unnest(range(floor(xmin / {cell})::INT, floor(xmax / {cell})::INT + 1)) AS cx
                          FROM read_parquet('{flat}') WHERE {real} AND ymax >= {south} AND ymin <= {north})),
                  cells AS (
                    SELECT "{field}", ST_CollectionExtract(ST_Union_Agg(g), 3) AS g
                    FROM pieces WHERE NOT ST_IsEmpty(g) GROUP BY "{field}", cx)
                  SELECT "{field}", geometry FROM (
                    SELECT "{field}", unnest(ST_Dump(ST_SimplifyPreserveTopology(g, {grid}))).geom AS geometry
                    FROM cells)
                  WHERE NOT ST_IsEmpty(geometry) AND ST_Area(geometry) > 0)
            TO '{part}' WITH (FORMAT GDAL, DRIVER 'GeoJSONSeq')"""))
        parts.append(part_out)
        print(f'    overview: band {band} done ({i + 1}/{len(bands)})', flush=True)

    def join(part: Path) -> None:
        with part.open('wb') as f:
            for p in parts:
                with p.open('rb') as band:
                    shutil.copyfileobj(band, f, CHUNK)
    cached(out, join)
    for p in parts:
        p.unlink()
    return out


def tippecanoe(args: list[str], log: Path) -> None:
    """Run tippecanoe/tile-join, keeping its warnings (dropped or coalesced
    features) in `log` for the report."""
    with log.open('a') as f:
        f.write(f'$ {" ".join(args)}\n')
        f.flush()
        run(args, timeout=TOOL_TIMEOUT_S, capture_output=False, stdout=f, stderr=subprocess.STDOUT)


def bake_tiles(flat: Path, out: Path, layer: str, fields: list[str], polygons: bool,
               con: duckdb.DuckDBPyConnection, overview: str | None = None,
               deadline: Deadline | None = None) -> None:
    """Line-delimited GeoJSON of the popup fields (rows with a real geometry
    only: two source rows are LINESTRING(nan nan, ...)), then tippecanoe.
    With an `overview` class column: dissolved overview tiles to
    OVERVIEW_MAXZOOM, the detail tiles above it, tile-joined into one
    tileset with one layer name. Every step is cached."""
    if out.exists():
        return
    deadline = deadline or Deadline(600)
    log = out.with_name(f'{out.stem}.tippecanoe.log')
    seq = out.with_name(f'{out.stem}.tiles.geojsonl')
    cols = ', '.join(f'"{f}"' for f in fields)

    def features() -> Path:  # only for a tile step that still has to run
        return cached(seq, lambda part: con.execute(
            f"COPY (SELECT {cols}, geometry FROM read_parquet('{flat}') WHERE xmin <= 180) "
            f"TO '{part}' WITH (FORMAT GDAL, DRIVER 'GeoJSONSeq')"))
    if overview is None:
        cached(out, lambda part: tippecanoe(tippecanoe_args(features(), part, layer, fields, polygons), log))
        seq.unlink()
        return
    deadline.check('detail tiles')
    detail = cached(out.with_name(f'{out.stem}.detail.pmtiles'), lambda part: tippecanoe(
        tippecanoe_args(features(), part, layer, fields, polygons, minzoom=OVERVIEW_MAXZOOM + 1), log))
    ov_seq = dissolve_overview(flat, out.with_name(f'{out.stem}.overview.geojsonl'), overview, con, deadline)
    deadline.check('overview tiles')
    low = cached(out.with_name(f'{out.stem}.overview.pmtiles'), lambda part: tippecanoe(
        tippecanoe_args(ov_seq, part, layer, [overview], polygons, maxzoom=OVERVIEW_MAXZOOM), log))
    # -pk: the two tilesets are already sized; tile-join must not drop tiles over 500 KB.
    cached(out, lambda part: tippecanoe(
        ['tile-join', '-o', str(part), '-n', layer, '-pk', '-f', '-q', str(low), str(detail)], log))
    # The slow steps (detail tiles, dissolve) stay cached for a re-tune of the
    # overview tiles; the GeoJSON of every feature (4-22 GB) goes.
    for p in (seq, low):
        p.unlink(missing_ok=True)


# ── pipeline ───────────────────────────────────────────────────────────

def make_con(work: Path) -> duckdb.DuckDBPyConnection:
    """pipeline.make_con sized for these layers: spill under `work`, 24 GB, streaming COPYs."""
    return pipeline_make_con(temp_dir=work / 'duckdb_tmp', memory_limit='24GB', ordered=False)


def build(d: ir.Dataset, deadline: Deadline) -> dict:
    """Every local file for one layer, each step cached. Returns
    {'files': {local: r2 name}, 'features': n, 'bakes': {fmt: path}}."""
    work = WORK / d.id
    pq_name, pm_name = Path(d.parquet_url).name, Path(d.pmtiles_url).name
    raw_pq = WORK / 'raw' / pq_name
    download(d.parquet_url, raw_pq)
    deadline.check('parquet rebake')

    con = make_con(work)
    flat = cached(work / pq_name, lambda part: rebake_flatten_bbox(raw_pq, part, con))
    features = con.execute(f"SELECT count(*) FROM read_parquet('{flat}')").fetchone()[0]
    print(f'  {d.id}: {features:,} features in {flat.name} ({flat.stat().st_size:,} bytes)', flush=True)

    deadline.check('whole-layer bakes')
    record = work / 'bakes.json'
    if not record.exists():
        bakes = ir.bake_whole_layer(d, flat, work / 'bake', Path(pq_name).stem)
        record.write_text(json.dumps({fmt: str(p) for fmt, p in bakes.items()}))
    bakes = {fmt: Path(p) for fmt, p in json.loads(record.read_text()).items()}
    for p in bakes.values():  # every run: nothing goes live with lat,lon swapped
        assert_lon_lat(p)
    print(f'  {d.id}: bakes {sorted(bakes)}', flush=True)

    deadline.check('tiles')
    fields, polygons = TILES[d.id]
    overview = OVERVIEW.get(d.id)
    pm = work / pm_name
    bake_tiles(flat, pm, d.id, fields, polygons, con, overview, deadline)
    zmax = pmtiles_maxzoom(pm)
    report = work / 'tiles.json'
    if not report.exists():
        report.write_text(json.dumps(
            tile_report(pm, flat, con, polygons, probe_zooms(zmax, overview is not None)), indent=1))
    rows = json.loads(report.read_text())
    for r in rows:
        print(f"    z{r['z']}/{r['x']}/{r['y']}: decoded {r['decoded']:,}  parquet {r['parquet']:,}"
              f"  cover {r['cover']}", flush=True)
    if not tiles_ok(rows, OVERVIEW_MAXZOOM + 1 if overview else zmax, polygons, overview is not None):
        raise RuntimeError(f'{d.id}: tiles lose features or leave holes; see {report}')

    files = {flat: pq_name, pm: tiles_name(pm), **{p: p.name for p in bakes.values()}}
    return {'files': files, 'features': features, 'bakes': bakes}


def tiles_name(pm: Path) -> str:
    """The tiles' R2 name, <stem>.<md5[:8]>.pmtiles: R2 objects stay immutable
    once a catalog points at them, so a rebuilt tileset gets a new key."""
    return f'{pm.stem}.{file_md5(pm)[:8]}.pmtiles'


CATALOG = ir.ROOT / 'catalog.json'


def patch_root_catalog(d: ir.Dataset, pq_bytes: int, pm_bytes: int, features: int,
                       bakes: dict[str, Path], pm_name: str, catalog: Path | None = None) -> None:
    """Patch the repo-root catalog.json only: web/public/catalog.json is a
    gitignored copy the prerender overwrites on every build."""
    catalog = catalog or CATALOG
    c = json.loads(catalog.read_text())
    info = {fmt: {'name': p.name, 'bytes': p.stat().st_size} for fmt, p in bakes.items()}
    ir.merge_layer_into_catalog(c, d, pq_bytes, pm_bytes, features, info)
    # The tiles are baked here (popup fields), not the compiler's file, under a versioned name.
    next(lyr for lyr in c['layers'] if lyr['id'] == d.id)['pmtiles'] = {
        'url': f'{R2_PUBLIC}/{d.r2_prefix}/{pm_name}', 'bytes': pm_bytes}
    write_json(catalog, c)


def publish(d: ir.Dataset, built: dict) -> None:
    s3 = patient_r2_client()
    with upload_lock(owner='bake_land_water'):
        for local, name in built['files'].items():
            r2_upload_retrying(s3, local, f'{d.r2_prefix}/{name}')
    register(d, built)


def register(d: ir.Dataset, built: dict) -> None:
    """The manifest row and the root catalog entry (both idempotent)."""
    files = {name: local for local, name in built['files'].items()}
    pq_bytes = files[Path(d.parquet_url).name].stat().st_size
    pm_name = next(name for name in files if name.endswith('.pmtiles'))
    pm_bytes = files[pm_name].stat().st_size
    ir.append_manifest(d, pq_bytes, pm_bytes, built['features'], pm_name)
    patch_root_catalog(d, pq_bytes, pm_bytes, built['features'], built['bakes'], pm_name)
    print(f'  {d.id}: in the manifest and the root catalog', flush=True)


def main(argv: list[str]) -> int:
    args = argv[1:]
    do_upload = '--no-upload' not in args
    minutes = 600.0
    if '--minutes' in args:
        i = args.index('--minutes')
        minutes = float(args.pop(i + 1))
    ids = [a for a in args if not a.startswith('--')]
    if do_upload:
        missing = [k for k in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY') if k not in os.environ]
        if missing:
            print(f'ERROR: not set in env: {missing}')
            return 2
    targets = [d for d in DATASETS if not ids or d.id in ids]
    deadline = Deadline(minutes)
    for d in targets:
        print(f'\n-> {d.id}', flush=True)
        try:
            built = build(d, deadline)
            if do_upload:
                publish(d, built)
            elif '--register' in args:
                register(d, built)
        except OutOfTime as e:
            print(f'STOPPED: {e}; finished steps are cached, re-run to continue', flush=True)
            return 3
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
