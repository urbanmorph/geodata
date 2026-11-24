#!/usr/bin/env python3
"""
Prune old map tiles from R2, and nothing else (spec-data-lifecycle rules 4 and 5).

    keep forever   parquet, downloads (GeoJSON, KML, Shapefile, zips), release files, anything not a .pmtiles
    keep           the current tiles (every R2 URL in catalog.json, and in the served /catalog.json) and, for each,
                   the previous version: the newest older sibling with the same name (<stem>.pmtiles,
                   <stem>.<md5[:8]>.pmtiles or <stem>.z<N>.pmtiles in the same folder)
    keep           anything a release manifest names (web/public/releases/*/manifest.json, by URL or key), and any
                   tile younger than --min-age-days (a branch's tiles before it merges, a deploy's edge caches)
    propose        every other .pmtiles in the folders the catalog's files live in

A dry run is the default: it lists what it would delete with sizes, writes that list to a file and deletes
nothing. `--delete <list file>` deletes only keys that are on that list AND still proposed when it runs: current,
previous and pinned keys are computed again from the catalog, the manifests and a fresh listing, and a listed key
that no longer qualifies is refused. Listing is read-only; set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and
R2_SECRET_ACCESS_KEY.

Usage:
    python3 scripts/r2_prune.py                                   # dry run: data/r2-prune-<date>.txt
    python3 scripts/r2_prune.py --delete data/r2-prune-<date>.txt # delete what that dry run listed, re-checked
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Iterator

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from pipeline import BUCKET, log, public_r2_key  # noqa: E402
from tile_keys import unversioned_name  # noqa: E402

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
LIVE_CATALOG = 'https://bharatlas.com/catalog.json'
RELEASES_ROOT = ROOT / 'web' / 'public' / 'releases'
SITE_RELEASES = 'https://bharatlas.com/releases/'
NEVER_PREFIXES = ('releases/', 'cache/')
MIN_AGE_DAYS = 30
TILE = '.pmtiles'
_KEY_EXTS = ('.pmtiles', '.parquet', '.geojson', '.kml', '.zip', '.csv', '.json')


# ── what is current and what is pinned ─────────────────────────────────────

def _strings(obj) -> Iterator[str]:
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _strings(v)


def r2_key(url: str) -> str | None:
    """The R2 key behind a public R2 URL or a bharatlas release URL; None for anything else."""
    url = url.split('?', 1)[0].split('#', 1)[0]
    key = public_r2_key(url)  # the data domain or the old r2.dev address
    if key is not None:
        return key
    if url.startswith(SITE_RELEASES) and url != SITE_RELEASES:
        return 'releases/' + url[len(SITE_RELEASES):]
    return None


def _bare_key(s: str) -> str | None:
    """A string that is itself a key ('admin/states/LGD_States.parquet'), not a URL or a sentence."""
    if '://' in s or ' ' in s or '/' not in s or s.startswith('/'):
        return None
    return s if s.endswith(_KEY_EXTS) else None


def current_keys(*catalogs: dict) -> set[str]:
    """Every R2 key any of these catalogs links to."""
    return {k for c in catalogs for s in _strings(c) if (k := r2_key(s))}


def pinned_keys(manifests: Iterable[dict]) -> set[str]:
    """Every key a release manifest names, by URL or as a bare key."""
    return {k for m in manifests for s in _strings(m) if (k := r2_key(s) or _bare_key(s))}


def load_manifests(root: Path = RELEASES_ROOT) -> list[dict]:
    return [json.loads(p.read_text(encoding='utf-8')) for p in sorted(root.glob('*/manifest.json'))]


def layer_prefixes(current: set[str]) -> list[str]:
    """The folders the catalog's files live in, without release files and caches."""
    out = {k.rsplit('/', 1)[0] + '/' for k in current if '/' in k}
    return sorted(p for p in out if not p.startswith(NEVER_PREFIXES))


# ── the plan ────────────────────────────────────────────────────────────────

@dataclass
class Plan:
    delete: list[dict] = field(default_factory=list)
    keep: list[tuple[dict, str]] = field(default_factory=list)

    @property
    def bytes(self) -> int:
        return sum(o['size'] for o in self.delete)


def _family(key: str) -> tuple[str, str]:
    folder, _, name = key.rpartition('/')
    return folder, unversioned_name(name)


def _previous(members: list[dict], current: set[str]) -> tuple[set[str], bool]:
    """(the previous version of each current tile in one family, whether every current tile was listed)."""
    listed = {o['key']: o for o in members}
    cur = [listed[k] for k in current if k in listed]
    complete = all(k in listed for k in current)
    prev = set()
    for c in cur:
        older = [o for o in members if o['key'] not in current and o['last_modified'] < c['last_modified']]
        if older:
            prev.add(max(older, key=lambda o: (o['last_modified'], o['key']))['key'])
    return prev, complete


def plan(objects: Iterable[dict], current: set[str], pinned: set[str], now: datetime,
         min_age_days: float = MIN_AGE_DAYS) -> Plan:
    """Which listed objects to delete: tiles neither current, previous, pinned nor young. Nothing else."""
    tiles = [o for o in objects if o['key'].endswith(TILE) and not o['key'].startswith(NEVER_PREFIXES)]
    families: dict[tuple[str, str], list[dict]] = {}
    for o in tiles:
        families.setdefault(_family(o['key']), []).append(o)
    current_by_family: dict[tuple[str, str], set[str]] = {}
    for k in current:
        if k.endswith(TILE):
            current_by_family.setdefault(_family(k), set()).add(k)

    cutoff = now - timedelta(days=min_age_days)
    out = Plan()
    for fam, members in sorted(families.items()):
        cur = current_by_family.get(fam, set())
        prev, complete = _previous(members, cur)
        for o in sorted(members, key=lambda o: o['key']):
            k = o['key']
            why = ('current' if k in cur else 'pinned by a release' if k in pinned
                   else 'previous version' if k in prev
                   else 'its current tile is not in the listing' if not complete
                   else f'younger than {min_age_days:g} days' if o['last_modified'] > cutoff else None)
            if why:
                out.keep.append((o, why))
            else:
                out.delete.append(o)
    return out


