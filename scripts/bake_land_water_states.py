#!/usr/bin/env python3
"""
Two national Bhuvan layers too big for one download file, published with
their GeoJSON, KML and shapefile split per state (owner, 2026-11-18):

  bhuvan_gw_prospects            groundwater prospect zones (RGNDWM, 1:50k), 2.7 GB parquet
  bhuvan_land_degradation_1516   land degradation 1:50k, 2015-16, 3.9 GB parquet

Per layer:
  1. the ramSeraph shards (resumable downloads), joined into one national
     parquet with every source column, flat xmin/ymin/xmax/ymax and a
     Hilbert sort (rebake_flatten_bbox): the API and Filter & export read it
  2. one GeoJSON, KML and shapefile per state (the source's state column),
     each checked to hold exactly that state's rows; the states add up to
     the national total
  3. one zip per format holding the per-state files (the /layers row and
     the map's download menu list them like any other download: no new UI)
  4. national map tiles from the parquet with scripts/rebake_tiles.py
     (popup fields only, decoded checks at low, mid and max zoom, and the
     audit_tiles rule)
  5. uploads to versioned keys (<stem>.<md5[:8]>.<ext>), md5-skipped, while
     holding the shared upload lock
  6. --register: patch catalog.json and scripts/external-ingested.json in
     place, only once the query check for the layer has passed (the record
     WORK/<id>/query_check.json, written after timing a where + group_by
     query through the API code against the uploaded parquet)

Same republishing basis as scripts/bake_land_water.py (policy B, CC0 from the
compiler, crediting DataMeet, ramSeraph and NRSC); its helpers are imported,
not copied. Every step is cached and written atomically: a killed run redoes
only the step it was in, and a second run does no work.

Run (R2 creds in the env: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY):
    python3 -u scripts/bake_land_water_states.py --no-upload           # build + check only
    python3 -u scripts/bake_land_water_states.py                       # build, check, upload
    python3 -u scripts/bake_land_water_states.py --register            # ... and patch the catalog
    python3 -u scripts/bake_land_water_states.py bhuvan_gw_prospects --minutes 300
"""
from __future__ import annotations

import dataclasses
import json
import os
import shutil
import struct
import subprocess
import sys
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_land_water as blw  # noqa: E402
import build_filter_stats  # noqa: E402
import ingest_ramseraph as ir  # noqa: E402
import rebake_tiles as rt  # noqa: E402
from bake_formats import shapefile_key, short_field_names  # noqa: E402
from pipeline import OGR_ENV, R2_PUBLIC, _remote_has, file_md5, slug, upsert_by_id, write_json  # noqa: E402

WORK = blw.WORK / 'states'
CATALOG = ir.ROOT / 'catalog.json'
MANIFEST = HERE / 'external-ingested.json'
LOCK_OWNER = 'bake_land_water_states (feat/land-water-per-state)'
WORKERS = int(os.environ.get('STATE_WORKERS', '6'))
KML_TIMEOUT_S = 3 * 3600
DBF_MAX_BYTES = 2 * 1024**3  # .dbf and .shp: most GIS tools refuse 2 GB or more
RELEASES = 'https://github.com/ramSeraph/indian_land_features/releases'
SHP_INTRO = ['One shapefile per state.',
             'Shapefile field names are limited to 10 characters.',
             'Full names (as in the Parquet / GeoJSON / API):', '']


@dataclasses.dataclass(frozen=True)
class StateSplit:
    d: ir.Dataset
    tag: str               # release tag
    stem: str              # shard file stem
    parts: tuple[str, ...]  # shard suffixes
    state_column: str      # the source's state column
    popup: list[str]       # map tile attributes (every column stays in the files)

    @property
    def shards(self) -> list[str]:
        return [f'{RELEASES}/download/{self.tag}/{self.stem}.{p}.parquet' for p in self.parts]

    @property
    def release_url(self) -> str:
        return f'{RELEASES}/tag/{self.tag}'


SPLIT_NOTE = (' GeoJSON, KML and shapefile downloads are zips holding one file per state ({states} files, by'
              ' the source column `{col}`): one India-wide file would be tens of GB. The parquet holds the'
              ' whole layer; use Filter & export on the map, or the API, for an area.')

