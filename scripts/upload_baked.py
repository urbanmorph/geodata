"""
Upload data/baked/* to R2 via the S3-compatible API (pipeline.r2_upload).

Idempotent: skips each object whose md5 matches the local file (sizes alone
miss a lat,lon swap). pipeline.r2_upload also sets Content-Type and
Content-Disposition (attachment, so cross-origin links to the bucket (data.bharatlas.com, pub-*.r2.dev)
download; pmtiles stays inline) and uploads large files in parts.

Env required:
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY  (S3-compat creds)
  CLOUDFLARE_ACCOUNT_ID                   (endpoint host prefix)

    python3 scripts/upload_baked.py            # data/baked + catalog-mapped sources
    ... | python3 scripts/upload_baked.py --pairs
        # "<local path><TAB><key>" lines on stdin (what scripts/upload_r2.sh sends)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from pipeline import R2_PUBLIC as _R2_BASE  # noqa: E402
from pipeline import r2_client, r2_upload  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BAKED = ROOT / "data" / "baked"


def collect_local_files() -> list[tuple[Path, str, int]]:
    """Build (path, r2_key, size) tuples for everything we want to mirror.

    Two trees:
      data/baked/<r2_prefix>/<file>  →  <r2_prefix>/<file>      (mirror)
      sources/india-geodata/<file>   →  R2 key derived from catalog.json's
                                        per-layer URL fields. Mapping lives
                                        in catalog.json so build_catalog.py
                                        is the single source of truth (no
                                        duplicate filename→prefix table).
    """
    import json
    out: list[tuple[Path, str, int]] = []

    # Tree 1: baked whole-layer downloads.
    if BAKED.exists():
        for f in sorted(BAKED.rglob("*")):
            if f.is_file() and ".part." not in f.name:  # skip unfinished bakes
                rel = f.relative_to(BAKED).as_posix()
                out.append((f, rel, f.stat().st_size))

    # Tree 2: sources/india-geodata/ — read catalog.json to get URL→file mapping.
    catalog_path = ROOT / "catalog.json"
    if catalog_path.exists():
        catalog = json.loads(catalog_path.read_text())
        sources_dir = ROOT / "sources" / "india-geodata"
        r2_prefix = _R2_BASE + "/"
        seen: set[str] = set()
        for layer in catalog.get("layers", []) or []:
            for fmt in ("parquet", "pmtiles", "geojson"):
                fmt_obj = layer.get(fmt)
                if not fmt_obj or not fmt_obj.get("url"):
                    continue
                url = fmt_obj["url"]
                if not url.startswith(r2_prefix):
                    continue
                key = url[len(r2_prefix):]
                if key in seen:
                    continue
                seen.add(key)
                # Source filename is the key's basename (sources/ is flat).
                local = sources_dir / Path(key).name
                if local.exists():
                    out.append((local, key, local.stat().st_size))
    return out


def pairs_from_lines(lines) -> list[tuple[Path, str, int]]:
    """(path, key, size) from "<local path><TAB><key>" lines; blank lines skipped."""
    out = []
    for line in lines:
        line = line.rstrip("\n")
        if line:
            local, key = line.split("\t", 1)
            out.append((Path(local), key, Path(local).stat().st_size))
    return out


def main(argv: list[str]) -> int:
    if not all(os.environ.get(k) for k in ("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_ACCOUNT_ID")):
        print("ERROR: need R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID in env")
        return 2

    locals_ = pairs_from_lines(sys.stdin) if "--pairs" in argv else collect_local_files()
    if not locals_:
        print("nothing to upload")
        return 0

    s3 = r2_client()
    failed: list[tuple[str, str]] = []
    for i, (path, key, size) in enumerate(locals_, 1):
        print(f"[{i}/{len(locals_)}] {key} ({size:,} bytes)", flush=True)
        try:
            r2_upload(s3, path, key)
        except Exception as e:  # noqa: BLE001  (report every failure, keep going)
            failed.append((key, str(e)))
            print(f"  FAIL {key}: {e}", flush=True)

    print()
    print(f"=== upload summary: files={len(locals_)} failed={len(failed)} ===")
    for k, e in failed:
        print(f"  - {k}: {e}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
