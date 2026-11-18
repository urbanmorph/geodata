"""
One-time backfill: set `Content-Disposition: attachment; filename="..."` on
every object under prefixes that we want browsers to download (not preview).

Cross-origin links to pub-*.r2.dev ignore the HTML `download` attribute and
rely on this header — without it, Chrome shows .geojson as text in a tab.

Requires R2 S3-compatible keys in env (same as upload_r2_multipart.py):
  CLOUDFLARE_ACCOUNT_ID
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
"""
import os
import sys
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config

ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
ACCESS_KEY = os.environ.get('R2_ACCESS_KEY_ID')
SECRET_KEY = os.environ.get('R2_SECRET_ACCESS_KEY')
BUCKET = 'geodata-data'
PREFIXES = ['extracts/', 'admin/', 'boundaries/', 'geoboundaries/']

if not (ACCOUNT_ID and ACCESS_KEY and SECRET_KEY):
    sys.exit('need CLOUDFLARE_ACCOUNT_ID + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY in env')

s3 = boto3.client(
    's3',
    endpoint_url=f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=ACCESS_KEY,
    aws_secret_access_key=SECRET_KEY,
    region_name='auto',
    config=Config(signature_version='s3v4', s3={'addressing_style': 'path'}),
)


CONTENT_TYPES = {
    '.parquet': 'application/vnd.apache.parquet',
    '.geojson': 'application/geo+json',
    '.kml': 'application/vnd.google-earth.kml+xml',
    '.kmz': 'application/vnd.google-earth.kmz',
    '.pmtiles': 'application/vnd.pmtiles',
    '.json': 'application/json',
}


def content_type_for(key: str) -> str:
    for ext, ct in CONTENT_TYPES.items():
        if key.endswith(ext):
            return ct
    return 'application/octet-stream'


def fix(key: str) -> tuple[str, str]:
    fname = key.rsplit('/', 1)[-1]
    try:
        s3.copy_object(
            Bucket=BUCKET,
            CopySource={'Bucket': BUCKET, 'Key': key},
            Key=key,
            MetadataDirective='REPLACE',
            ContentDisposition=f'attachment; filename="{fname}"',
            ContentType=content_type_for(key),
        )
        return key, 'ok'
    except Exception as e:
        return key, f'fail: {e}'


def iter_keys():
    paginator = s3.get_paginator('list_objects_v2')
    for prefix in PREFIXES:
        for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
            for obj in page.get('Contents', []) or []:
                # Skip PMTiles — they're loaded via range requests by MapLibre,
                # forcing attachment would break the in-page renderer.
                if obj['Key'].endswith('.pmtiles'):
                    continue
                yield obj['Key']


def main() -> None:
    keys = list(iter_keys())
    print(f'updating {len(keys)} objects...')
    ok = fail = 0
    with ThreadPoolExecutor(max_workers=12) as pool:
        for i, (key, status) in enumerate(pool.map(fix, keys), 1):
            if status == 'ok':
                ok += 1
            else:
                fail += 1
                print(f'  ! {key} → {status}')
            if i % 25 == 0:
                print(f'  {i}/{len(keys)} ({ok} ok, {fail} fail)')
    print(f'\n✓ done: {ok} updated, {fail} failed')


if __name__ == '__main__':
    main()