LAYERS: list[StateSplit] = [
    StateSplit(
        ir.republished(
            'bhuvan_gw_prospects', 'Groundwater prospect zones (Bhuvan)', 'water', 'Bhuvan',
            'indian_land_features/groundwater-prospects', 'Bhuvan_Groundwater_Prospects_LGEOM',
            ('Hydrogeomorphological units mapped at 1:50,000 by NRSC for the Rajiv Gandhi National Drinking '
             'Water Mission: lithology, landform and groundwater prospects, by state. Columns vary by state '
             'in the source.'),
            'prospect zones', 'https://bhuvan-app1.nrsc.gov.in/gwis/', 'Bhuvan (NRSC, ISRO)',
            'LG_2', 'water/bhuvan-gw-prospects'),
        'groundwater-prospects', 'Bhuvan_Groundwater_Prospects_LGEOM', ('00', '01'), 'sname',
        # Filled for most rows (parquet footers): legend code, lithology (LG_1) and landform (LG_2);
        # Odisha's rows use LG1/LG2.
        ['sname', 'SYM_CODE', 'ALNUM_CODE', 'LG_1', 'LG_2', 'LG1', 'LG2']),
    StateSplit(
        ir.republished(
            'bhuvan_land_degradation_1516', 'Land degradation 1:50k (Bhuvan 2015-16)', 'environment', 'Bhuvan',
            'indian_land_features/degradation', 'Bhuvan_Land_Degradation_50k_1516',
            ('Degraded land mapped at 1:50,000 by NRSC from 2015-16 satellite imagery: the process (water or '
             'wind erosion, salinity, waterlogging, mining and more) and its severity, with the 2005-06 '
             'mapping alongside.'),
            'degraded land polygons', 'https://bhuvan.nrsc.gov.in/', 'Bhuvan (NRSC, ISRO)',
            'LD_1516_L2', 'environment/bhuvan-land-degradation-1516'),
        'degradation', 'Bhuvan_Land_Degradation_50k_1516', ('000', '001', '010', '011'), 'lname',
        ['lname', 'LD_1516_L1', 'LD_1516_L2', 'DS_1516_L1', 'DS_1516_L2']),
]


def log(*msg: object) -> None:
    print(*msg, flush=True)


# ── national parquet ─────────────────────────────────────────────────────────

def national_parquet(shards: list[Path], out: Path, work: Path, con) -> int:
    """The shards as one parquet (columns by name: some shards lack some
    columns), then flat bbox + Hilbert sort. Rows keep shard order before
    the sort, so the bytes (and the md5) are the same on every run."""
    work.mkdir(parents=True, exist_ok=True)
    files = ', '.join(f"'{p}'" for p in shards)
    combined = work / 'combined.parquet'
    if not out.exists():
        con.execute('SET preserve_insertion_order = true')
        blw.cached(combined, lambda part: con.execute(
            f"COPY (SELECT * FROM read_parquet([{files}], union_by_name = true)) TO '{part}' "
            f"(FORMAT PARQUET, COMPRESSION ZSTD)"))
        con.execute('SET preserve_insertion_order = false')
        blw.cached(out, lambda part: ir.rebake_flatten_bbox(combined, part, con))
    combined.unlink(missing_ok=True)
    return con.execute(f"SELECT count(*) FROM read_parquet('{out}')").fetchone()[0]


# ── per-state files ──────────────────────────────────────────────────────────

def state_counts(con, parquet: Path, column: str) -> dict:
    rows = con.execute(f'SELECT "{column}", count(*) FROM read_parquet(\'{parquet}\') GROUP BY 1').fetchall()
    return dict(rows)


def state_stem(basename: str, value) -> str:
    return f"{basename}_{'no_state' if value is None else slug(value)}"


def shapefile_names(con, parquet: Path) -> dict[str, str]:
    """Column -> DBF name (10 characters at most), every column but the geometry."""
    cols = [c for c, t, *_ in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{parquet}')").fetchall()
            if 'GEOMETRY' not in t.upper()]
    return short_field_names(cols)


def _con(memory: str = '4GB', threads: int = 2):
    """blw.make_con (lon,lat, spill to disk), sized: per-state workers run side by side."""
    con = blw.make_con(WORK)
    con.execute(f"SET memory_limit = '{memory}'")
    con.execute(f'SET threads = {threads}')
    con.execute('SET enable_progress_bar = false')  # logs are progress lines, not a bar
    return con


