"""
Bake whole-layer downloads (geojson, kml, shapefile.zip) for every curated
layer whose source parquet is at or under a size cap.

Motivation: the catalog card only exposed parquet + pmtiles. QGIS users
wanted whole-layer GeoJSON/KML/Shapefile without entering the viewer and
slicing by state. (Twitter @Kyangs_Thang: "Is there a way to download the
whole layer as GeoJSON/Shapefile/KML without filtering? That would help
since many people work on QGIS.")

Generic size rule: bake if source parquet ≤ WHOLE_LAYER_MAX_PARQUET_MB
(default 100). Anything bigger is gated to the viewer's per-state slices
since the whole-layer geojson/kml would be unwieldy (lgd_villages parquet
is 475 MB; its geojson would be ~1.4 GB, KML ~5 GB). Override via env
var to force-bake the giants if you really want to.

Idempotent: skips any output that already exists at non-zero size.
Reuses bake_extracts.py's writers (GDAL GeoJSON, pure-Python KML).
Shapefile uses ogr2ogr (GDAL/OGR command line); the output directory
is zipped into <basename>.shp.zip to ship a single file per layer.

Outputs:
  data/baked/<R2-path>/<basename>.geojson
  data/baked/<R2-path>/<basename>.kml
  data/baked/<R2-path>/<basename>.shp.zip

Run after fetch.sh; before build_catalog.py + upload_r2.sh.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

# Reuse the layer manifest + helpers from build_catalog so this script
# stays in sync. build_catalog's module body only defines constants and
# the LAYERS list at import time; its main entrypoint is gated below.
import build_catalog as bc  # noqa: E402
from bake_extracts import (  # noqa: E402
    make_con,
    gdal_geojson_available,
    write_geojson_manual,
    write_kml_from_geojson,
)

OUT = ROOT / "data" / "baked"
SRC = ROOT / "sources" / "india-geodata"

# Reference layers: assets not in the LAYERS tuple but worth exposing as
# downloadables. (id, source-file path, R2 prefix, basename, label, level,
# rows, licence, attribution-source-key, notes)
#
# India national boundary is derived from LGD_States.parquet (dissolve
# union → single India MultiPolygon). Authoritative since LGD is India's
# own admin source; India-correct by construction. The same osm-in line
# file still drives the Bharatlas Minimal basemap; this download is for
# QGIS users who want a single closed shape of the country.
REFERENCE_INDIA_BOUNDARY_SRC = ROOT / "sources" / "india-geodata" / "LGD_States.parquet"
REFERENCE_INDIA_BOUNDARY_R2_PREFIX = "reference"
REFERENCE_INDIA_BOUNDARY_BASENAME = "india_boundary"

MAX_PARQUET_MB = float(os.environ.get("WHOLE_LAYER_MAX_PARQUET_MB", "100"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def file_size(p: Path) -> int:
    try:
        return p.stat().st_size
    except FileNotFoundError:
        return 0


def should_skip(out: Path) -> bool:
    return file_size(out) > 0


def have_ogr2ogr() -> bool:
    return shutil.which("ogr2ogr") is not None


def out_paths(r2_prefix: str, basename: str) -> dict[str, Path]:
    """Where each output lives on disk. R2 upload mirrors this layout."""
    base = OUT / r2_prefix
    return {
        "geojson": base / f"{basename}.geojson",
        "kml": base / f"{basename}.kml",
        "shapefile": base / f"{basename}.shp.zip",
    }


# ---------------------------------------------------------------------------
# Format writers (reuse + extend bake_extracts)
# ---------------------------------------------------------------------------

def _detect_geom_col(
    con: duckdb.DuckDBPyConnection, parquet: Path
) -> str:
    """Detect the geometry column name in a parquet file. Some upstream
    sources use 'geometry', others use 'geom' (e.g. bharatviz_pincodes).
    Falls back to 'geometry' if detection fails."""
    try:
        schema = con.execute(
            f"SELECT column_name, column_type FROM "
            f"(DESCRIBE SELECT * FROM '{parquet.as_posix()}' LIMIT 0) "
            f"WHERE column_type ILIKE '%GEOMETRY%'"
        ).fetchall()
        if schema:
            return schema[0][0]
    except Exception:
        pass
    return "geometry"


def write_geojson_whole(
    con: duckdb.DuckDBPyConnection, parquet: Path, out: Path, gdal_ok: bool
) -> None:
    """Whole-layer geojson — no WHERE filter. Mirrors bake_extracts's
    GDAL path, with the manual fallback for non-spatial builds."""
    out.parent.mkdir(parents=True, exist_ok=True)
    geom_col = _detect_geom_col(con, parquet)
    if gdal_ok:
        con.execute(
            f"COPY (SELECT * EXCLUDE \"{geom_col}\", \"{geom_col}\" FROM '{parquet.as_posix()}') "
            f"TO '{out.as_posix()}' "
            f"WITH (FORMAT GDAL, DRIVER 'GeoJSON', LAYER_CREATION_OPTIONS 'RFC7946=YES')"
        )
    else:
        # Reuse the manual writer's logic but without the state filter.
        # write_geojson_manual takes (con, src, col, code, out) — we don't
        # have a column filter here, so inline a no-WHERE variant.
        schema = con.execute(
            f"DESCRIBE SELECT * FROM '{parquet.as_posix()}' LIMIT 0"
        ).fetchall()
        prop_cols = [r[0] for r in schema if r[0] != geom_col]
        select_props = ", ".join(f'"{c}"' for c in prop_cols)
        rows = con.execute(
            f"SELECT ST_AsGeoJSON(\"{geom_col}\") AS _geom, {select_props} "
            f"FROM '{parquet.as_posix()}'"
        ).fetchall()
        with out.open("w", encoding="utf-8") as f:
            f.write('{"type":"FeatureCollection","features":[')
            first = True
            for r in rows:
                geom_str = r[0]
                if geom_str is None:
                    continue
                props = {prop_cols[i]: r[i + 1] for i in range(len(prop_cols))}
                props = {k: v for k, v in props.items() if v is not None}
                feat = {"type": "Feature", "geometry": json.loads(geom_str), "properties": props}
                if not first:
                    f.write(",")
                f.write(json.dumps(feat, ensure_ascii=False, default=str))
                first = False
            f.write("]}")


def build_india_polygon_geojson(parquet_src: Path, out: Path) -> None:
    """Dissolve LGD's 36 state polygons into a single India MultiPolygon.

    Earlier draft tried to polygonize osm-in's 137 LineStrings after
    filtering disputed-by-IN segments — but the remaining lines don't
    close into rings (4 unclosed MultiLineStrings, 0 polygons). Switching
    to ST_Union over LGD states gives an authoritative India-correct
    shape (LGD is India's own source for admin boundaries, so the union
    naturally includes Aksai Chin + Arunachal Pradesh) with no topology
    games. Output: one Feature with a single MultiPolygon geometry.
    """
    import duckdb
    out.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    row = con.execute(
        f"SELECT ST_AsGeoJSON(ST_Union_Agg(geometry)) AS gj, COUNT(*) AS n "
        f"FROM '{parquet_src.as_posix()}'"
    ).fetchone()
    if not row or not row[0]:
        raise RuntimeError(f"ST_Union over {parquet_src} returned empty")
    geometry = json.loads(row[0])
    n_states = int(row[1])
    feature = {
        "type": "Feature",
        "properties": {
            "name": "India",
            "country_code": "IN",
            "source": "LGD (Local Government Directory)",
            "note": f"India's national boundary. Dissolved from {n_states} LGD state + UT polygons. India-correct by construction (LGD is India's authoritative admin source).",
        },
        "geometry": geometry,
    }
    fc_out = {"type": "FeatureCollection", "features": [feature]}
    with out.open("w", encoding="utf-8") as f:
        json.dump(fc_out, f, ensure_ascii=False, separators=(",", ":"))


def write_shapefile_zip(geojson_path: Path, basename: str, out: Path) -> None:
    """Convert geojson → ESRI Shapefile (5-file set) → single .zip via
    ogr2ogr. Shapefiles can't ship as one file (they're .shp/.shx/.dbf/
    .prj/.cpg), so we zip the directory and present that as the download."""
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="shp_") as tmp:
        tmp_dir = Path(tmp)
        # ogr2ogr writes into a directory; the shapefile basename matches
        # the geojson basename for tool-friendly filenames after unzip.
        subprocess.run(
            [
                "ogr2ogr",
                "-f", "ESRI Shapefile",
                "-nlt", "PROMOTE_TO_MULTI",
                str(tmp_dir / f"{basename}.shp"),
                str(geojson_path),
                # Shapefile column names cap at 10 chars; -lco preserves
                # what we can without truncation surprises.
                "-lco", "ENCODING=UTF-8",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(tmp_dir.iterdir()):
                zf.write(f, arcname=f.name)


# ---------------------------------------------------------------------------
# Layer iteration
# ---------------------------------------------------------------------------

def curated_layers() -> list[tuple[str, str, str, int]]:
    """(layer_id, source_parquet_path, r2_prefix, basename_without_ext)
    for every curated layer that has a local parquet on disk. Reads from
    build_catalog.LAYERS first, then supplements with any catalog.json
    layers that have a parquet URL but are missing from LAYERS (e.g.
    externally-ingested city ward layers from OpenCity)."""
    out = []
    seen_ids: set[str] = set()
    for id_, level, source, parquet, pmtiles, rows, licence, notes in bc.LAYERS:
        parquet_path = SRC / parquet
        if not parquet_path.exists():
            continue
        path = bc.LEVELS[level]["path"]
        basename = parquet_path.stem
        out.append((id_, str(parquet_path), path, basename))
        seen_ids.add(id_)

    # Supplement from catalog.json: externally-ingested layers (city wards
    # etc.) are appended dynamically in build_catalog and appear in
    # catalog.json but not in the hardcoded bc.LAYERS tuple at import time.
    catalog_path = ROOT / "web" / "public" / "catalog.json"
    r2_base = bc.R2 + "/"
    if catalog_path.exists():
        try:
            catalog = json.loads(catalog_path.read_text())
            for layer in catalog.get("layers", []):
                lid = layer.get("id")
                if not lid or lid in seen_ids:
                    continue
                pq = layer.get("parquet")
                if not pq or not pq.get("url"):
                    continue
                url: str = pq["url"]
                # Derive R2 prefix and basename from the URL path.
                # URL example: https://pub-...r2.dev/admin/wards-chennai/wards_chennai.parquet
                if url.startswith(r2_base):
                    rel = url[len(r2_base):]  # "admin/wards-chennai/wards_chennai.parquet"
                else:
                    continue
                basename = Path(rel).stem  # "wards_chennai"
                r2_prefix = str(Path(rel).parent)  # "admin/wards-chennai"
                parquet_path = SRC / Path(rel).name  # sources/india-geodata/wards_chennai.parquet
                if not parquet_path.exists():
                    continue
                out.append((lid, str(parquet_path), r2_prefix, basename))
                seen_ids.add(lid)
        except Exception as e:
            print(f"WARN  catalog.json read failed, external layers skipped: {e}")

    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def bake_one(
    con: duckdb.DuckDBPyConnection,
    label: str,
    parquet_path: Path,
    r2_prefix: str,
    basename: str,
    gdal_ok: bool,
    ogr2ogr_ok: bool,
) -> tuple[int, int, list[str]]:
    """Bake geojson + kml + shapefile.zip for one source parquet.
    Returns (written, skipped, errors)."""
    paths = out_paths(r2_prefix, basename)
    written = 0
    skipped = 0
    errors: list[str] = []

    # geojson
    if should_skip(paths["geojson"]):
        print(f"skip  {label} fmt=geojson size={file_size(paths['geojson'])}")
        skipped += 1
    else:
        try:
            write_geojson_whole(con, parquet_path, paths["geojson"], gdal_ok)
            written += 1
            print(f"wrote {label} fmt=geojson size={file_size(paths['geojson'])}")
        except Exception as e:
            errors.append(f"{label} geojson: {e}")
            print(f"FAIL  {label} fmt=geojson err={e}")
            return written, skipped, errors

    # kml (depends on geojson)
    if should_skip(paths["kml"]):
        print(f"skip  {label} fmt=kml size={file_size(paths['kml'])}")
        skipped += 1
    else:
        try:
            write_kml_from_geojson(paths["geojson"], basename, paths["kml"])
            written += 1
            print(f"wrote {label} fmt=kml size={file_size(paths['kml'])}")
        except Exception as e:
            errors.append(f"{label} kml: {e}")
            print(f"FAIL  {label} fmt=kml err={e}")

    # shapefile (depends on geojson + ogr2ogr)
    if should_skip(paths["shapefile"]):
        print(f"skip  {label} fmt=shp.zip size={file_size(paths['shapefile'])}")
        skipped += 1
    elif not ogr2ogr_ok:
        print(f"skip  {label} fmt=shp.zip (ogr2ogr not found)")
        skipped += 1
    else:
        try:
            write_shapefile_zip(paths["geojson"], basename, paths["shapefile"])
            written += 1
            print(f"wrote {label} fmt=shp.zip size={file_size(paths['shapefile'])}")
        except subprocess.CalledProcessError as e:
            stderr = (e.stderr or b"").decode("utf-8", "replace").strip()
            errors.append(f"{label} shapefile: {stderr}")
            print(f"FAIL  {label} fmt=shp.zip err={stderr}")
        except Exception as e:
            errors.append(f"{label} shapefile: {e}")
            print(f"FAIL  {label} fmt=shp.zip err={e}")

    return written, skipped, errors


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    con = make_con()
    gdal_ok = gdal_geojson_available(con)
    ogr2ogr_ok = have_ogr2ogr()
    print(f"GDAL GeoJSON writer: {gdal_ok}")
    print(f"ogr2ogr available:   {ogr2ogr_ok}")
    print(f"Size cap:            {MAX_PARQUET_MB} MB")
    print()

    total_w, total_s, errors = 0, 0, []
    started = time.time()

    # Curated parquet-backed layers
    cap_bytes = int(MAX_PARQUET_MB * 1024 * 1024)
    for layer_id, parquet_str, r2_prefix, basename in curated_layers():
        parquet_path = Path(parquet_str)
        size = file_size(parquet_path)
        if size > cap_bytes:
            mb = size / (1024 * 1024)
            print(
                f"GATE  {layer_id} parquet={mb:.0f}MB > {MAX_PARQUET_MB}MB cap — skipping bake "
                f"(use the viewer's per-state slices, or set WHOLE_LAYER_MAX_PARQUET_MB)"
            )
            continue
        w, s, e = bake_one(con, layer_id, parquet_path, r2_prefix, basename, gdal_ok, ogr2ogr_ok)
        total_w += w
        total_s += s
        errors.extend(e)

    # Reference: India national boundary (osm-in). The source file is 137
    # LineStrings — too thin to read against a basemap and ships the
    # disputed-by-IN segments India rejects. Stitch the claimed segments
    # into a closed MultiPolygon so the view page renders like every other
    # polygon layer (blue line + transparent fill) and downloads ship one
    # India-correct shape instead of a pile of borders.
    if REFERENCE_INDIA_BOUNDARY_SRC.exists():
        paths = out_paths(REFERENCE_INDIA_BOUNDARY_R2_PREFIX, REFERENCE_INDIA_BOUNDARY_BASENAME)
        if not should_skip(paths["geojson"]):
            try:
                build_india_polygon_geojson(REFERENCE_INDIA_BOUNDARY_SRC, paths["geojson"])
                print(f"wrote india_boundary fmt=geojson (polygon stitched) size={file_size(paths['geojson'])}")
                total_w += 1
            except Exception as e:
                errors.append(f"india_boundary geojson: {e}")
                print(f"FAIL  india_boundary fmt=geojson err={e}")
        else:
            print(f"skip  india_boundary fmt=geojson size={file_size(paths['geojson'])}")
            total_s += 1

        if not should_skip(paths["kml"]):
            try:
                write_kml_from_geojson(paths["geojson"], "India boundary", paths["kml"])
                total_w += 1
                print(f"wrote india_boundary fmt=kml size={file_size(paths['kml'])}")
            except Exception as e:
                errors.append(f"india_boundary kml: {e}")

        if not should_skip(paths["shapefile"]) and ogr2ogr_ok:
            try:
                write_shapefile_zip(paths["geojson"], REFERENCE_INDIA_BOUNDARY_BASENAME, paths["shapefile"])
                total_w += 1
                print(f"wrote india_boundary fmt=shp.zip size={file_size(paths['shapefile'])}")
            except Exception as e:
                errors.append(f"india_boundary shapefile: {e}")
        elif not ogr2ogr_ok:
            print("skip  india_boundary fmt=shp.zip (ogr2ogr not found)")
            total_s += 1
    else:
        print(f"WARN  india boundary source not found at {REFERENCE_INDIA_BOUNDARY_SRC}")

    elapsed = time.time() - started
    print()
    print(f"=== bake summary: wrote={total_w} skipped={total_s} errors={len(errors)} elapsed={elapsed:.1f}s ===")
    for e in errors:
        print(f"  - {e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
