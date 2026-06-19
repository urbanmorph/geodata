"""Re-bake an existing R2-hosted catalog layer to be /api/v1/nearby-optimised.

Reads the layer's parquet URL from catalog.json, downloads it from R2,
runs rebake_flatten_bbox (which flattens any bbox STRUCT into top-level
cols, synthesises bbox cols from geometry when neither is present,
Hilbert-sorts rows, uses density-aware ROW_GROUP_SIZE and ZSTD level 9),
uploads back to the same R2 key, and patches the catalog's parquet.bytes.

Use this for layers that pre-date the nearby rewrite — bp_wetlands,
lgd_villages, lgd_panchayats, etc. New ingests from ramSeraph already
get this treatment through ingest_ramseraph.py.

Usage:
    python3 scripts/rebake_layer.py bp_wetlands
    python3 scripts/rebake_layer.py lgd_villages lgd_panchayats
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

# Reuse the rebake logic and R2 helpers verbatim; the only thing this
# script adds is "find a layer by id in catalog.json" + URL key parsing.
from ingest_ramseraph import (  # noqa: E402
    BUCKET, R2_PUBLIC, rebake_flatten_bbox, r2_client, r2_upload,
)

CATALOG = ROOT / 'catalog.json'
WORK = Path('/tmp/rebake_layer')


def find_layer(catalog: dict, layer_id: str) -> dict:
    for l in catalog.get('layers', []):
        if l.get('id') == layer_id:
            return l
    raise KeyError(f'layer {layer_id!r} not found in catalog')


def r2_key_from_url(url: str) -> str:
    """Strip the R2 public host prefix; what's left is the bucket-relative key."""
    prefix = R2_PUBLIC + '/'
    if not url.startswith(prefix):
        raise ValueError(f'not an R2 public URL: {url}')
    return url[len(prefix):]


def patch_catalog_bytes(catalog_path: Path, layer_id: str, new_bytes: int) -> None:
    cat = json.loads(catalog_path.read_text())
    layer = find_layer(cat, layer_id)
    layer.setdefault('parquet', {})['bytes'] = new_bytes
    # Match build_catalog.py's encoding exactly (ensure_ascii default + trailing
    # newline) so a one-field patch stays a one-line diff instead of re-encoding
    # every \uXXXX escape in the file.
    catalog_path.write_text(json.dumps(cat, indent=2) + '\n')


def rebake(layer_id: str, s3) -> None:
    catalog = json.loads(CATALOG.read_text())
    layer = find_layer(catalog, layer_id)
    parquet_url = layer.get('parquet', {}).get('url')
    if not parquet_url:
        raise RuntimeError(f'layer {layer_id} has no parquet URL')

    r2_key = r2_key_from_url(parquet_url)
    WORK.mkdir(parents=True, exist_ok=True)
    src = WORK / f'_raw_{layer_id}.parquet'
    dst = WORK / f'{layer_id}.parquet'

    print(f'→ {layer_id}')
    if src.exists() and src.stat().st_size > 0:
        print(f'  cached: {src}')
    else:
        # Public R2 URL blocks urllib (UA check). Use the authenticated
        # S3 client we already have for upload — same R2 endpoint, no UA games.
        print(f'  fetching s3://{BUCKET}/{r2_key}')
        s3.download_file(BUCKET, r2_key, str(src))
        print(f'  fetched: {src.stat().st_size:,} bytes')

    features, cols = rebake_flatten_bbox(src, dst)
    new_bytes = dst.stat().st_size
    print(f'  features: {features:,}; cols: {cols}; baked: {new_bytes:,} bytes')

    r2_upload(s3, dst, r2_key)
    patch_catalog_bytes(CATALOG, layer_id, new_bytes)
    print(f'✓ {layer_id}: rebake done, catalog patched (bytes {new_bytes:,})')


def main(argv: list[str]) -> int:
    for key in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'):
        if key not in os.environ:
            print(f'ERROR: {key} not set in env')
            return 2
    if len(argv) < 2:
        print('Usage: rebake_layer.py <layer_id> [<layer_id>...]')
        return 2

    s3 = r2_client()
    for layer_id in argv[1:]:
        try:
            rebake(layer_id, s3)
        except Exception as e:
            print(f'ERROR rebake {layer_id}: {e}')
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
