#!/usr/bin/env python3
"""Bake four layers into the home map's on-demand themes: web/public/map-themes.json.

The home page's India map (web/scripts/india-map.mjs) ships the outline and the
city-ward markers inline; these four themes are fetched the first time someone
switches to them:
  line  (rail, rivers):     snapped to a 0.01 degree grid, merged, simplified -> one path
  dense (schools, forests): binned into hexagons -> one path per shade, 4 shades by rank

Coordinates use the share-card frame of functions/lib/og-india-path.ts, so the
themes line up with that outline (tests/india-map.test.ts checks the bounds).

Each theme is cached in data/map-themes/<name>.json as soon as it is built; a rerun
skips finished themes and rewrites the output only if its bytes change. Delete a
cache file to rebuild that theme. Files that can't be range-read are downloaded
once to the same folder.

    python3 scripts/build_map_themes.py [theme ...]
"""

import gzip
import itertools
import json
import math
import sys
import time
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
R2 = pipeline.R2_PUBLIC + "/"
CACHE = ROOT / "data" / "map-themes"
OUT = ROOT / "web" / "public" / "map-themes.json"
SHADES = 4
HEX_R = 7

# The share-card frame (scripts/gen_og_image.py history; web/scripts/india-map.mjs).
SCALE = 480 / 32.5
X0 = 90 + (460 - 31 * SCALE) / 2
Y0 = 75


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def proj(lon, lat):
    return X0 + (lon - 67.5) * SCALE, Y0 + (38 - lat) * SCALE


def x_sql(lon):
    return f"({X0} + ({lon} - 67.5) * {SCALE})"


def y_sql(lat):
    return f"({Y0} + (38 - {lat}) * {SCALE})"


def write_atomic(path, data):
    """Write via a temp file and rename, so a killed run never leaves a half file."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def source(key, local=False):
    """A parquet path DuckDB can read: remote, or downloaded once when range reads fail."""
    if not local:
        return R2 + key
    f = CACHE / Path(key).name
    if not f.exists():
        log("downloading", key)
        pipeline.download(R2 + key, f)
    return str(f)


def line_theme(con, sql_from, tolerance, min_len):
    """Snap so touching sections join, merge, simplify; one path of parts >= min_len px."""
    (gj,) = con.execute(
        "SELECT ST_AsGeoJSON(ST_Simplify(ST_LineMerge(ST_Union_Agg(ST_ReducePrecision(geometry, 0.01))),"
        f" {tolerance})) {sql_from}"
    ).fetchone()
    g = json.loads(gj)
    lines = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
    parts = []
    for line in lines:
        pts = [proj(x, y) for x, y in line]
        if sum(math.dist(a, b) for a, b in itertools.pairwise(pts)) < min_len:
            continue
        rounded = [(round(x), round(y)) for x, y in pts]
        kept = [p for i, p in enumerate(rounded) if i == 0 or p != rounded[i - 1]]
        if len(kept) >= 2:
            parts.append("M" + " ".join(f"{x} {y}" for x, y in kept))
    return {"kind": "line", "paths": ["".join(parts)]}


def dense_theme(con, sql_xyw):
    """Bin weighted points into pointy hexagons; one relative-command path per shade.

    Shades are quarters of the ranked bins, so one dense city doesn't wash out the rest."""
    w, h = math.sqrt(3) * HEX_R, 1.5 * HEX_R
    bins = {}
    for x, y, wt in con.execute(sql_xyw).fetchall():
        row = round(y / h)
        col = round((x - (row % 2) * w / 2) / w)
        bins[col, row] = bins.get((col, row), 0) + wt
    a, b = round(w / 2 * 0.9, 1), round(HEX_R / 2 * 0.9, 1)
    hexagon = f"l{a} {b}v{2 * b}l-{a} {b}l-{a} -{b}v-{2 * b}z"  # from the top vertex
    shades = [[] for _ in range(SHADES)]
    for i, (col, row) in enumerate(sorted(bins, key=bins.get)):
        cx, cy = col * w + (row % 2) * w / 2, row * h - HEX_R * 0.9
        shades[i * SHADES // len(bins)].append(f"M{cx:.0f} {cy:.0f}{hexagon}")
    log("hexagons", len(bins))
    return {"kind": "dense", "paths": ["".join(s) for s in shades]}


def rivers(con):
    """The 40 longest named rivers, by total length of their segments."""
    f = source("water/rivers/WRIS_Rivers.parquet", local=True)
    return line_theme(
        con,
        f"""FROM read_parquet('{f}') WHERE rivname IN (SELECT rivname FROM read_parquet('{f}')
            WHERE rivname <> '' GROUP BY 1 ORDER BY sum(ST_Length(geometry)) DESC LIMIT 40)""",
        0.04,
        4,
    )


THEMES = {
    "rail": lambda con: line_theme(
        con,
        f"FROM read_parquet('{source('transport/ir-tracks/IR_Tracks.parquet')}')",
        0.04,
        3,
    ),
    "rivers": rivers,
    "schools": lambda con: dense_theme(
        con,
        f"""SELECT round({x_sql("longitude")}), round({y_sql("latitude")}), count(*)
        FROM read_parquet('{source("education/udise-schools/NCOG_UDISE_Schools.parquet")}')
        WHERE latitude BETWEEN 6 AND 38 AND longitude BETWEEN 67 AND 98 GROUP BY 1, 2""",
    ),
    "forests": lambda con: dense_theme(
        con,
        f"""SELECT round({x_sql("(xmin + xmax) / 2")}), round({y_sql("(ymin + ymax) / 2")}),
               sum((xmax - xmin) * (ymax - ymin))
        FROM read_parquet('{source("environment/forests/SOI_Forests.parquet")}') GROUP BY 1, 2""",
    ),
}


def main(only):
    CACHE.mkdir(parents=True, exist_ok=True)
    con = None
    for name, build in THEMES.items():
        f = CACHE / f"{name}.json"
        if f.exists() and not (only and name in only):
            continue
        if con is None:
            con = duckdb.connect()
            con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;")
        t = time.time()
        log(name, "building")
        write_atomic(f, json.dumps(build(con), separators=(",", ":")).encode())
        log(name, f"built in {time.time() - t:.0f}s")
    out = json.dumps(
        {name: json.loads((CACHE / f"{name}.json").read_text()) for name in THEMES},
        separators=(",", ":"),
    ).encode()
    if OUT.exists() and OUT.read_bytes() == out:
        log(OUT.name, "unchanged")
    else:
        write_atomic(OUT, out)
        log(
            OUT.name,
            f"{len(out) / 1024:.1f} KB, {len(gzip.compress(out, 9)) / 1024:.1f} KB gzipped",
        )


if __name__ == "__main__":
    main(set(sys.argv[1:]))
