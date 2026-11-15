"""
Build the dated catalogue record: for every layer bharatlas serves today, its source (credited first), the source's
own version, the fetch date, the SHA-256 of the file we serve, the licence and the source link.

It is the input to the `bharatlas-catalog-<year>.<n>` release (scripts/release.py). Each layer's checksum is taken
from the bytes R2 serves (the parquet, or the GeoJSON for a layer without one), not from catalog.json, so the
record proves what was served. Where the upstream is a GitHub release, the asset's own SHA-256 digest is recorded as
the source version and compared with ours (`served_bytes_match_source_digest`).

Caching, restart and idempotency: every checksum is appended to data/cache/served-sha256.jsonl the moment it is
computed (with the file's ETag and size), so a stopped run continues where it stopped and a re-run downloads only
files whose ETag or size changed on R2. GitHub release answers are cached in data/cache/github-releases/. The
output files are rewritten only when their content changes. --max-minutes stops the run cleanly before a host's
job limit; what was done is kept. Nothing is uploaded anywhere.

Usage:
    python3 scripts/catalog_record.py                      # the live catalogue at bharatlas.com
    python3 scripts/catalog_record.py --catalog catalog.json --as-of 2026-11-15 --max-minutes 50
Output: data/release-staging/catalog/{catalog-record.json, catalog-record.csv, release-meta.json}
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data' / 'cache'
OUT = ROOT / 'data' / 'release-staging' / 'catalog'
LIVE_CATALOG = 'https://bharatlas.com/catalog.json'
USER_AGENT = 'bharatlas-catalog-record/1.0 (+https://bharatlas.com)'
FORMATS = ('parquet', 'geojson', 'pmtiles', 'kml', 'shapefile')   # the first a layer has is checksummed
CHUNK = 1 << 20
WORKERS = 4

_GH_RELEASE = re.compile(r'^https://github\.com/([^/]+/[^/]+)/releases/download/(.+)/([^/]+)$')
_GH_COMMIT = re.compile(r'^https://github\.com/[^/]+/[^/]+/(?:raw|blob)/([0-9a-f]{7,40})/')

COLUMNS = ['id', 'source', 'source_url', 'publisher', 'publisher_url', 'source_link', 'source_version',
           'source_version_date', 'source_sha256', 'fetched_at', 'licence', 'rows', 'served_format', 'served_url',
           'bytes', 'sha256', 'served_etag', 'served_last_modified', 'served_bytes_match_source_digest']


def log(*a) -> None:
    print(*a, flush=True)


def github_asset(url: str | None) -> tuple[str, str, str] | None:
    """(owner/repo, tag, asset) for a GitHub release download link. A tag may itself contain slashes
    (india-geodata tags releases 'admin/districts'), so the asset is the last segment and the tag the rest."""
    m = _GH_RELEASE.match(url or '')
    return (m.group(1), m.group(2), m.group(3)) if m else None


def pinned_commit(url: str | None) -> str | None:
    m = _GH_COMMIT.match(url or '')
    return m.group(1) if m else None


def served_file(layer: dict) -> tuple[str | None, str | None]:
    for fmt in FORMATS:
        if (layer.get(fmt) or {}).get('url'):
            return fmt, layer[fmt]['url']
    return None, None


def upstream_url(layer: dict) -> str | None:
    fmt, _ = served_file(layer)
    return (layer.get(fmt) or {}).get('upstream_url') if fmt else None


def source_version(layer: dict, release_lookup) -> dict:
    """The source's own version of the file we serve. release_lookup(repo, tag) returns GitHub's release JSON."""
    up = upstream_url(layer)
    gh = github_asset(up)
    if gh:
        repo, tag, name = gh
        release = release_lookup(repo, tag) or {}
        asset = next((a for a in release.get('assets', []) if a.get('name') == name), None)
        if asset:
            digest = asset.get('digest') or ''
            return {'kind': 'github-release', 'repo': repo, 'tag': tag, 'asset': name,
                    'asset_updated_at': asset.get('updated_at'),
                    'asset_sha256': digest.split(':', 1)[1] if digest.startswith('sha256:') else None,
                    'asset_bytes': asset.get('size')}
    commit = pinned_commit(up)
    if commit:
        return {'kind': 'git-commit', 'commit': commit}
    return {'kind': 'unversioned', 'note': 'the source publishes no version; fetched_at dates the copy'}


def _version_label(v: dict) -> str | None:
    if v.get('kind') == 'github-release' and v.get('repo') and v.get('tag'):
        return f"{v['repo']} release {v['tag']}"
    if v.get('kind') == 'git-commit':
        return f"commit {v['commit']}"
    return None


def record_row(layer: dict, served: dict, version: dict) -> dict:
    att = layer.get('attribution') or {}
    primary, publisher = att.get('primary') or {}, att.get('publisher') or {}
    fmt, url = served_file(layer)
    upstream_sha = version.get('asset_sha256')
    return {
        'id': layer['id'],
        'source': primary.get('name') or layer.get('source'),
        'source_url': primary.get('url'),
        'publisher': publisher.get('name'),
        'publisher_url': publisher.get('url'),
        'source_link': upstream_url(layer) or primary.get('url'),
        'source_version': _version_label(version),
        'source_version_date': version.get('asset_updated_at'),
        'source_sha256': upstream_sha,
        'fetched_at': layer.get('fetched_at'),
        'licence': layer.get('licence'),
        'rows': layer.get('rows'),
        'served_format': fmt,
        'served_url': url,
        'bytes': served.get('bytes'),
        'sha256': served.get('sha256'),
        'served_etag': served.get('etag'),
        'served_last_modified': served.get('last_modified'),
        'served_bytes_match_source_digest': (served.get('sha256') == upstream_sha) if upstream_sha else None,
    }


class ChecksumCache:
    """Append-only JSONL of {url, sha256, bytes, etag, last_modified}; the last line for a url wins."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.rows: dict[str, dict] = {}
        if path.exists():
            for line in path.read_text().splitlines():
                if line.strip():
                    r = json.loads(line)
                    self.rows[r['url']] = r

    def get(self, url: str, etag: str | None, size: int | None) -> dict | None:
        r = self.rows.get(url)
        if r and r.get('etag') == etag and r.get('bytes') == size:
            return r
        return None

    def put(self, url: str, entry: dict) -> None:
        row = {'url': url, **entry}
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open('a') as fh:
                fh.write(json.dumps(row, sort_keys=True) + '\n')
                fh.flush()
            self.rows[url] = row


