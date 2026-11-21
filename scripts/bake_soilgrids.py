#!/usr/bin/env python3
"""
SoilGrids 2.0 (ISRIC, 250 m, CC BY 4.0) over India's bounding box, as one
25-band Int16 Cloud-Optimized GeoTIFF that /api/v1/ground reads one pixel at a
time: 8 properties (clay, sand, silt, pH, soil organic carbon, bulk density,
CEC, nitrogen; the mean prediction) at 0-5, 5-15 and 15-30 cm, then the most
probable WRB reference soil group. Values stay ISRIC's scaled integers (the
API applies the conversion factors in shared/soilgrids.json).

Source: https://files.isric.org/soilgrids/latest/data/ (one VRT per map over
450 x 450 tiles in Interrupted Goode Homolosine; WRB over 4096 x 4096 tiles in
EPSG:4326). Licence: CC BY 4.0, stated in that folder's README.md. Credit
"ISRIC SoilGrids 2.0 (Poggio et al. 2021)".

Steps (each cached and written atomically, so a killed run redoes only the
band it was in; a second run with the same inputs does nothing):
  bands     per band: its VRT (raw/), the ISRIC tiles that touch India (raw/,
            fetched FETCH_WORKERS at a time over kept-alive connections, each
            checked against its Content-Length), then a warp to India's grid
            in EPSG:4326 (cache/parts/<band>.tif, backed up on R2 under
            cache/bake_soilgrids/ every 10 minutes and on exit). A band's raw
            tiles are deleted once its part is built (--keep-raw keeps them).
  pack      the 25 parts as one COG (out/), 64 x 64 internal tiles, pixel
            interleaved, DEFLATE with a predictor, no overviews
  upload    to a content-versioned key (never overwrites; md5-skipped), verified by md5
  register  the key into shared/soilgrids.json

Run (R2 credentials in the env for the cache backup and the upload):
    python3 -u scripts/bake_soilgrids.py all --minutes 150
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pipeline  # noqa: E402
from pipeline import OutOfTime, cached, log, work_dir  # noqa: E402

ROOT = HERE.parent
SPEC_PATH = ROOT / 'shared' / 'soilgrids.json'
WORK = work_dir('soilgrids', 'SOILGRIDS_WORK')
CACHE_PREFIX = 'bake_soilgrids'
R2_PREFIX = 'soil/soilgrids'
BASENAME = 'SoilGrids_India_250m'
ISRIC = 'https://files.isric.org/soilgrids/latest/data'
IGH = '+proj=igh +datum=WGS84 +units=m +no_defs'
ISRIC_4326_TOP = 83.999167206   # the WRB grid's north edge (MostProbable.vrt)
FETCH_WORKERS = 6               # polite: a browser's worth of connections to ISRIC
SAMPLE_DEG = 0.1                # India-box sample spacing for picking tiles (a tile is ~1 degree)
EDGE_DEG = 0.01                 # denser along the box edge, so no edge tile is missed
GDAL_ENV = {'GDAL_CACHEMAX': '1024', 'GDAL_DISABLE_READDIR_ON_OPEN': 'EMPTY_DIR'}


# ── the band table (one place: shared/soilgrids.json) ────────────────────────

def load_spec(path: Path = SPEC_PATH) -> dict:
    return json.loads(path.read_text())


def bands(spec: dict) -> list[str]:
    """Band names in file order: every property at each depth, then the WRB class."""
    return [f'{p}_{d}_mean' for d in spec['depths'] for p in spec['properties']] + ['wrb_MostProbable']


def vrt_url(band: str) -> str:
    prop = band.split('_', 1)[0]
    name = band.split('_', 1)[1] if prop == 'wrb' else band
    return f'{ISRIC}/{prop}/{name}.vrt'


def india_window(grid: dict) -> dict:
    """India's bbox snapped to ISRIC's EPSG:4326 grid (origin -180, ISRIC_4326_TOP)."""
    res = grid['res_deg']
    xmin_lng, ymin_lat, xmax_lng, ymax_lat = grid['bbox']
    c0, c1 = round((xmin_lng + 180) / res), round((xmax_lng + 180) / res)
    r0, r1 = round((ISRIC_4326_TOP - ymax_lat) / res), round((ISRIC_4326_TOP - ymin_lat) / res)
    return {'xmin': -180 + c0 * res, 'xmax': -180 + c1 * res,
            'ymax': ISRIC_4326_TOP - r0 * res, 'ymin': ISRIC_4326_TOP - r1 * res,
            'cols': c1 - c0, 'rows': r1 - r0, 'res': res}


# ── which ISRIC tiles ────────────────────────────────────────────────────────

SOURCE_RE = re.compile(r'<ComplexSource>.*?</ComplexSource>', re.S)


def sources(vrt: str) -> list[tuple[str, tuple[float, float, float, float]]]:
    """[(relative tile path, (xOff, yOff, xSize, ySize))] for each source in a VRT."""
    out = []
    for m in SOURCE_RE.finditer(vrt):
        block = m.group(0)
        name = re.search(r'<SourceFilename[^>]*>([^<]+)</SourceFilename>', block).group(1)
        r = re.search(r'<DstRect xOff="([\d.]+)" yOff="([\d.]+)" xSize="([\d.]+)" ySize="([\d.]+)"', block)
        out.append((name, tuple(float(v) for v in r.groups())))
    return out


def tiles_touching(srcs, samples: list[tuple[float, float]], margin: int = 2) -> set[str]:
    """The tiles whose rect (grown by `margin` pixels) holds at least one sample pixel."""
    bucket = 512
    grid: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for x, y in samples:
        grid.setdefault((int(x // bucket), int(y // bucket)), []).append((x, y))
    keep = set()
    for name, (x0, y0, w, h) in srcs:
        lo_x, lo_y, hi_x, hi_y = x0 - margin, y0 - margin, x0 + w + margin, y0 + h + margin
        cells = ((bx, by) for bx in range(int(lo_x // bucket), int(hi_x // bucket) + 1)
                 for by in range(int(lo_y // bucket), int(hi_y // bucket) + 1))
        if any(lo_x <= x < hi_x and lo_y <= y < hi_y for c in cells for x, y in grid.get(c, ())):
            keep.add(name)
    return keep


def india_samples(grid: dict) -> list[tuple[float, float]]:
    """lng/lat points over India's box: a grid every SAMPLE_DEG plus its edge every EDGE_DEG."""
    x0, y0, x1, y1 = grid['bbox']
    pts = set()
    steps = lambda a, b, s: [a + i * s for i in range(int(round((b - a) / s)) + 1)]  # noqa: E731
    for x in steps(x0, x1, SAMPLE_DEG):
        for y in steps(y0, y1, SAMPLE_DEG):
            pts.add((round(x, 4), round(y, 4)))
    for t in steps(x0, x1, EDGE_DEG):
        pts.update({(round(t, 4), y0), (round(t, 4), y1)})
    for t in steps(y0, y1, EDGE_DEG):
        pts.update({(x0, round(t, 4)), (x1, round(t, 4))})
    return sorted(pts)


