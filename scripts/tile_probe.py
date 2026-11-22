"""Probe tiles: decode the tiles of a PMTiles file around a few points and
compare them with the parquet they were cut from (bake_land_water and
rebake_tiles gate publishing on it). tippecanoe can silently drop polygons
and leave holes; decoded tiles, not HTTP statuses, show it."""
from __future__ import annotations

import math
import sys
from collections.abc import Callable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import run  # noqa: E402


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


def tile_report(pm: Path, parquet: Path, con, points: list[tuple[float, float]], zooms: list[int],
                amount: Callable[[str, str, int], str], measured: bool = True) -> list[dict]:
    """Per probe tile (the tile holding each point at each of `zooms`, once
    each): decoded features vs parquet features meeting the tile, and the
    share of the parquet's `amount` inside the tile (amount(col, envelope SQL,
    z) is the SQL of what `col` covers there) that the decoded features
    cover; with measured=False (points) only the counts are compared."""
    tmp = pm.with_name(f'{pm.stem}.decoded.geojson')
    rows, seen = [], set()
    for lon, lat in points:
        for z in zooms:
            x, y = tile_for(lon, lat, z)
            if (z, x, y) in seen:  # probes close together share their low-zoom tiles
                continue
            seen.add((z, x, y))
            w, s, e, n = tile_bounds(z, x, y)
            env = f'ST_MakeEnvelope({w}, {s}, {e}, {n})'
            # bbox first (cheap), then the geometry: a big irregular polygon's
            # bbox meets many tiles the polygon does not.
            expect, want = con.execute(
                f"SELECT count(*), {amount('geometry', env, z)} FROM read_parquet('{parquet}') "
                f"WHERE xmax >= ? AND xmin <= ? AND ymax >= ? AND ymin <= ? AND ST_Intersects(geometry, {env})",
                [w, e, s, n]).fetchone()
            decoded = decode_tile(pm, z, x, y, tmp)
            got = con.execute(f"SELECT {amount('geom', env, z)} FROM ST_Read('{tmp}')").fetchone()[0] \
                if decoded and measured else 0
            rows.append({'z': z, 'x': x, 'y': y, 'decoded': decoded, 'parquet': expect,
                         'cover': round(got / want, 3) if want else None})
    tmp.unlink(missing_ok=True)
    return rows