def _request(url: str, method: str = 'GET', headers: dict | None = None):
    req = urllib.request.Request(url, method=method, headers={'User-Agent': USER_AGENT, **(headers or {})})
    return urllib.request.urlopen(req, timeout=120)


def head(url: str) -> tuple[str | None, int | None, str | None]:
    with _request(url, 'HEAD') as r:
        size = r.headers.get('Content-Length')
        return r.headers.get('ETag'), int(size) if size else None, r.headers.get('Last-Modified')


def checksum(url: str, cache: ChecksumCache, tries: int = 3) -> tuple[dict, bool]:
    """(entry, fresh): the served file's SHA-256, from the cache when R2's ETag and size are unchanged."""
    etag, size, modified = head(url)
    hit = cache.get(url, etag, size)
    if hit:
        return hit, False
    for attempt in range(1, tries + 1):
        try:
            h, n = hashlib.sha256(), 0
            with _request(url) as r:
                while chunk := r.read(CHUNK):
                    h.update(chunk)
                    n += len(chunk)
            if size is not None and n != size:
                raise OSError(f'short read: {n} of {size} bytes')
            entry = {'sha256': h.hexdigest(), 'bytes': n, 'etag': etag, 'last_modified': modified}
            cache.put(url, entry)
            return entry, True
        except OSError as e:
            if attempt == tries:
                raise
            log(f'  retry {attempt} {url}: {e}')
            time.sleep(5 * attempt)
    raise AssertionError('unreachable')


def github_release(repo: str, tag: str) -> dict | None:
    """GitHub's release JSON for a tag, cached in data/cache/github-releases/ (one answer per tag; a release that
    does not exist is cached as {}). Any other failure (e.g. the API's rate limit; set GITHUB_TOKEN to lift it)
    raises, so the record is never written with a version silently missing."""
    dest = CACHE / 'github-releases' / (repo.replace('/', '__') + '__' + tag.replace('/', '__') + '.json')
    if dest.exists():
        return json.loads(dest.read_text()) or None
    url = f'https://api.github.com/repos/{repo}/releases/tags/{urllib.parse.quote(tag, safe="")}'
    token = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
    try:
        with _request(url, headers={'Authorization': f'Bearer {token}'} if token else None) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        log(f'  github {repo} {tag}: no such release')
        data = None
    keep = {} if data is None else {
        'tag_name': data.get('tag_name'), 'published_at': data.get('published_at'),
        'assets': [{k: a.get(k) for k in ('name', 'size', 'updated_at', 'digest')} for a in data.get('assets', [])]}
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(keep, indent=1, sort_keys=True) + '\n')
    return keep or None


def _write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text(encoding='utf-8') == text:
        return False
    path.write_text(text, encoding='utf-8', newline='')
    return True