def vrt_geotransform(vrt: str) -> tuple[float, ...]:
    return tuple(float(v) for v in re.search(r'<GeoTransform>([^<]+)</GeoTransform>', vrt).group(1).split(','))


def sample_pixels(vrt: str, band: str, grid: dict) -> list[tuple[float, float]]:
    """The India samples as pixel coordinates of this VRT (projected to IGH for the properties)."""
    pts = india_samples(grid)
    if band.startswith('wrb_'):
        xy = pts
    else:
        text = '\n'.join(f'{x} {y}' for x, y in pts) + '\n'
        res = pipeline.run(['gdaltransform', '-s_srs', 'EPSG:4326', '-t_srs', IGH, '-output_xy'],
                           timeout=600, input=text.encode())
        xy = [tuple(float(v) for v in line.split()[:2]) for line in res.stdout.decode().splitlines() if line.strip()]
    ox, px, _, oy, _, py = vrt_geotransform(vrt)
    return [((x - ox) / px, (y - oy) / py) for x, y in xy]


def local_vrt(vrt: str, keep: set[str], raw_dir: Path) -> str:
    """The VRT with only the kept sources, each pointing at its fetched file."""
    def swap(m: re.Match) -> str:
        block = m.group(0)
        name = re.search(r'<SourceFilename[^>]*>([^<]+)</SourceFilename>', block).group(1)
        if name not in keep:
            return ''
        local = raw_dir / name.removeprefix('./')
        return re.sub(r'<SourceFilename[^>]*>[^<]+</SourceFilename>',
                      f'<SourceFilename relativeToVRT="0">{local}</SourceFilename>', block)
    out = SOURCE_RE.sub(swap, vrt)
    return re.sub(r'\n\s*\n', '\n', out)