def write_state_files(parquet: Path, column: str, value, out_dir: Path, basename: str,
                      kml_name_field: str = '') -> dict[str, Path]:
    """GeoJSON, KML and shapefile of one state's rows, every column (the
    shapefile's names shortened, with columns.txt in the zip). Each output
    is cached; a process-pool worker, so it opens its own connection."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = state_stem(basename, value)
    con = _con()
    src = f"read_parquet('{parquet}')"
    cond = f'"{column}" IS NULL' if value is None else f'"{column}" = $v'
    params = {} if value is None else {'v': value}

    geojson = out_dir / f'{stem}.geojson'
    blw.cached(geojson, lambda part: con.execute(
        f"COPY (SELECT * FROM {src} WHERE {cond}) TO '{part}' WITH (FORMAT GDAL, DRIVER 'GeoJSON')", params))

    kml = out_dir / f'{stem}.kml'
    blw.cached(kml, lambda part: subprocess.run(
        ['ogr2ogr', '-f', 'KML', *(['-dsco', f'NameField={kml_name_field}'] if kml_name_field else []),
         str(part), str(geojson)], check=True, capture_output=True, timeout=KML_TIMEOUT_S, env=OGR_ENV))

    shp_dir = out_dir / f'{stem}_shp'
    shp = shp_dir / f'{stem}.shp'
    if not shp.exists():
        tmp = out_dir / f'{stem}_shp.part'
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir()
        select = ', '.join(f'"{long}" AS "{short}"' for long, short in shapefile_names(con, parquet).items())
        con.execute(
            f"COPY (SELECT {select}, geometry FROM {src} WHERE {cond}) TO '{tmp / shp.name}' "
            "WITH (FORMAT GDAL, DRIVER 'ESRI Shapefile', LAYER_CREATION_OPTIONS ('ENCODING=UTF-8', 'RESIZE=YES'))",
            params)
        for part in tmp.iterdir():
            if part.suffix in ('.dbf', '.shp') and part.stat().st_size >= DBF_MAX_BYTES:
                raise RuntimeError(f'{part.name} is {part.stat().st_size:,} bytes (2 GB or more)')
        shutil.rmtree(shp_dir, ignore_errors=True)
        os.replace(tmp, shp_dir)
    con.close()
    return {'geojson': geojson, 'kml': kml, 'shapefile': shp}


# ── counting what was written ────────────────────────────────────────────────

def count_geojson_features(path: Path) -> int:
    """GDAL's GeoJSON writer puts one feature on each line."""
    with path.open('rb') as f:
        return sum(1 for line in f if line.startswith(b'{ "type": "Feature"'))


def count_kml_placemarks(path: Path) -> int:
    with path.open('rb') as f:
        return sum(line.count(b'<Placemark') for line in f)


def count_shapefile_features(shp: Path) -> int:
    """Records in the .shx index: 100-byte header, 8 bytes a record."""
    with shp.with_suffix('.shx').open('rb') as f:
        words = struct.unpack('>i', f.read(28)[24:28])[0]
    return (words * 2 - 100) // 8


def shapefile_fields(shp: Path) -> list[str]:
    with shp.with_suffix('.dbf').open('rb') as f:
        header = f.read(32)
        n = (struct.unpack('<H', header[8:10])[0] - 33) // 32
        return [f.read(32)[:11].split(b'\0', 1)[0].decode() for _ in range(n)]


def check_counts(fmt: str, expected: dict, got: dict, total: int) -> None:
    if sum(expected.values()) != total:
        raise RuntimeError(f'states hold {sum(expected.values()):,} rows, the layer {total:,}: they do not add up')
    wrong = {k: (got.get(k), v) for k, v in expected.items() if got.get(k) != v}
    if wrong:
        raise RuntimeError(f'{fmt}: per-state rows (written, expected) differ: {wrong}')


# ── zips + keys ──────────────────────────────────────────────────────────────

