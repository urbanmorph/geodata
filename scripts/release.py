#!/usr/bin/env python3
"""
Cut a bharatlas release: a dataset's files under a code that never changes or gets reused,
`bharatlas-<dataset>-<year>.<month>` (e.g. bharatlas-cw-2026.11), dated by the day it is cut.

Numbering follows the schemes register (schemes-register-2026.11): <n> is the two-digit month, so a code says
when it was cut, sorts in order, and allows one release of a dataset per month. A second cut in the same month
with different bytes is refused; the correction goes in the next month's release.

Where a release lives:
  web/public/releases/<code>/manifest.json, CHANGES.md, SHA256SUMS   committed; served by Pages
  data/baked/releases/<code>/<files>                                 staged for R2 (key releases/<code>/<file>)
  https://bharatlas.com/releases/<code>/<file>                        the address, redirected to R2
  web/public/releases/index.json                                     every release, newest first

The release SHA-256 is the SHA-256 of its SHA256SUMS file (one "<sha256>  <file>" line per file, sorted), so
`sha256sum -c SHA256SUMS` checks the files and `sha256sum SHA256SUMS` gives the release digest; it is written
with the code as the pin, `<code>+sha256:<hex>`.

Idempotent: the same files under an existing code change nothing (a lost staged copy is restored). Different
files under an existing code are refused (exit 1). No Zenodo and no DOI (deferred): the code, the checksum and
bharatlas.com are the citation; the manifest names the w3id.org address the code will resolve through once it is
registered. Nothing is uploaded: the R2 commands are printed for the owner.

Usage:
    python3 scripts/release.py data/release-staging/cw [--date 2026-11-15]
    python3 scripts/release.py --index-only
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
META_ROOT = ROOT / 'web' / 'public' / 'releases'
FILES_ROOT = ROOT / 'data' / 'baked' / 'releases'
SITE = 'https://bharatlas.com'
W3ID = 'https://w3id.org/bharatlas/'           # proposed; not registered yet
APP = 'bharatlas'
BUCKET = 'geodata-data'
META_FILE = 'release-meta.json'
CONTENT_TYPES = {'.csv': 'text/csv; charset=utf-8', '.json': 'application/json',
                 '.parquet': 'application/vnd.apache.parquet', '.md': 'text/markdown; charset=utf-8'}
_CODE = re.compile(r'^bharatlas-([a-z0-9_]+)-(\d{4})\.(\d{2})$')


class ReleaseChanged(Exception):
    """A release's files differ from what was cut under that code."""


def release_code(dataset: str, day: str) -> str:
    if not re.fullmatch(r'[a-z0-9_]+', dataset):
        raise ValueError(f'dataset must be lower-case letters, digits or _: {dataset!r}')
    year, month = day.split('-')[:2]
    return f'{APP}-{dataset}-{int(year):04d}.{int(month):02d}'


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text(encoding='utf-8') == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8', newline='')
    return True


def _codes(meta_root: Path, dataset: str | None = None) -> list[str]:
    if not meta_root.is_dir():
        return []
    out = [d.name for d in meta_root.iterdir() if _CODE.match(d.name) and (d / 'manifest.json').is_file()]
    if dataset:
        out = [c for c in out if _CODE.match(c).group(1) == dataset]
    return sorted(out, key=lambda c: (_CODE.match(c).group(2, 3), c), reverse=True)


def _manifest(meta_root: Path, code: str) -> dict:
    return json.loads((meta_root / code / 'manifest.json').read_text(encoding='utf-8'))


def _citation(meta: dict, code: str, digest: str) -> str:
    sources = '; '.join(s['name'] for s in meta['sources'])
    return (f'{sources}. {meta["title"]}, as released by bharatlas: {code} '
            f'(sha256:{digest}). {SITE}/releases/{code}/')


def _changes(code: str, meta: dict, files: list[dict], previous: str | None, prev_manifest: dict | None,
             digest: str, day: str) -> str:
    lines = [f'# {code}', '', f'{meta["title"]}, cut on {day}.', '']
    if not previous:
        lines += ['The first release under a release code.', '']
        lines += [f'- {f["name"]}: {f["rows"]:,} rows' if f.get('rows') is not None else f'- {f["name"]}'
                  for f in files]
    else:
        before = {f['name']: f for f in prev_manifest.get('files', [])}
        now = {f['name']: f for f in files}
        lines.append(f'Changes since {previous}:')
        lines.append('')
        diffs = []
        for name in sorted(set(before) | set(now)):
            a, b = before.get(name), now.get(name)
            if not a:
                diffs.append(f'- {name}: added ({b.get("rows")} rows)')
            elif not b:
                diffs.append(f'- {name}: removed')
            elif a['sha256'] != b['sha256']:
                diffs.append(f'- {name}: {a.get("rows")} rows to {b.get("rows")}' if a.get('rows') != b.get('rows')
                             else f'- {name}: changed, same row count ({b.get("rows")})')
        lines += diffs or ['- no file changed']
    lines += ['', f'Release SHA-256 (of SHA256SUMS): `{digest}`', '',
              f'Pin: `{code}+sha256:{digest}`', '']
    return '\n'.join(lines)