def describe_bands(xml: str, names: list[str]) -> str:
    """A stacked VRT with each band's name as its Description (the COG keeps them)."""
    found = re.findall(r'<VRTRasterBand[^>]*band="(\d+)"[^>]*>', xml)
    if len(found) != len(names):
        raise ValueError(f'{len(found)} bands in the VRT, {len(names)} names')
    return re.sub(r'(<VRTRasterBand[^>]*band="(\d+)"[^>]*>)',
                  lambda m: f'{m.group(1)}\n    <Description>{names[int(m.group(2)) - 1]}</Description>', xml)


# ── fetching (kept-alive, polite, resumable by file) ─────────────────────────

_local = threading.local()


def _session():
    import requests
    if not hasattr(_local, 's'):
        _local.s = requests.Session()
        _local.s.headers['User-Agent'] = pipeline.USER_AGENT
    return _local.s


def fetch(url: str, dest: Path, tries: int = 6) -> int:
    """`url` to `dest` unless already there; the body must be Content-Length bytes."""
    if dest.exists():
        return dest.stat().st_size
    dest.parent.mkdir(parents=True, exist_ok=True)

    def once() -> int:
        r = _session().get(url, timeout=120)
        if r.status_code >= 400:
            raise OSError(f'HTTP {r.status_code}') if r.status_code >= 500 or r.status_code == 429 else \
                RuntimeError(f'{url}: HTTP {r.status_code}')
        want = r.headers.get('Content-Length')
        if want is not None and int(want) != len(r.content):
            raise OSError(f'short read {len(r.content)} of {want}')
        with pipeline.atomic_output(dest) as part:
            part.write_bytes(r.content)
        return len(r.content)
    return pipeline.with_retries(once, tries)


# ── steps ────────────────────────────────────────────────────────────────────

def part_path(work: Path, band: str) -> Path:
    return work / 'cache' / 'parts' / f'{band}.tif'


def build_band(work: Path, band: str, spec: dict, keep_raw: bool = False) -> Path:
    """One band warped to India's grid (cache/parts/<band>.tif), fetching what it needs."""
    out = part_path(work, band)
    if out.exists():
        return out
    t0 = time.monotonic()
    prop = band.split('_', 1)[0]
    raw = work / 'raw' / prop
    vrt_file = raw / Path(vrt_url(band)).name
    fetch(vrt_url(band), vrt_file)
    vrt = vrt_file.read_text()
    srcs = sources(vrt)
    keep = tiles_touching(srcs, sample_pixels(vrt, band, spec['grid']))
    todo = sorted(keep)
    log(f'  {band}: {len(todo)} of {len(srcs)} ISRIC tiles touch India')
    done, got = 0, 0
    with ThreadPoolExecutor(FETCH_WORKERS) as pool:
        for n in pool.map(lambda name: fetch(f'{ISRIC}/{prop}/{name.removeprefix("./")}',
                                             raw / name.removeprefix('./')), todo):
            done, got = done + 1, got + n
            if done % 100 == 0:
                log(f'    {band}: {done}/{len(todo)} tiles, {got / 1e6:,.0f} MB')
    local = raw / f'{band}.india.vrt'
    local.write_text(local_vrt(vrt, keep, raw))
    w = india_window(spec['grid'])
    nodata = str(spec['grid']['nodata'])

    def warp(part: Path) -> None:
        pipeline.run(['gdalwarp', '-q', '-overwrite', '-t_srs', 'EPSG:4326', '-r', 'near', '-ot', 'Int16',
                      '-te', *map(str, (w['xmin'], w['ymin'], w['xmax'], w['ymax'])), '-ts', str(w['cols']), str(w['rows']),
                      *(['-srcnodata', '255'] if prop == 'wrb' else []), '-dstnodata', nodata, '-wm', '1024',
                      '-co', 'TILED=YES', '-co', 'COMPRESS=DEFLATE', '-co', 'PREDICTOR=2', str(local), str(part)],
                     timeout=3600, env={**os.environ, **GDAL_ENV})
    cached(out, warp)
    if not keep_raw:
        for name in todo:
            (raw / name.removeprefix('./')).unlink(missing_ok=True)
    log(f'  {band}: part {out.stat().st_size / 1e6:,.1f} MB in {time.monotonic() - t0:,.0f} s')
    return out


