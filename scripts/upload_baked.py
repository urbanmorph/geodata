"""
Upload data/baked/* to R2 via the S3-compatible API using boto3.
Bypasses wrangler (whose npx install hit an arch mismatch on this machine).

Idempotent: skips objects already on R2 at the same size. Sets Content-Type
+ Content-Disposition: attachment (with sensible filename) so cross-origin
links to pub-*.r2.dev honor the download intent.

Env required:
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY  (S3-compat creds)
  CLOUDFLARE_ACCOUNT_ID                   (endpoint host prefix)

Scope is intentionally narrow: only data/baked/* uploads here. The existing
sources/, geoboundaries/, and data/extracts/ trees are still pushed by
scripts/upload_r2.sh (which uses wrangler).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import boto3
from botocore.config import Config

BUCKET = "geodata-data"
ROOT = Path(__file__).resolve().parent.parent
BAKED = ROOT / "data" / "baked"

CONTENT_TYPES = {
    ".parquet": "application/vnd.apache.parquet",
    ".geojson": "application/geo+json",
    ".kml":     "application/vnd.google-earth.kml+xml",
    ".kmz":     "application/vnd.google-earth.kmz",
    ".pmtiles": "application/vnd.pmtiles",
    ".json":    "application/json",
    ".zip":     "application/zip",
}


def content_type_for(name: str) -> str:
    # .shp.zip → .zip wins via suffix match
    for ext, ct in CONTENT_TYPES.items():
        if name.endswith(ext):
            return ct
    return "application/octet-stream"


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
            if f.is_file():
                rel = f.relative_to(BAKED).as_posix()
                out.append((f, rel, f.stat().st_size))

    # Tree 2: sources/india-geodata/ — read catalog.json to get URL→file mapping.
    catalog_path = ROOT / "catalog.json"
    if catalog_path.exists():
        catalog = json.loads(catalog_path.read_text())
        sources_dir = ROOT / "sources" / "india-geodata"
        r2_prefix = "https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/"
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


def main() -> int:
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not (access_key and secret_key and account_id):
        print("ERROR: need R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID in env")
        return 2

    endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        # R2 multipart works at the boto3 transfer threshold. Bump partsize
        # slightly so a 270 MB geojson uploads in ~3 parts.
        config=Config(signature_version="s3v4"),
    )

    locals_ = collect_local_files()
    if not locals_:
        print("nothing to upload — neither data/baked/ nor sources/india-geodata/ has files")
        return 0

    # List relevant remote prefixes once. data/baked/<prefix>/<file> maps to
    # an r2 key under <prefix>. To minimize listing we pull every unique
    # top-level prefix that appears in the local set.
    remote_size: dict[str, int] = {}
    seen_prefixes: set[str] = set()
    for _, rel, _ in locals_:
        seen_prefixes.add(rel.split("/", 1)[0])
    for prefix in sorted(seen_prefixes):
        token = None
        while True:
            kwargs = {"Bucket": BUCKET, "Prefix": prefix + "/"}
            if token:
                kwargs["ContinuationToken"] = token
            resp = s3.list_objects_v2(**kwargs)
            for obj in resp.get("Contents", []) or []:
                remote_size[obj["Key"]] = obj["Size"]
            token = resp.get("NextContinuationToken")
            if not token:
                break
    print(f"→ {len(remote_size):,} existing objects under {len(seen_prefixes)} prefixes")

    written = 0
    skipped = 0
    failed: list[tuple[str, str]] = []
    for path, key, size in locals_:
        rsize = remote_size.get(key)
        if rsize == size:
            print(f"  skip {key:<60} ({size:,} bytes, on R2)")
            skipped += 1
            continue
        ct = content_type_for(path.name)
        # .pmtiles is the only format that needs Range fetches — others
        # serve as attachment so the `download` HTML attribute works
        # across origin to pub-*.r2.dev.
        extra = {"ContentType": ct}
        if not path.name.endswith(".pmtiles"):
            extra["ContentDisposition"] = f'attachment; filename="{path.name}"'
        try:
            print(f"  put  {key:<60} ({size:,} bytes, {ct})")
            s3.upload_file(str(path), BUCKET, key, ExtraArgs=extra)
            written += 1
        except Exception as e:
            failed.append((key, str(e)))
            print(f"  FAIL {key} — {e}")

    print()
    print(f"=== upload summary: wrote={written} skipped={skipped} failed={len(failed)} ===")
    for k, e in failed:
        print(f"  - {k}: {e}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