# ── R2 ──────────────────────────────────────────────────────────────────────

class R2Store:
    """Read-only listing, and batch delete, over boto3."""

    def __init__(self, s3=None):
        from pipeline import r2_client
        self.s3 = s3 or r2_client()

    def list_objects(self, prefix: str) -> list[dict]:
        out = []
        for page in self.s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=prefix, Delimiter='/'):
            out += [{'key': o['Key'], 'size': o['Size'], 'last_modified': o['LastModified']}
                    for o in page.get('Contents', [])]
        return out

    def delete_keys(self, keys: list[str]) -> None:
        for i in range(0, len(keys), 1000):
            batch = keys[i:i + 1000]
            r = self.s3.delete_objects(Bucket=BUCKET, Delete={'Objects': [{'Key': k} for k in batch], 'Quiet': True})
            if r.get('Errors'):
                raise RuntimeError(f'R2 refused {len(r["Errors"])} deletes: {r["Errors"][:3]}')


def list_all(store, current: set[str]) -> list[dict]:
    prefixes = layer_prefixes(current)
    seen: dict[str, dict] = {}
    for i, prefix in enumerate(prefixes, 1):
        for o in store.list_objects(prefix):
            seen[o['key']] = o
        if i % 20 == 0 or i == len(prefixes):
            log(f'  listed {i}/{len(prefixes)} folders, {len(seen):,} objects')
    return list(seen.values())


def _mb(n: int) -> str:
    return f'{n / 1e6:,.1f} MB'


def dry_run(store, current: set[str], pinned: set[str], now: datetime, min_age_days: float, out: Path) -> Plan:
    p = plan(list_all(store, current), current, pinned, now, min_age_days)
    reasons: dict[str, int] = {}
    for _, why in p.keep:
        reasons[why] = reasons.get(why, 0) + 1
    log(f'keep {len(p.keep)} tiles: ' + ', '.join(f'{n} {why}' for why, n in sorted(reasons.items())))
    for o in p.delete:
        log(f'  would delete {o["key"]}  {_mb(o["size"])}')
    log(f'would delete {len(p.delete)} tiles, {_mb(p.bytes)}; list written to {out}')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(f'# r2_prune dry run {now.isoformat()}: {len(p.delete)} tiles, {p.bytes} bytes\n'
                   + ''.join(f'{o["key"]}\t{o["size"]}\n' for o in p.delete))
    return p


def read_list(path: Path) -> list[str]:
    return [ln.split('\t')[0].strip() for ln in path.read_text().splitlines() if ln.strip() and not ln.startswith('#')]


def delete_listed(store, current: set[str], pinned: set[str], now: datetime, min_age_days: float,
                  list_path: Path) -> tuple[list[str], list[str]]:
    """Delete the listed keys that a fresh plan still proposes; (deleted, refused)."""
    fresh = {o['key'] for o in plan(list_all(store, current), current, pinned, now, min_age_days).delete}
    listed = read_list(list_path)
    deleted = [k for k in listed if k in fresh]
    refused = [k for k in listed if k not in fresh]
    for k in refused:
        log(f'  refused {k}: not a tile proposed for pruning now (current, previous, pinned, young or not a tile)')
    if deleted:
        store.delete_keys(deleted)
    log(f'deleted {len(deleted)}, refused {len(refused)}')
    return deleted, refused


def fetch_live_catalog(url: str) -> dict:
    req = urllib.request.Request(url, headers={'User-Agent': 'bharatlas-r2-prune/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--catalog', default=str(CATALOG))
    ap.add_argument('--live-catalog', default=LIVE_CATALOG, help='also keep what the served catalog links to '
                                                                 '("" to skip)')
    ap.add_argument('--min-age-days', type=float, default=MIN_AGE_DAYS)
    ap.add_argument('--out', help='where the dry run writes its list (default data/r2-prune-<date>.txt)')
    ap.add_argument('--delete', nargs='?', const='', metavar='LIST',
                    help='delete the keys a dry run listed in LIST, re-checked now')
    args = ap.parse_args(argv)
    if args.delete == '':
        ap.error('--delete needs the list file a dry run wrote')

    now = datetime.now(timezone.utc)
    catalogs = [json.loads(Path(args.catalog).read_text())]
    if args.live_catalog:
        catalogs.append(fetch_live_catalog(args.live_catalog))
    current = current_keys(*catalogs)
    manifests = load_manifests()
    pinned = pinned_keys(manifests)
    log(f'{len(current)} current keys; {len(pinned)} keys pinned by {len(manifests)} release manifests')
    store = R2Store()
    if args.delete:
        delete_listed(store, current, pinned, now, args.min_age_days, Path(args.delete))
        return 0
    out = Path(args.out or ROOT / 'data' / f'r2-prune-{now.date().isoformat()}.txt')
    dry_run(store, current, pinned, now, args.min_age_days, out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