def write_record(out: Path, rows: list[dict], as_of: str) -> bool:
    """Write catalog-record.json and .csv, sorted by layer id; True when either file changed."""
    out.mkdir(parents=True, exist_ok=True)
    rows = sorted(rows, key=lambda r: r['id'])
    doc = {'as_of': as_of,
           'note': 'Each layer as bharatlas served it on this date: the source first, the source\'s own version '
                   'where it publishes one, the date bharatlas fetched it, and the SHA-256 of the served file.',
           'layers': rows}
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=[c for c in COLUMNS if any(c in r for r in rows)] or ['id'],
                       extrasaction='ignore', lineterminator='\n')
    w.writeheader()
    for r in rows:
        w.writerow({k: ('' if v is None else v) for k, v in r.items()})
    a = _write_if_changed(out / 'catalog-record.json', json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
    b = _write_if_changed(out / 'catalog-record.csv', buf.getvalue())
    return a or b


def release_meta(as_of: str, catalog_generated: str | None, rows: int) -> dict:
    """What scripts/release.py needs to cut bharatlas-catalog-<year>.<n> from this folder."""
    return {
        'dataset': 'catalog',
        'title': 'bharatlas catalogue record',
        'as_of': as_of,
        'description': 'Every layer bharatlas served on this date: source, source version, fetch date, '
                       'SHA-256 of the served file, licence and source link.',
        'licence': 'CC0-1.0 (this record is bharatlas\'s own compilation of facts about the layers); '
                   'each layer it describes keeps its source\'s licence, named per row',
        'sources': [{'name': 'The source named first in each row (credit it for that layer)',
                     'version': 'per row (source_version)',
                     'fetched': 'per row (fetched_at)'},
                    {'name': 'bharatlas catalogue', 'url': LIVE_CATALOG, 'version': catalog_generated}],
        'files': {'catalog-record.json': {'licence': 'CC0-1.0', 'rows': rows},
                  'catalog-record.csv': {'licence': 'CC0-1.0', 'rows': rows}},
    }


def load_catalog(src: str) -> dict:
    if src.startswith('https://'):
        with _request(src) as r:
            return json.load(r)
    return json.loads(Path(src).read_text())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--catalog', default=LIVE_CATALOG, help='catalog.json URL or path (default: the live one)')
    ap.add_argument('--as-of', default=datetime.now(timezone.utc).date().isoformat())
    ap.add_argument('--out', default=str(OUT))
    ap.add_argument('--max-minutes', type=float, default=50.0)
    args = ap.parse_args(argv)

    catalog = load_catalog(args.catalog)
    layers = catalog['layers']
    cache = ChecksumCache(CACHE / 'served-sha256.jsonl')
    deadline = time.monotonic() + args.max_minutes * 60
    log(f'{len(layers)} layers from {args.catalog} (generated {catalog.get("generated")})')

    served: dict[str, dict] = {}
    todo = []
    for layer in layers:
        _, url = served_file(layer)
        if not url:
            log(f'  {layer["id"]}: no served file')
            continue
        todo.append((layer['id'], url))

    stopped = False
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {}
        for lid, url in todo:
            if time.monotonic() > deadline:
                stopped = True
                break
            futures[pool.submit(checksum, url, cache)] = (lid, url)
        for i, fut in enumerate(as_completed(futures), 1):
            lid, url = futures[fut]
            try:
                entry, fresh = fut.result()
            except Exception as e:      # one bad file must not lose the rest: it is reported and the run fails
                log(f'[{i}/{len(todo)}] {lid}: FAILED {e}')
                continue
            served[lid] = entry
            log(f'[{i}/{len(todo)}] {lid}: {"hashed" if fresh else "cached"} {entry["bytes"]:,} bytes '
                f'{entry["sha256"][:12]}')
            if time.monotonic() > deadline and not stopped:
                stopped = True
                log('time limit reached: finishing the files in flight, starting no more')
                for f in futures:
                    f.cancel()

    missing = [lid for lid, _ in todo if lid not in served]
    if missing:
        log(f'incomplete: {len(missing)} layers without a checksum ({", ".join(missing[:8])}…); re-run to continue')
        return 2

    rows = [record_row(layer, served[layer['id']], source_version(layer, github_release))
            for layer in layers if layer['id'] in served]
    out = Path(args.out)
    changed = write_record(out, rows, args.as_of)
    _write_if_changed(out / 'release-meta.json',
                      json.dumps(release_meta(args.as_of, catalog.get('generated'), len(rows)), indent=1) + '\n')
    same = sum(1 for r in rows if r['served_bytes_match_source_digest'])
    log(f'{len(rows)} layers recorded ({same} byte-identical to their source\'s published digest); '
        f'{"written" if changed else "unchanged"}: {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
