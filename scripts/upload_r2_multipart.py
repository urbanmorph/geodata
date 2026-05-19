"""
Multipart upload of files >300 MiB to Cloudflare R2 via the S3-compatible endpoint.
Wrangler caps single PUTs at 300 MiB; this script handles the few that exceed it.

Requirements:
  pip install boto3
  Set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY in env (create at:
    Cloudflare dashboard → R2 → Manage R2 API Tokens → Create API Token
    Permissions: Object Read & Write, Bucket: geodata-data)

Idempotent: skips objects already on R2 at matching size.
"""
import os
import sys
from pathlib import Path

import boto3
from botocore.config import Config

ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
BUCKET = 'geodata-data'

ACCESS_KEY = os.environ.get('R2_ACCESS_KEY_ID')
SECRET_KEY = os.environ.get('R2_SECRET_ACCESS_KEY')

if not (ACCOUNT_ID and ACCESS_KEY and SECRET_KEY):
    sys.exit('need CLOUDFLARE_ACCOUNT_ID + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY in env')

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'sources' / 'india-geodata'

# Files that exceed wrangler's 300 MiB single-PUT cap
LARGE = [
    ('admin/villages/LGD_Villages.parquet', SRC / 'LGD_Villages.parquet'),
]

s3 = boto3.client(
    's3',
    endpoint_url=f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=ACCESS_KEY,
    aws_secret_access_key=SECRET_KEY,
    region_name='auto',
    config=Config(signature_version='s3v4', s3={'addressing_style': 'path'}),
)

CHUNK = 100 * 1024 * 1024  # 100 MiB parts


def upload(key: str, path: Path) -> None:
    if not path.exists():
        print(f'  miss {path} — skip')
        return
    local_size = path.stat().st_size

    try:
        head = s3.head_object(Bucket=BUCKET, Key=key)
        if head['ContentLength'] == local_size:
            print(f'  skip {key} ({local_size} bytes, on R2)')
            return
    except s3.exceptions.ClientError as e:
        if e.response['Error']['Code'] not in ('404', 'NoSuchKey'):
            raise

    print(f'  put  {key} ({local_size} bytes) — multipart')
    mp = s3.create_multipart_upload(Bucket=BUCKET, Key=key)
    upload_id = mp['UploadId']
    parts = []
    try:
        with path.open('rb') as f:
            part_num = 1
            while True:
                data = f.read(CHUNK)
                if not data:
                    break
                resp = s3.upload_part(
                    Bucket=BUCKET, Key=key, PartNumber=part_num,
                    UploadId=upload_id, Body=data,
                )
                parts.append({'PartNumber': part_num, 'ETag': resp['ETag']})
                print(f'    part {part_num} ({len(data)} bytes) → {resp["ETag"]}')
                part_num += 1
        s3.complete_multipart_upload(
            Bucket=BUCKET, Key=key, UploadId=upload_id,
            MultipartUpload={'Parts': parts},
        )
        print(f'  ✓ {key}')
    except Exception:
        s3.abort_multipart_upload(Bucket=BUCKET, Key=key, UploadId=upload_id)
        raise


def main() -> None:
    for key, path in LARGE:
        upload(key, path)
    print('done')


if __name__ == '__main__':
    main()