def stable_zip(files: list[Path], out: Path) -> None:
    """Zip `files` flat, sorted by name, with a fixed timestamp: the same
    inputs give the same bytes. Streams each file (they run to GBs)."""
    with blw.atomic_output(out) as part, zipfile.ZipFile(part, 'w', allowZip64=True) as zf:
        for f in sorted(files, key=lambda p: p.name):
            info = zipfile.ZipInfo(f.name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with f.open('rb') as src, zf.open(info, 'w', force_zip64=True) as dst:
                shutil.copyfileobj(src, dst, blw.CHUNK)


def versioned_name(name: str, md5: str) -> str:
    stem, ext = name.split('.', 1)
    return f'{stem}.{md5[:8]}.{ext}'


# ── catalog ──────────────────────────────────────────────────────────────────

def notes_for(layer: StateSplit, states: int) -> str:
    return (layer.d.notes + SPLIT_NOTE.format(states=states, col=layer.state_column) + ' ' + rt.NOTE)


def filter_stats_for(lid: str, parquet: Path, record: Path) -> dict:
    """build_filter_stats for the layer's parquet, cached in `record`: the
    Filter panel reads these from the catalog instead of probing the whole
    multi-GB parquet in the browser (which runs the tab out of memory)."""
    if not record.exists():
        stats = build_filter_stats.build_all([(lid, parquet)])[lid]
        with blw.atomic_output(record) as part:
            part.write_text(json.dumps(stats, default=str))
    return json.loads(record.read_text())


def register(layer: StateSplit, published: dict[str, tuple[str, int]], features: int, states: int,
             catalog: Path = CATALOG, manifest: Path = MANIFEST, filter_stats: dict | None = None) -> None:
    """Patch catalog.json and the ingest manifest in place (by id)."""
    base = f'{R2_PUBLIC}/{layer.d.r2_prefix}'
    (pq_name, pq_bytes), (pm_name, pm_bytes) = published['parquet'], published['pmtiles']
    d = dataclasses.replace(layer.d, parquet_url=f'{base}/{pq_name}', pmtiles_url=f'{base}/{pm_name}',
                            notes=notes_for(layer, states))
    c = json.loads(catalog.read_text())
    bakes = {fmt: {'name': published[fmt][0], 'bytes': published[fmt][1]} for fmt in ('geojson', 'kml', 'shapefile')}
    ir.merge_layer_into_catalog(c, d, pq_bytes, pm_bytes, features, bakes)
    entry = next(x for x in c['layers'] if x['id'] == d.id)
    entry['parquet']['upstream_url'] = layer.release_url
    entry['pmtiles'] = {'url': f'{base}/{pm_name}', 'bytes': pm_bytes}  # this run's tiles, ours (no upstream)
    if filter_stats is not None:
        c.setdefault('filter_stats', {})[d.id] = filter_stats
    write_json(catalog, c)
    rows = upsert_by_id(json.loads(manifest.read_text()), {
        'id': d.id, 'name': d.name, 'level': d.level, 'category': d.category, 'source': d.source,
        'description': d.description, 'unit': d.unit, 'features': features, 'license': d.license,
        'r2_prefix': d.r2_prefix, 'parquet_file': pq_name, 'parquet_bytes': pq_bytes,
        'pmtiles_file': pm_name, 'pmtiles_bytes': pm_bytes, 'source_url': d.source_url,
        'source_org': d.source_org, 'notes': d.notes})
    write_json(manifest, rows)


def query_check_passed(record: Path) -> bool:
    return record.exists() and json.loads(record.read_text()).get('ok') is True


# ── pipeline ─────────────────────────────────────────────────────────────────

def build_states(layer: StateSplit, pq: Path, total: int, work: Path, deadline: blw.Deadline) -> dict[str, Path]:
    """Per-state files in parallel, every count checked; then a zip per format."""
    lid = layer.d.id
    counts = state_counts(_con('8GB', threads=8), pq, layer.state_column)
    log(f'  {lid}: {len(counts)} states: ' + ', '.join(f'{k}={v:,}' for k, v in sorted(counts.items(), key=str)))
    zips = {'geojson': work / f'{layer.stem}.geojson.zip', 'kml': work / f'{layer.stem}.kml.zip',
            'shapefile': work / f'{layer.stem}.shp.zip'}
    if all(z.exists() for z in zips.values()):
        return zips
    out_dir = work / 'states'
    files: dict = {}
    with ProcessPoolExecutor(WORKERS) as pool:
        futures = {v: pool.submit(write_state_files, pq, layer.state_column, v, out_dir, lid, layer.d.kml_name_field)
                   for v in sorted(counts, key=lambda v: -counts[v])}
        for i, (v, fut) in enumerate(futures.items(), 1):
            files[v] = fut.result()
            log(f'    [{i}/{len(counts)}] {v}: {counts[v]:,} rows written')
            deadline.check(f'{lid}: per-state files')
    counters = {'geojson': count_geojson_features, 'kml': count_kml_placemarks, 'shapefile': count_shapefile_features}
    for fmt, count in counters.items():
        check_counts(fmt, counts, {v: count(f[fmt]) for v, f in files.items()}, total)
        log(f'  {lid}: {fmt} per-state rows match the parquet ({total:,} in all)')
    for f in files.values():
        blw.assert_lon_lat(f['geojson'])
    key_dir = work / 'shp_key'
    key_dir.mkdir(exist_ok=True)
    key = key_dir / 'columns.txt'
    key.write_text('\n'.join(shapefile_key(shapefile_names(_con(), pq), SHP_INTRO)) + '\n')
    members = {'geojson': [f['geojson'] for f in files.values()],
               'kml': [f['kml'] for f in files.values()],
               'shapefile': [p for f in files.values() for p in sorted(f['shapefile'].parent.iterdir())] + [key]}
    for fmt, z in zips.items():
        deadline.check(f'{lid}: {fmt} zip')
        if not z.exists():
            log(f'  {lid}: zipping {len(members[fmt])} {fmt} files')
            stable_zip(members[fmt], z)
        log(f'  {lid}: {z.name} {z.stat().st_size:,} bytes')
    return zips


def build(layer: StateSplit, deadline: blw.Deadline) -> dict:
    lid = layer.d.id
    work = WORK / lid
    shards = []
    for url in layer.shards:
        shards.append(blw.fetch(url, blw.WORK / 'raw' / Path(url).name))
    deadline.check(f'{lid}: national parquet')
    pq = work / f'{layer.stem}.parquet'
    total = national_parquet(shards, pq, work / 'tmp', _con('24GB', threads=os.cpu_count() or 8))
    log(f'  {lid}: {total:,} features, {pq.stat().st_size:,} bytes')
    deadline.check(f'{lid}: per-state files')
    zips = build_states(layer, pq, total, work, deadline)
    deadline.check(f'{lid}: tiles')
    rt.POPUP_FIELDS[lid] = layer.popup
    tiles_src = rt.WORK / lid / 'source.parquet'
    if not tiles_src.exists():
        tiles_src.parent.mkdir(parents=True, exist_ok=True)
        os.link(pq, tiles_src)  # rebake_tiles reads the layer's parquet from here
    pm, checks = rt.build({'id': lid, 'rows': total, 'parquet': {'url': str(pq)}}, deadline)
    log(f"  {lid}: tiles pass (audit {checks['flags'] or 'ok'}; {len(checks['tiles'])} decoded probe tiles)")
    return {'total': total, 'files': {'parquet': pq, 'pmtiles': pm, **zips}}


def publish(layer: StateSplit, built: dict) -> dict[str, tuple[str, int]]:
    """Upload each file to its versioned key; record {fmt: (name, bytes)}."""
    lid = layer.d.id
    record = WORK / lid / 'published.json'
    s3 = blw.r2_client()
    out = {}
    for fmt, local in built['files'].items():
        name = local.name if fmt != 'pmtiles' else f'{layer.stem}.pmtiles'
        md5 = file_md5(local)
        name = versioned_name(name, md5)
        key = f'{layer.d.r2_prefix}/{name}'
        if not _remote_has(s3, key, md5):  # the md5 skip, before taking the lock
            with rt.upload_lock(owner=LOCK_OWNER):
                blw.upload(s3, local, key)
        out[fmt] = (name, local.stat().st_size)
        log(f'  {lid}: {fmt} on R2 as {key} (md5 {md5})')
    record.write_text(json.dumps(out, indent=1))
    return out


def main(argv: list[str]) -> int:
    args = argv[1:]
    do_upload = '--no-upload' not in args
    do_register = '--register' in args
    minutes = 900.0
    if '--minutes' in args:
        i = args.index('--minutes')
        minutes = float(args.pop(i + 1))
    ids = [a for a in args if not a.startswith('--')]
    if do_upload:
        missing = [k for k in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
                   if k not in os.environ]
        if missing:
            log(f'ERROR: not set in env: {missing}')
            return 2
    deadline = blw.Deadline(minutes)
    for layer in [x for x in LAYERS if not ids or x.d.id in ids]:
        lid = layer.d.id
        log(f'\n-> {lid}')
        try:
            built = build(layer, deadline)
            if not do_upload:
                continue
            published = publish(layer, built)
            if do_register:
                if not query_check_passed(WORK / lid / 'query_check.json'):
                    log(f'  {lid}: NOT registered: no passing query check in {WORK / lid / "query_check.json"}')
                    continue
                states = len(state_counts(_con(), built['files']['parquet'], layer.state_column))
                pq = built['files']['parquet']
                register(layer, published, built['total'], states,
                         filter_stats=filter_stats_for(lid, pq, WORK / lid / 'filter_stats.json'))
                log(f'  {lid}: in catalog.json and the manifest')
        except blw.OutOfTime as e:
            log(f'STOPPED: {e}; finished steps are cached, re-run to continue')
            return 3
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(line_buffering=True)
    sys.exit(main(sys.argv))