def out_path(work: Path) -> Path:
    return work / 'out' / f'{BASENAME}.tif'


def pack(work: Path, spec: dict) -> Path:
    """The parts stacked into one COG; skipped when it exists and is newer than every part."""
    names = bands(spec)
    parts = [part_path(work, b) for b in names]
    out = out_path(work)
    if out.exists() and pipeline.is_fresh(out, *parts):
        log('  pack: up to date')
        return out
    out.unlink(missing_ok=True)
    stack = work / 'out' / f'{BASENAME}.stack.vrt'
    stack.parent.mkdir(parents=True, exist_ok=True)
    pipeline.run(['gdalbuildvrt', '-q', '-overwrite', '-separate', str(stack), *map(str, parts)], timeout=600)
    stack.write_text(describe_bands(stack.read_text(), names))
    t0 = time.monotonic()

    def translate(part: Path) -> None:
        pipeline.run(['gdal_translate', '-q', '-of', 'COG', '-co', f'BLOCKSIZE={spec["grid"]["block"]}',
                      '-co', 'COMPRESS=DEFLATE', '-co', 'PREDICTOR=YES', '-co', 'LEVEL=9', '-co', 'OVERVIEWS=NONE',
                      '-co', 'INTERLEAVE=PIXEL', '-co', 'BIGTIFF=IF_SAFER', '-co', 'NUM_THREADS=ALL_CPUS',
                      str(stack), str(part)], timeout=6 * 3600, env={**os.environ, **GDAL_ENV})
    cached(out, translate)
    log(f'  pack: {out.name} {out.stat().st_size / 1e6:,.1f} MB in {time.monotonic() - t0:,.0f} s')
    return out


def upload(work: Path) -> dict:
    """The COG to its content-versioned key (never overwritten), verified by md5."""
    local = out_path(work)
    s3 = pipeline.patient_r2_client()
    name = pipeline.versioned_names({'tif': local})['tif']
    key = f'{R2_PREFIX}/{name}'
    pipeline.r2_upload_retrying(s3, local, key, new_only=True)
    pipeline.r2_verify(s3, local, key)
    log(f'  verified s3://{pipeline.BUCKET}/{key}')
    return {'key': key, 'bytes': local.stat().st_size, 'md5': pipeline.file_md5(local)}


def register(spec_path: Path, file: dict) -> None:
    spec = json.loads(spec_path.read_text())
    if spec.get('file') == file:
        log('  register: shared/soilgrids.json already names this file')
        return
    spec['file'] = file
    spec_path.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + '\n')
    log(f'  register: shared/soilgrids.json -> {file["key"]}')


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['bands', 'pack', 'upload', 'register', 'all'])
    ap.add_argument('--minutes', type=float, default=150, help='own time limit; stops cleanly between bands')
    ap.add_argument('--only', help='comma-separated band names (testing)')
    ap.add_argument('--keep-raw', action='store_true')
    args = ap.parse_args(argv)
    spec = load_spec()
    deadline = pipeline.Deadline(args.minutes)
    try:
        if args.step in ('bands', 'all', 'pack'):
            with pipeline.cache_backup(WORK / 'cache', CACHE_PREFIX):
                if args.step in ('bands', 'all'):
                    todo = args.only.split(',') if args.only else bands(spec)
                    for i, band in enumerate(todo, 1):
                        deadline.check(f'band {band}')
                        log(f'[{i}/{len(todo)}] {band}')
                        build_band(WORK, band, spec, args.keep_raw)
                if args.step in ('all', 'pack') and not args.only:
                    deadline.check('pack')
                    pack(WORK, spec)
        if args.step in ('upload', 'all') and not args.only:
            deadline.check('upload')
            file = upload(WORK)
            (WORK / 'out' / 'upload.json').write_text(json.dumps(file, indent=2) + '\n')
        if args.step in ('register', 'all') and not args.only:
            register(SPEC_PATH, json.loads((WORK / 'out' / 'upload.json').read_text()))
    except OutOfTime as e:
        log(f'stopped: {e}; everything finished so far is cached, run again to continue')
        return 3
    except subprocess.CalledProcessError as e:
        log(f'failed: {e}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