def make_release(src: Path, day: str, meta_root: Path = META_ROOT, files_root: Path = FILES_ROOT) -> tuple[str, bool]:
    """Cut the release of the staging folder `src`. Returns (code, made); made is False when that code already
    holds these exact files. Raises ReleaseChanged when it holds others."""
    src = Path(src)
    meta = json.loads((src / META_FILE).read_text(encoding='utf-8'))
    code = release_code(meta['dataset'], day)
    names = sorted(p.name for p in src.iterdir() if p.is_file() and p.name != META_FILE)
    blobs = {n: (src / n).read_bytes() for n in names}
    sums = ''.join(f'{_sha(blobs[n])}  {n}\n' for n in names)
    digest = _sha(sums.encode('utf-8'))
    meta_dir, files_dir = meta_root / code, files_root / code

    if (meta_dir / 'manifest.json').is_file():
        held = _manifest(meta_root, code)['sha256']
        if held != digest:
            raise ReleaseChanged(
                f'{code} is already released with SHA-256 {held}, and these files are {digest}. A release '
                'never changes: if the data needs correcting, cut it in the next month\'s release.')
        for n in names:                      # restore a lost staged copy (same bytes, so the same release)
            if not (files_dir / n).exists():
                files_dir.mkdir(parents=True, exist_ok=True)
                (files_dir / n).write_bytes(blobs[n])
        return code, False

    earlier = [c for c in _codes(meta_root, meta['dataset']) if c < code]
    previous = earlier[0] if earlier else None
    dataset, version = meta['dataset'], code.rsplit('-', 1)[1]
    files = []
    for n in names:
        info = meta.get('files', {}).get(n, {})
        files.append({'name': n, 'sha256': _sha(blobs[n]), 'bytes': len(blobs[n]), 'rows': info.get('rows'),
                      'licence': info.get('licence'), 'source_layer': info.get('source_layer'),
                      'url': f'{SITE}/releases/{code}/{n}'})
        files[-1] = {k: v for k, v in files[-1].items() if v is not None or k == 'rows'}
    manifest = {
        'code': code,
        'dataset': dataset,
        'title': meta['title'],
        'description': meta.get('description'),
        'released': day,
        'sha256': digest,
        'sha256_of': 'SHA256SUMS',
        'pin': f'{code}+sha256:{digest}',
        'files': files,
        'licence': meta['licence'],
        'attribution': {'sources': meta['sources'],
                        'compiled_by': 'bharatlas (https://bharatlas.com; https://github.com/urbanmorph/geodata)'},
        'citation': _citation(meta, code, digest),
        'url': f'{SITE}/releases/{code}/',
        'w3id_proposed': f'{W3ID}{dataset}/{version}',
        'previous': previous,
    }
    if meta.get('method'):
        manifest['method'] = meta['method']
    prev_manifest = _manifest(meta_root, previous) if previous else None

    files_dir.mkdir(parents=True, exist_ok=True)
    for n in names:
        (files_dir / n).write_bytes(blobs[n])
    _write_if_changed(meta_dir / 'SHA256SUMS', sums)
    _write_if_changed(meta_dir / 'CHANGES.md', _changes(code, meta, files, previous, prev_manifest, digest, day))
    _write_if_changed(meta_dir / 'manifest.json', json.dumps(manifest, indent=1, ensure_ascii=False) + '\n')
    return code, True


def write_index(meta_root: Path = META_ROOT) -> bool:
    """web/public/releases/index.json: every release, newest first, and the latest code per dataset."""
    listing, latest = [], {}
    for code in _codes(meta_root):
        m = _manifest(meta_root, code)
        latest.setdefault(m['dataset'], code)
        listing.append({
            'code': code, 'dataset': m['dataset'], 'title': m['title'], 'released': m['released'],
            'sha256': m['sha256'], 'pin': m['pin'], 'url': m['url'], 'w3id_proposed': m['w3id_proposed'],
            'manifest': f'{SITE}/releases/{code}/manifest.json', 'previous': m.get('previous'),
            'files': [{k: f.get(k) for k in ('name', 'url', 'sha256', 'bytes', 'rows', 'licence')}
                      for f in m['files']],
        })
    doc = {'note': 'bharatlas releases: each code is immutable and pinned by its SHA-256. '
                   'Data from others keeps its source\'s licence; credit the source first.',
           'latest': dict(sorted(latest.items())), 'releases': listing}
    return _write_if_changed(meta_root / 'index.json', json.dumps(doc, indent=1, ensure_ascii=False) + '\n')


def upload_commands(code: str, files_root: Path = FILES_ROOT) -> list[str]:
    out = []
    for p in sorted((files_root / code).iterdir()):
        ct = CONTENT_TYPES.get(p.suffix, 'application/octet-stream')
        out.append(f'npx wrangler r2 object put {BUCKET}/releases/{code}/{p.name} '
                   f'--file data/baked/releases/{code}/{p.name} --content-type "{ct}" --remote')
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('staging', nargs='*', help='staging folders, each with a release-meta.json')
    ap.add_argument('--date', default=datetime.now(timezone.utc).date().isoformat())
    ap.add_argument('--index-only', action='store_true')
    args = ap.parse_args(argv)
    status = 0
    if not args.index_only:
        for src in args.staging:
            try:
                code, made = make_release(Path(src), args.date)
            except ReleaseChanged as e:
                print(f'release refused: {e}', file=sys.stderr, flush=True)
                status = 1
                continue
            m = _manifest(META_ROOT, code)
            print(f'{code}: {"released" if made else "already released, unchanged"}  {m["pin"]}', flush=True)
            if made:
                print('  upload to R2 (owner):', flush=True)
                for c in upload_commands(code):
                    print(f'    {c}', flush=True)
    print(f'index: {"written" if write_index() else "unchanged"}', flush=True)
    return status


if __name__ == '__main__':
    sys.exit(main())
