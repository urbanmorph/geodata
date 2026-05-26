"""
Pre-bake per-state files for every LGD admin layer in three formats
(parquet, geojson, kml). The viewer can then offer instant downloads
without spinning up DuckDB-WASM at runtime.

Outputs:
  data/extracts/<level>/<state_lgd_code>/<level>_<state_abbr>.<format>

Where:
  level = districts | subdistricts | blocks | villages
  state_lgd_code = 2-digit zero-padded LGD code (e.g. '01', '29')
  state_abbr = lowercase 2-letter abbreviation (ISO 3166-2:IN style,
               with two deviations to match scripts/extract_per_state.py:
               Odisha -> 'od', Chhattisgarh -> 'cg')

We skip the states layer (one feature per "state" — full parquet is ~7 MB
and not worth per-state baking).

Idempotency: if the output file already exists with non-zero size, we skip
it. This matches the rule used in scripts/upload_r2.sh.

GeoJSON path: we try duckdb-spatial's GDAL GeoJSON writer first; if that's
unavailable in this Python build we fall back to building the
FeatureCollection JSON manually from ST_AsGeoJSON(geometry) rows.

KML path: pure-Python translator mirroring web/src/db.ts's
geoJSONFeaturesToKML. Reads the just-written geojson, escapes XML, wraps
Polygon/MultiPolygon/Point/LineString/MultiLineString/GeometryCollection.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = ROOT / "sources" / "india-geodata"
OUT = ROOT / "data" / "extracts"


# Per-state LGD abbreviations. Mostly ISO 3166-2:IN, with two deviations
# (od, cg) to stay consistent with scripts/extract_per_state.py's outputs.
STATE_ABBR: dict[int, str] = {
    1: "jk",   # Jammu & Kashmir
    2: "hp",   # Himachal Pradesh
    3: "pb",   # Punjab
    4: "ch",   # Chandigarh
    5: "uk",   # Uttarakhand
    6: "hr",   # Haryana
    7: "dl",   # Delhi
    8: "rj",   # Rajasthan
    9: "up",   # Uttar Pradesh
    10: "br",  # Bihar
    11: "sk",  # Sikkim
    12: "ar",  # Arunachal Pradesh
    13: "nl",  # Nagaland
    14: "mn",  # Manipur
    15: "mz",  # Mizoram
    16: "tr",  # Tripura
    17: "ml",  # Meghalaya
    18: "as",  # Assam
    19: "wb",  # West Bengal
    20: "jh",  # Jharkhand
    21: "od",  # Odisha   (deviation from ISO 'or' to match extract_per_state.py)
    22: "cg",  # Chhattisgarh (deviation from ISO 'ct' to match extract_per_state.py)
    23: "mp",  # Madhya Pradesh
    24: "gj",  # Gujarat
    27: "mh",  # Maharashtra
    28: "ap",  # Andhra Pradesh
    29: "ka",  # Karnataka
    30: "ga",  # Goa
    31: "ld",  # Lakshadweep
    32: "kl",  # Kerala
    33: "tn",  # Tamil Nadu
    34: "py",  # Puducherry
    35: "an",  # Andaman & Nicobar
    36: "tg",  # Telangana
    37: "la",  # Ladakh
    38: "dh",  # Dadra, Nagar Haveli, Daman & Diu
}


# (level_dir_name, parquet_filename, state_code_column)
LAYERS: list[tuple[str, str, str]] = [
    ("districts",    "LGD_Districts.parquet",    "state_lgd"),
    ("subdistricts", "LGD_Subdistricts.parquet", "state_lgd"),
    ("blocks",       "LGD_Blocks.parquet",       "state_lgd"),
    ("villages",     "LGD_Villages.parquet",     "state_lgd"),
]


FORMATS = ("parquet", "geojson", "kml")


# ---------------------------------------------------------------------------
# DuckDB connection
# ---------------------------------------------------------------------------

def make_con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    return con


def gdal_geojson_available(con: duckdb.DuckDBPyConnection) -> bool:
    """Return True if duckdb-spatial can write GeoJSON via the GDAL driver."""
    try:
        rows = con.execute(
            "SELECT 1 FROM ST_Drivers() "
            "WHERE short_name = 'GeoJSON' AND can_create = true"
        ).fetchall()
        return bool(rows)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# State-having-data discovery (e.g. villages only covers 27 states)
# ---------------------------------------------------------------------------

def states_with_data(con: duckdb.DuckDBPyConnection, parquet: Path, col: str) -> set[int]:
    rows = con.execute(
        f"SELECT DISTINCT CAST({col} AS INTEGER) FROM '{parquet.as_posix()}' "
        f"WHERE {col} IS NOT NULL"
    ).fetchall()
    return {int(r[0]) for r in rows if r[0] is not None}


# ---------------------------------------------------------------------------
# Format writers
# ---------------------------------------------------------------------------

def write_parquet(con: duckdb.DuckDBPyConnection, src: Path, col: str,
                  code: int, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    con.execute(
        f"COPY (SELECT * FROM '{src.as_posix()}' WHERE {col} = {code}) "
        f"TO '{out.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    )


def write_geojson_gdal(con: duckdb.DuckDBPyConnection, src: Path, col: str,
                       code: int, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    # The GDAL GeoJSON writer reads from the `geometry` column. Reorder so
    # geometry is last (matches scripts/extract_per_state.py convention).
    con.execute(
        f"COPY (SELECT * EXCLUDE geometry, geometry FROM '{src.as_posix()}' "
        f"WHERE {col} = {code}) TO '{out.as_posix()}' "
        f"WITH (FORMAT GDAL, DRIVER 'GeoJSON', LAYER_CREATION_OPTIONS 'RFC7946=YES')"
    )


def write_geojson_manual(con: duckdb.DuckDBPyConnection, src: Path, col: str,
                         code: int, out: Path) -> None:
    """Fallback when GDAL GeoJSON driver isn't available — build the
    FeatureCollection by selecting ST_AsGeoJSON(geometry) per row.
    """
    out.parent.mkdir(parents=True, exist_ok=True)

    # Get all non-geometry columns
    schema = con.execute(
        f"DESCRIBE SELECT * FROM '{src.as_posix()}' LIMIT 0"
    ).fetchall()
    prop_cols = [r[0] for r in schema if r[0] != "geometry"]

    select_props = ", ".join(f'"{c}"' for c in prop_cols)
    rows = con.execute(
        f"SELECT ST_AsGeoJSON(geometry) AS _geom, {select_props} "
        f"FROM '{src.as_posix()}' WHERE {col} = {code}"
    ).fetchall()

    with out.open("w", encoding="utf-8") as f:
        f.write('{"type":"FeatureCollection","features":[')
        first = True
        for r in rows:
            geom_str = r[0]
            if geom_str is None:
                continue
            props = {prop_cols[i]: r[i + 1] for i in range(len(prop_cols))}
            # Drop nulls to keep file small + match GDAL behaviour roughly.
            props = {k: v for k, v in props.items() if v is not None}
            feat = {
                "type": "Feature",
                "geometry": json.loads(geom_str),
                "properties": props,
            }
            if not first:
                f.write(",")
            f.write(json.dumps(feat, ensure_ascii=False, default=str))
            first = False
        f.write("]}")


# ---------------------------------------------------------------------------
# GeoJSON -> KML (mirrors web/src/db.ts geoJSONFeaturesToKML)
# Keep in sync with web/src/db.ts KML section
# ---------------------------------------------------------------------------

NAME_KEYS = (
    "vilname11", "vilnam_soi", "vname",    # village
    "blkname11", "blkname", "block_name",  # block
    "sdtname", "subdt_name",               # sub-district
    "dtname",                              # district
    "stname", "STNAME",                    # state
    "NAME", "name",                        # generic fallback
)


def esc_xml(s: str) -> str:
    return (s.replace("&", "&amp;")
             .replace("<", "&lt;")
             .replace(">", "&gt;")
             .replace('"', "&quot;")
             .replace("'", "&apos;"))


def _coord_pair(c) -> str:
    return f"{c[0]},{c[1]}"


def _ring(r) -> str:
    coords = " ".join(_coord_pair(p) for p in r)
    return f"<LinearRing><coordinates>{coords}</coordinates></LinearRing>"


def _polygon(p) -> str:
    outer = p[0]
    inners = p[1:]
    inner_xml = "".join(
        f"<innerBoundaryIs>{_ring(i)}</innerBoundaryIs>" for i in inners
    )
    return (
        f"<Polygon><outerBoundaryIs>{_ring(outer)}</outerBoundaryIs>"
        f"{inner_xml}</Polygon>"
    )


def geometry_to_kml(g) -> str:
    if not g or not isinstance(g, dict) or "type" not in g:
        return ""
    t = g["type"]
    if t == "Point":
        return f"<Point><coordinates>{_coord_pair(g['coordinates'])}</coordinates></Point>"
    if t == "LineString":
        coords = " ".join(_coord_pair(p) for p in g["coordinates"])
        return f"<LineString><coordinates>{coords}</coordinates></LineString>"
    if t == "Polygon":
        return _polygon(g["coordinates"])
    if t == "MultiPolygon":
        inner = "".join(_polygon(p) for p in g["coordinates"])
        return f"<MultiGeometry>{inner}</MultiGeometry>"
    if t == "MultiLineString":
        parts = []
        for line in g["coordinates"]:
            coords = " ".join(_coord_pair(p) for p in line)
            parts.append(f"<LineString><coordinates>{coords}</coordinates></LineString>")
        return f"<MultiGeometry>{''.join(parts)}</MultiGeometry>"
    if t == "GeometryCollection":
        inner = "".join(geometry_to_kml(sub) for sub in g.get("geometries", []))
        return f"<MultiGeometry>{inner}</MultiGeometry>"
    return ""


def feature_to_placemark(feat: dict) -> str:
    props = feat.get("properties") or {}
    name_val = ""
    for k in NAME_KEYS:
        if props.get(k) is not None:
            name_val = str(props[k])
            break

    parts = []
    for k, v in props.items():
        if v is None or v == "":
            continue
        parts.append(
            f'<Data name="{esc_xml(str(k))}"><value>{esc_xml(str(v))}</value></Data>'
        )
    ext_data = "".join(parts)

    geom_xml = geometry_to_kml(feat.get("geometry"))
    return (
        f"<Placemark><name>{esc_xml(name_val)}</name>"
        f"<ExtendedData>{ext_data}</ExtendedData>{geom_xml}</Placemark>"
    )


def write_kml_from_geojson(geojson_path: Path, layer_name: str, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with geojson_path.open("r", encoding="utf-8") as f:
        fc = json.load(f)
    feats = fc.get("features") or []

    with out.open("w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        f.write('<kml xmlns="http://www.opengis.net/kml/2.2">\n')
        f.write(f"<Document><name>{esc_xml(layer_name)}</name>")
        for feat in feats:
            f.write(feature_to_placemark(feat))
        f.write("</Document>\n</kml>\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def should_skip(out: Path) -> bool:
    """Idempotency rule (matches scripts/upload_r2.sh): skip if the file
    exists at non-zero size."""
    try:
        return out.stat().st_size > 0
    except FileNotFoundError:
        return False


def main() -> int:
    con = make_con()
    gdal_ok = gdal_geojson_available(con)
    print(f"GDAL GeoJSON writer available: {gdal_ok}")

    OUT.mkdir(parents=True, exist_ok=True)

    written = 0
    skipped = 0
    errors: list[str] = []
    started = time.time()

    for level, parquet_name, col in LAYERS:
        src = SRC / parquet_name
        if not src.exists():
            msg = f"missing source: {src} — run scripts/fetch.sh first"
            print(msg)
            errors.append(msg)
            continue

        # Only generate per-state files for states that actually have rows in
        # this layer (villages only covers 27 states; some UTs may also be
        # absent in other layers).
        present = states_with_data(con, src, col)
        codes = sorted(c for c in STATE_ABBR if c in present)
        missing_in_layer = sorted(c for c in STATE_ABBR if c not in present)
        if missing_in_layer:
            print(
                f"level={level} skipping {len(missing_in_layer)} state(s) "
                f"with no rows: {missing_in_layer}"
            )

        for code in codes:
            abbr = STATE_ABBR[code]
            code_dir = f"{code:02d}"
            stem = f"{level}_{abbr}"
            base = OUT / level / code_dir
            base.mkdir(parents=True, exist_ok=True)

            paths = {fmt: base / f"{stem}.{fmt}" for fmt in FORMATS}

            # parquet
            out = paths["parquet"]
            if should_skip(out):
                skipped += 1
                print(f"skip  level={level} state={abbr} fmt=parquet size={out.stat().st_size}")
            else:
                try:
                    write_parquet(con, src, col, code, out)
                    sz = out.stat().st_size
                    written += 1
                    print(f"level={level} state={abbr} fmt=parquet size={sz}")
                except Exception as e:
                    msg = f"parquet failed level={level} state={abbr}: {e}"
                    print(msg, file=sys.stderr)
                    errors.append(msg)

            # geojson
            out = paths["geojson"]
            geojson_path = out  # used by KML below
            if should_skip(out):
                skipped += 1
                print(f"skip  level={level} state={abbr} fmt=geojson size={out.stat().st_size}")
            else:
                try:
                    if gdal_ok:
                        write_geojson_gdal(con, src, col, code, out)
                    else:
                        write_geojson_manual(con, src, col, code, out)
                    sz = out.stat().st_size
                    written += 1
                    print(f"level={level} state={abbr} fmt=geojson size={sz}")
                except Exception as e:
                    msg = f"geojson failed level={level} state={abbr}: {e}"
                    print(msg, file=sys.stderr)
                    errors.append(msg)

            # kml — depends on geojson being present
            out = paths["kml"]
            if should_skip(out):
                skipped += 1
                print(f"skip  level={level} state={abbr} fmt=kml size={out.stat().st_size}")
            else:
                if not geojson_path.exists() or geojson_path.stat().st_size == 0:
                    msg = f"kml failed level={level} state={abbr}: no geojson source"
                    print(msg, file=sys.stderr)
                    errors.append(msg)
                else:
                    try:
                        write_kml_from_geojson(geojson_path, f"{level}_{abbr}", out)
                        sz = out.stat().st_size
                        written += 1
                        print(f"level={level} state={abbr} fmt=kml size={sz}")
                    except Exception as e:
                        msg = f"kml failed level={level} state={abbr}: {e}"
                        print(msg, file=sys.stderr)
                        errors.append(msg)

    elapsed = time.time() - started
    print("")
    print("=" * 60)
    print(f"SUMMARY: wrote {written} files, skipped {skipped}, errors {len(errors)}")
    print(f"elapsed: {elapsed:.1f}s")
    print(f"output:  {OUT}")
    if errors:
        print("")
        print(f"errors ({len(errors)}):")
        for e in errors:
            print(f"  - {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
