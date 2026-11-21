#!/usr/bin/env python3
"""
The rasters /api/v1/surface reads one pixel (or a 3 x 3 window) at a time,
clipped to India's bounding box (68-98E, 6-38N) as EPSG:4326 Cloud-Optimized
GeoTIFFs, the same pattern as scripts/bake_soilgrids.py:

  dem        Copernicus DEM GLO-90 (3 arcsec), elevation in whole metres (Int16).
             Source: the public AWS bucket copernicus-dem-90m, 1 x 1 degree COGs.
             Licence: the Copernicus DEM licence (free; reproduction, distribution
             and adaptation allowed with the WorldDEM-90 notice and the liability
             sentence). Slope is worked out at read time from a 3 x 3 window.
  worldpop   WorldPop 2020 constrained (BSGM), India, 3 arcsec (about 100 m),
             people per pixel (Float32), CC BY 4.0. One file from data.worldpop.org.
  worldcover ESA WorldCover 2021 v200, CC BY 4.0, resampled to 30 m (1 arcsec) by
             majority class: at 10 m the India COG is 7.5 GB, over the 3 GB limit
             (`size` measures the options). Each 10 m tile is warped on its own
             straight from ESA's public bucket and cached, so a stopped run resumes.

Steps (each output written atomically; a killed run redoes only the step it was in;
a second run with the same inputs does nothing):
  fetch      the source files into raw/<name>/ (resumable, size-checked, 6 at a time)
  build      out/<Name>.tif, a COG with 64 x 64 internal tiles, DEFLATE, no overviews
  upload     to a content-versioned key (never overwrites; md5-skipped, then md5-verified)
  register   the key into shared/surface_rasters.json

Raw downloads can be fetched again from their public sources, so they stay local
(as in bake_osm_underground.py); the built COGs go to R2 as soon as each is built.

Run:
    python3 -u scripts/bake_surface_rasters.py all --only dem,worldpop --minutes 120
    python3 -u scripts/bake_surface_rasters.py size --only worldcover
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pipeline  # noqa: E402
from bake_soilgrids import fetch  # noqa: E402
from pipeline import OutOfTime, cached, log, work_dir  # noqa: E402

ROOT = HERE.parent
SPEC_PATH = ROOT / 'shared' / 'surface_rasters.json'
WORK = work_dir('surface_rasters', 'SURFACE_RASTERS_WORK')
R2_PREFIX = 'surface'
BBOX = (68, 6, 98, 38)
MAX_BYTES = 3 * 1000**3          # the owner's ceiling for one raster on R2
FETCH_WORKERS = 6
GDAL_ENV = {**os.environ, 'GDAL_CACHEMAX': '1024', 'GDAL_DISABLE_READDIR_ON_OPEN': 'EMPTY_DIR'}
COG = ['-of', 'COG', '-co', 'BLOCKSIZE=64', '-co', 'COMPRESS=DEFLATE', '-co', 'LEVEL=9', '-co', 'OVERVIEWS=NONE',
       '-co', 'BIGTIFF=IF_SAFER', '-co', 'NUM_THREADS=ALL_CPUS']

DEM_BUCKET = 'https://copernicus-dem-90m.s3.amazonaws.com'
WORLDPOP_URL = ('https://data.worldpop.org/GIS/Population/Global_2000_2020_Constrained/2020/BSGM/IND/'
                'ind_ppp_2020_constrained.tif')
WORLDCOVER_BUCKET = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com'


# ── which source files ───────────────────────────────────────────────────────

def s3_keys(bucket: str, prefix: str, get=None) -> list[tuple[str, int]]:
    """(key, size) under a prefix of a public S3 bucket, following continuation tokens."""
    get = get or (lambda url: urllib.request.urlopen(url, timeout=120).read().decode())
    out, token = [], None
    while True:
        q = {'list-type': '2', 'prefix': prefix, 'max-keys': '1000', **({'continuation-token': token} if token else {})}
        x = get(f'{bucket}/?{urllib.parse.urlencode(q)}')
        out += [(k, int(s)) for k, s in re.findall(r'<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>', x)]
        m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', x)
        if not m:
            return out
        token = m.group(1)


def dem_tile_lnglat(key: str) -> tuple[int, int] | None:
    """The lower-left corner (lng, lat) of a GLO-90 DEM tile key, or None for other files."""
    m = re.search(r'Copernicus_DSM_COG_30_([NS])(\d\d)_00_([EW])(\d{3})_00_DEM\.tif$', key)
    if not m:
        return None
    lat = int(m[2]) * (1 if m[1] == 'N' else -1)
    lng = int(m[4]) * (1 if m[3] == 'E' else -1)
    return lng, lat


def touches_india(lng: float, lat: float, size: float) -> bool:
    x0, y0, x1, y1 = BBOX
    return lng + size > x0 and lng < x1 and lat + size > y0 and lat < y1


def dem_sources(get=None) -> list[tuple[str, int]]:
    out = []
    for lat in range(BBOX[1], BBOX[3]):
        for key, size in s3_keys(DEM_BUCKET, f'Copernicus_DSM_COG_30_N{lat:02d}_00_E0', get):
            ll = dem_tile_lnglat(key)
            if ll and touches_india(*ll, 1):
                out.append((key, size))
    return sorted(out)


def worldcover_lnglat(key: str) -> tuple[int, int] | None:
    m = re.search(r'_([NS])(\d\d)([EW])(\d{3})_Map\.tif$', key)
    if not m:
        return None
    return int(m[4]) * (1 if m[3] == 'E' else -1), int(m[2]) * (1 if m[1] == 'N' else -1)


# ── steps ────────────────────────────────────────────────────────────────────

def listing(work: Path, name: str, build) -> list[tuple[str, int]]:
    """The source list, cached so a re-run asks the bucket nothing."""
    path = work / 'cache' / f'{name}.sources.json'
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        pipeline.write_json(path, build())
    return [tuple(x) for x in json.loads(path.read_text())]


def fetch_all(urls_dests: list[tuple[str, Path]], label: str) -> None:
    done = got = 0
    with ThreadPoolExecutor(FETCH_WORKERS) as pool:
        for n in pool.map(lambda ud: fetch(*ud), urls_dests):
            done, got = done + 1, got + n
            if done % 50 == 0 or done == len(urls_dests):
                log(f'    {label}: {done}/{len(urls_dests)} files, {got / 1e6:,.0f} MB')


def out_path(work: Path, name: str) -> Path:
    return work / 'out' / f'{RASTERS[name]["basename"]}.tif'


def build_dem(work: Path) -> Path:
    srcs = listing(work, 'dem', dem_sources)
    raw = work / 'raw' / 'dem'
    log(f'  dem: {len(srcs)} GLO-90 tiles, {sum(s for _, s in srcs) / 1e9:.2f} GB')
    fetch_all([(f'{DEM_BUCKET}/{k}', raw / Path(k).name) for k, _ in srcs], 'dem')
    vrt = raw / 'dem.vrt'
    pipeline.run(['gdalbuildvrt', '-q', '-overwrite', str(vrt), *sorted(str(raw / Path(k).name) for k, _ in srcs)],
                 timeout=600)

    def translate(part: Path) -> None:
        x0, y0, x1, y1 = BBOX
        pipeline.run(['gdal_translate', '-q', '-projwin', str(x0), str(y1), str(x1), str(y0), '-ot', 'Int16',
                      '-a_nodata', '-32768', *COG, '-co', 'PREDICTOR=YES', str(vrt), str(part)],
                     timeout=6 * 3600, env=GDAL_ENV)
    return cached(out_path(work, 'dem'), translate)


def build_worldpop(work: Path) -> Path:
    raw = work / 'raw' / 'worldpop' / Path(WORLDPOP_URL).name
    pipeline.download(WORLDPOP_URL, raw)

    def translate(part: Path) -> None:
        x0, y0, x1, y1 = BBOX
        pipeline.run(['gdal_translate', '-q', '-projwin', str(x0), str(y1), str(x1), str(y0), *COG,
                      str(raw), str(part)], timeout=3 * 3600, env=GDAL_ENV)
    return cached(out_path(work, 'worldpop'), translate)


def size_worldcover(work: Path) -> dict:
    """Source size over India, plus measured 30 m and 90 m (mode) samples of one tile, to choose a resolution."""
    keys = listing(work, 'worldcover', lambda: [(k, s) for k, s in s3_keys(WORLDCOVER_BUCKET, 'v200/2021/map/')
                                                if (ll := worldcover_lnglat(k)) and touches_india(*ll, 3)])
    total = sum(s for _, s in keys)
    sample_key = next(k for k, _ in keys if 'N27E075' in k)
    src_size = dict(keys)[sample_key]
    report = {'tiles': len(keys), 'source_10m_bytes': total, 'sample_tile': sample_key, 'sample_10m_bytes': src_size}
    for label, arcsec in (('30m', 1), ('90m', 3)):
        sample = work / 'cache' / f'worldcover_sample_{label}.tif'
        if not sample.exists():
            sample.parent.mkdir(parents=True, exist_ok=True)
            res = str(arcsec / 3600)
            pipeline.run(['gdalwarp', '-q', '-overwrite', '-r', 'mode', '-tr', res, res, *COG,
                          f'/vsicurl/{WORLDCOVER_BUCKET}/{sample_key}', str(sample)], timeout=3600, env=GDAL_ENV)
        ratio = sample.stat().st_size / src_size
        report[f'sample_{label}_bytes'] = sample.stat().st_size
        report[f'estimate_{label}_bytes'] = int(total * ratio)
        log(f'  worldcover {label}: sample {ratio:.3f} of 10 m, so about {total * ratio / 1e9:.2f} GB over India')
    log(f'  worldcover 10 m: {len(keys)} tiles, {total / 1e9:.2f} GB')
    return report


def worldcover_part_name(key: str) -> str:
    lng, lat = worldcover_lnglat(key)
    return f'N{lat:02d}E{lng:03d}.tif'


def worldcover_warp(key: str, src: str, dest: str) -> list[str]:
    """One 3-degree WorldCover tile to 30 m (1 arcsec) by majority class, on its own square of the grid."""
    lng, lat = worldcover_lnglat(key)
    res = str(1 / 3600)
    return ['gdalwarp', '-q', '-overwrite', '-r', 'mode', '-tr', res, res,
            '-te', str(lng), str(lat), str(lng + 3), str(lat + 3), '-ot', 'Byte', '-dstnodata', '0',
            '-co', 'TILED=YES', '-co', 'COMPRESS=DEFLATE', src, dest]


def build_worldcover(work: Path, deadline: pipeline.Deadline | None = None) -> Path:
    """ESA WorldCover 2021 at 30 m: each 10 m tile warped on its own (cache/worldcover/, backed up on
    R2 every 10 minutes and on exit, so a stopped run resumes by tile), then one COG over India."""
    keys = listing(work, 'worldcover', lambda: [(k, s) for k, s in s3_keys(WORLDCOVER_BUCKET, 'v200/2021/map/')
                                                if (ll := worldcover_lnglat(k)) and touches_india(*ll, 3)])
    parts = work / 'cache' / 'worldcover'
    log(f'  worldcover: {len(keys)} ESA tiles, {sum(s for _, s in keys) / 1e9:.2f} GB at 10 m')
    with pipeline.cache_backup(parts, 'bake_surface_rasters/worldcover'):
        for i, (key, _) in enumerate(keys, 1):
            out = parts / worldcover_part_name(key)
            if out.exists():
                continue
            if deadline:
                deadline.check(f'worldcover tile {key}')
            t0 = time.monotonic()
            cached(out, lambda part, key=key: pipeline.run(
                worldcover_warp(key, f'/vsicurl/{WORLDCOVER_BUCKET}/{key}', str(part)), timeout=3600, env=GDAL_ENV))
            log(f'    worldcover {i}/{len(keys)} {out.name}: {out.stat().st_size / 1e6:.1f} MB ({time.monotonic() - t0:.0f} s)')
    vrt = parts.parent / 'worldcover.vrt'
    pipeline.run(['gdalbuildvrt', '-q', '-overwrite', '-srcnodata', '0', '-vrtnodata', '0', str(vrt),
                  *sorted(str(parts / worldcover_part_name(k)) for k, _ in keys)], timeout=600)

    def translate(part: Path) -> None:
        x0, y0, x1, y1 = BBOX
        pipeline.run(['gdal_translate', '-q', '-projwin', str(x0), str(y1), str(x1), str(y0), '-a_nodata', '0',
                      *COG, '-co', 'PREDICTOR=YES', str(vrt), str(part)], timeout=6 * 3600, env=GDAL_ENV)
    return cached(out_path(work, 'worldcover'), translate)


RASTERS = {
    'dem': {'basename': 'Copernicus_GLO90_India', 'build': build_dem},
    'worldpop': {'basename': 'WorldPop_2020_constrained_India', 'build': build_worldpop},
    'worldcover': {'basename': 'ESA_WorldCover_2021_India_30m', 'build': build_worldcover},
}


def upload(work: Path, name: str) -> dict:
    local = out_path(work, name)
    if local.stat().st_size > MAX_BYTES:
        raise RuntimeError(f'{local.name} is {local.stat().st_size / 1e9:.2f} GB, over the {MAX_BYTES / 1e9:.0f} GB '
                           'limit: not uploaded')
    s3 = pipeline.patient_r2_client()
    key = f'{R2_PREFIX}/{name}/{pipeline.versioned_names({"tif": local})["tif"]}'
    pipeline.r2_upload_retrying(s3, local, key, new_only=True)
    pipeline.r2_verify(s3, local, key)
    log(f'  verified s3://{pipeline.BUCKET}/{key}')
    return {'key': key, 'bytes': local.stat().st_size, 'md5': pipeline.file_md5(local)}


def register(spec_path: Path, name: str, file: dict) -> bool:
    """Put `file` under rasters[name].file; False (and nothing written) when it is already there."""
    spec = json.loads(spec_path.read_text())
    if spec['rasters'][name].get('file') == file:
        return False
    spec['rasters'][name]['file'] = file
    spec_path.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + '\n')
    return True


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['build', 'upload', 'register', 'all', 'size'])
    ap.add_argument('--only', default='dem,worldpop')
    ap.add_argument('--minutes', type=float, default=120)
    args = ap.parse_args(argv)
    deadline = pipeline.Deadline(args.minutes)
    names = args.only.split(',')
    try:
        if args.step == 'size':
            print(json.dumps(size_worldcover(WORK), indent=2))
            return 0
        for name in names:
            t0 = time.monotonic()
            if args.step in ('build', 'all'):
                deadline.check(f'build {name}')
                build = RASTERS[name]['build']
                p = build(WORK, deadline) if name == 'worldcover' else build(WORK)
                log(f'  {name}: {p.name} {p.stat().st_size / 1e6:,.1f} MB ({time.monotonic() - t0:,.0f} s)')
            if args.step in ('upload', 'all'):
                deadline.check(f'upload {name}')
                (WORK / 'out' / f'{name}.upload.json').write_text(json.dumps(upload(WORK, name)) + '\n')
            if args.step in ('register', 'all'):
                file = json.loads((WORK / 'out' / f'{name}.upload.json').read_text())
                log(f'  register {name}: ' + ('written' if register(SPEC_PATH, name, file) else 'already there'))
    except OutOfTime as e:
        log(f'stopped: {e}; finished work is kept, run again to continue')
        return 3
    except subprocess.CalledProcessError as e:
        log(f'failed: {e}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
